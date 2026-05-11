import json
import logging
from typing import Dict, Any

from langchain_core.prompts import ChatPromptTemplate

from app.core.config import settings
from app.models.db_models import Emergency, AgentLog
from app.database import AsyncSession
from app.agents.langchain_tools import (
    search_osm_hospitals_tool,
    calculate_route_tool,
    query_db_hospitals_tool,
    query_db_vehicles_tool
)

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are the RapidAid Emergency Dispatch Coordinator AI.
Your job is to autonomously handle an incoming emergency that has already been triaged.

You MUST follow these steps precisely:
1. Find an appropriate hospital:
   - Use `query_db_hospitals_tool` to find active, available hospitals from our internal system that match the severity and required specialization.
   - Use `search_osm_hospitals_tool` to get real-world context for nearby hospitals around the patient. 
   - Choose the best hospital ID from the DB query that satisfies the medical constraints.

2. Find an available ambulance vehicle:
   - Use `query_db_vehicles_tool` to find an available ambulance. TIER_1 is preferred for CRITICAL/URGENT. TIER_2 is fine for MODERATE/MINOR.

3. Calculate the route and ETA:
   - Use `calculate_route_tool` with the selected vehicle's current coordinates and the patient's coordinates to find the ETA for the vehicle to reach the patient.
   - Use `calculate_route_tool` with the patient's coordinates and the hospital's coordinates to find the transport ETA.
   - Add them together for a total ETA.

4. Make the final decision. You MUST return ONLY a raw valid JSON object (no markdown formatting, no code blocks) containing your final decision:
{
    "hospital_id": "uuid-of-selected-hospital",
    "vehicle_id": "uuid-of-selected-vehicle",
    "eta_mins": 15,
    "total_distance_km": 12.5,
    "reasoning": "A concise summary of why this hospital and vehicle were chosen, and how the ETA was calculated."
}
Do not return anything else except the JSON. Do not wrap it in ```json.
"""

class LangChainCoordinator:
    def __init__(self):
        self.available = False
        if not settings.GROQ_API_KEY:
            logger.warning("LangChainCoordinator: GROQ_API_KEY missing, agent disabled.")
            return

        try:
            # Initialize the LLM and only import langchain extensions when Groq is enabled.
            from langchain_groq import ChatGroq
            from langchain_classic.agents import create_tool_calling_agent, AgentExecutor

            self.llm = ChatGroq(
                api_key=settings.GROQ_API_KEY,
                model="llama-3.3-70b-versatile",
                temperature=0.1
            )

            # Define the tools
            self.tools = [
                search_osm_hospitals_tool,
                calculate_route_tool,
                query_db_hospitals_tool,
                query_db_vehicles_tool
            ]

            # Create the prompt
            self.prompt = ChatPromptTemplate.from_messages([
                ("system", SYSTEM_PROMPT),
                ("user", "Emergency details:\n{input}"),
                ("placeholder", "{agent_scratchpad}"),
            ])

            # Create the agent
            self.agent = create_tool_calling_agent(self.llm, self.tools, self.prompt)

            # Create the executor
            self.agent_executor = AgentExecutor(
                agent=self.agent,
                tools=self.tools,
                verbose=True,
                handle_parsing_errors=True,
                max_iterations=8
            )
            self.available = True
            logger.info("LangChainCoordinator initialized successfully with Groq and Tools.")
        except ImportError as exc:
            logger.error(
                "LangChainCoordinator disabled because a required Groq dependency is missing or incompatible: %s. "
                "If you want AI tool-calling support, install compatible packages or leave GROQ_API_KEY empty.",
                exc,
            )
        except Exception as e:
            logger.error(f"Failed to initialize LangChainCoordinator: {e}")

    async def process(self, emergency: Emergency, db: AsyncSession) -> bool:
        if not self.available:
            return False
            
        try:
            # Construct the input string for the agent
            input_text = (
                f"Severity: {emergency.severity.value if emergency.severity else 'UNKNOWN'}\n"
                f"Medical Category: {emergency.medical_category or 'GENERAL'}\n"
                f"Patient Location: {emergency.patient_lat}, {emergency.patient_lng}\n"
                f"Emergency Description: {emergency.description}"
            )
            
            # Run the agent asynchronously
            response = await self.agent_executor.ainvoke({"input": input_text})
            output_text = response.get("output", "")
            
            # Extract JSON from output
            output_text = output_text.strip()
            if output_text.startswith("```"):
                lines = output_text.split('\n')
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines[-1].startswith("```"):
                    lines = lines[:-1]
                output_text = "\n".join(lines).strip()
                
            decision_data = json.loads(output_text)
            
            # Apply the decisions to the emergency object
            hospital_id = decision_data.get("hospital_id")
            vehicle_id = decision_data.get("vehicle_id")
            
            if not hospital_id or not vehicle_id:
                raise ValueError("Agent did not return hospital_id or vehicle_id")
                
            emergency.hospital_id = hospital_id
            emergency.vehicle_id = vehicle_id
            emergency.estimated_eta_mins = int(decision_data.get("eta_mins", 15))
            
            # Log the agent's decision
            from app.agents.agents import _make_hash
            from datetime import datetime
            
            log = AgentLog(
                emergency_id=emergency.id,
                agent_name="LANGCHAIN_COORDINATOR",
                decision=f"Assigned Hospital: {hospital_id}, Vehicle: {vehicle_id}",
                reasoning=decision_data.get("reasoning", "Autonomous LangChain decision based on tool outputs."),
                confidence=0.95,
                decision_hash=_make_hash(emergency.id, "LANGCHAIN_COORDINATOR"),
                created_at=datetime.utcnow()
            )
            db.add(log)
            await db.flush()
            
            logger.info("LangChainCoordinator completed successfully.")
            return True
            
        except Exception as e:
            logger.error(f"LangChainCoordinator process failed: {e}")
            return False

coordinator_agent = LangChainCoordinator()
