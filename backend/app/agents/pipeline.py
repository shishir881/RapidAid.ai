"""
AgentPipeline — Orchestrates emergency dispatch using LangChain AI Agents.

Pipeline sequence:
  1. SmartTriageAgent (LLaMA 3.3 via Groq → rule-based fallback)
  2. LangChainCoordinator (Tool-calling agent handling hospital, vehicle, and routing)

Transaction boundary: The pipeline does NOT commit. The caller (router)
owns the commit so it can attach patient_id before finalizing.
"""
import logging
import uuid
from datetime import datetime

from app.agents.smart_triage import SmartTriageAgent
from app.agents.langchain_coordinator import coordinator_agent
from app.agents.agents import HospitalAgent, NegotiationAgent, DispatchAgent, RouteAgent
from app.models.db_models import Emergency, EmergencyStatus
from app.models.schemas import SOSRequest
from app.database import AsyncSession

logger = logging.getLogger(__name__)


class AgentPipeline:
    def __init__(self):
        self.triage_agent = SmartTriageAgent()
        
        # Fallback legacy agents in case LangChain fails or GROQ_API_KEY is missing
        self.hospital_agent = HospitalAgent()
        self.negotiation_agent = NegotiationAgent()
        self.dispatch_agent = DispatchAgent()
        self.route_agent = RouteAgent()

    async def process_sos(self, request: SOSRequest, db: AsyncSession) -> Emergency:
        """
        Execute the agent pipeline for emergency dispatch.

        Returns the Emergency ORM object with all relationships populated.
        Does NOT commit — caller must call db.commit() after attaching patient_id.
        Raises on any agent failure and rolls back.
        """
        pipeline_start = datetime.utcnow()

        try:
            # ── Create Emergency record ──────────────────────────────────────
            short_id = f"EMG-{uuid.uuid4().hex[:4].upper()}"
            emergency = Emergency(
                short_id=short_id,
                patient_lat=request.patient_lat,
                patient_lng=request.patient_lng,
                patient_address=request.patient_address,
                description=request.description,
                image_url=request.image_url,
                emergency_type=request.emergency_type,
                status=EmergencyStatus.PENDING,
            )
            db.add(emergency)
            await db.flush()  # Get emergency.id without committing

            logger.info("Pipeline started for %s (%s)", short_id, request.emergency_type)

            # ── Step 1: Smart Triage ─────────────────────────────────────────
            t0 = datetime.utcnow()
            await self.triage_agent.process(emergency, db)
            emergency.status = EmergencyStatus.TRIAGED
            await db.flush()
            logger.info("[1/2] TriageAgent done in %.0fms", (datetime.utcnow() - t0).total_seconds() * 1000)

            # ── Step 2: LangChain Coordinator (Hospital, Vehicle, Route) ─────
            t0 = datetime.utcnow()
            
            # Attempt to use the autonomous LangChain agent
            success = await coordinator_agent.process(emergency, db)
            
            if success:
                logger.info("[2/2] LangChainCoordinator done in %.0fms", (datetime.utcnow() - t0).total_seconds() * 1000)
            else:
                logger.warning("LangChainCoordinator disabled or failed. Falling back to legacy sequential agents.")
                
                # ── Legacy Fallback: Agent 2: Hospital Selection ──────────────────────────────────
                t_f = datetime.utcnow()
                await self.hospital_agent.process(emergency, db)
                await db.flush()
                
                # ── Legacy Fallback: Agent 3: Hospital Capacity Negotiation ───────────────────────
                await self.negotiation_agent.process(emergency, db)
                await db.flush()
                
                # ── Legacy Fallback: Agent 4: Dispatch Vehicle ────────────────────────────────────
                await self.dispatch_agent.process(emergency, db)
                await db.flush()
                
                # ── Legacy Fallback: Agent 5: Route & ETA ─────────────────────────────────────────
                await self.route_agent.process(emergency, db)
                await db.flush()
                logger.info("[2/2] Legacy fallback sequence done in %.0fms", (datetime.utcnow() - t_f).total_seconds() * 1000)

            total_ms = (datetime.utcnow() - pipeline_start).total_seconds() * 1000
            logger.info(
                "Pipeline complete for %s → severity=%s, hospital_id=%s, vehicle_id=%s, eta=%s min [%.0fms total]",
                short_id,
                emergency.severity.value if emergency.severity else "?",
                emergency.hospital_id,
                emergency.vehicle_id,
                emergency.estimated_eta_mins,
                total_ms,
            )

            # ── NOTE: Do NOT commit here. Caller owns transaction. ───────────
            return emergency

        except Exception as exc:
            logger.error(
                "Pipeline failed for request lat=%s lng=%s: %s",
                request.patient_lat,
                request.patient_lng,
                exc,
                exc_info=True,
            )
            await db.rollback()
            raise


# Global singleton — safe because AgentPipeline is stateless (all state is in DB)
pipeline = AgentPipeline()
