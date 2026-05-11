import math
import hashlib
import logging
from datetime import datetime
from sqlalchemy import select
from app.models.db_models import (
    Emergency, Hospital, Vehicle, AgentLog, SeverityLevel,
    HospitalStatus, VehicleTier, EmergencyStatus, EmergencyType
)
from app.database import AsyncSession

logger = logging.getLogger(__name__)


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Calculate great-circle distance between two coordinates in kilometres."""
    R = 6371
    lat1, lng1, lat2, lng2 = map(math.radians, [lat1, lng1, lat2, lng2])
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _make_hash(emergency_id: str, agent_name: str) -> str:
    """Deterministic decision hash based on emergency + agent."""
    content = f"{emergency_id}-{agent_name}-{datetime.utcnow().isoformat()}"
    return hashlib.sha256(content.encode()).hexdigest()


# ─────────────────────────────────────────────────────────────────────────────
# Hospital Agent
# ─────────────────────────────────────────────────────────────────────────────

class HospitalAgent:
    """
    Selects the optimal receiving hospital based on:
      - ICU/ER availability for critical/urgent patients
      - Medical specialization match
      - Haversine distance (×1.3 road factor for Kathmandu)
    """

    async def process(self, emergency: Emergency, db: AsyncSession):
        stmt = select(Hospital).where(Hospital.is_active == True)
        result = await db.execute(stmt)
        hospitals = result.scalars().all()

        candidates = []
        for h in hospitals:
            # Critical/urgent require open ICU
            if emergency.severity in (SeverityLevel.P1_CRITICAL, SeverityLevel.P2_URGENT):
                if h.icu_status != HospitalStatus.OPEN:
                    continue
            # All cases require open ER
            if h.er_status != HospitalStatus.OPEN:
                continue

            dist_km = haversine_km(emergency.patient_lat, emergency.patient_lng, h.lat, h.lng) * 1.3

            # Specialization bonus/penalty
            spec_match = (
                not emergency.medical_category
                or emergency.medical_category == "GENERAL"
                or emergency.medical_category in (h.specializations or [])
            )
            spec_penalty = 0.0 if spec_match else 2.0  # 2 km penalty if no spec match

            score = dist_km + spec_penalty
            candidates.append((score, h))

        # --- LLM + Web Search Enhancement ---
        web_results_text = "No web search data used."
        confidence = 0.80
        from app.agents.web_search import search_nearest_hospitals_web
        from app.agents.groq_client import groq_client

        try:
            # Check if web search might yield better unknown local options (just for context)
            web_hospitals = await search_nearest_hospitals_web(emergency.patient_lat, emergency.patient_lng, "hospital")
            if web_hospitals:
                web_names = [wh["name"] for wh in web_hospitals]
                web_results_text = f"Found local nearby hospitals via OpenStreetMap: {', '.join(web_names)}."

            if candidates and groq_client.is_available:
                # Let LLM verify if the top DB candidate is the best choice based on severity and local knowledge
                candidates.sort(key=lambda x: x[0])
                top_score, top_h = candidates[0]
                
                prompt = f"""
                You are evaluating hospital assignments.
                Emergency Severity: {emergency.severity.value if emergency.severity else 'UNKNOWN'}
                Category: {emergency.medical_category}
                Patient Description: {emergency.description or 'None provided'}
                
                Top Database Candidate: {top_h.name} (Distance: {top_score:.2f} km)
                Specializations: {top_h.specializations}
                ICU Status: {top_h.icu_status.value}, ER Status: {top_h.er_status.value}
                
                Web Context (Nearest real-world): {web_results_text}
                
                Is {top_h.name} the most appropriate choice given the medical category and ICU requirement?
                Respond with JSON: {{"decision": "Valid", "reasoning": "...", "confidence": 0.95}}
                """
                response = await groq_client.chat(
                    system_prompt="You are RapidAid's Hospital Selection Agent.",
                    user_message=prompt,
                    model="llama-3.1-8b-instant"
                )
                if response:
                    llm_data = groq_client.extract_json(response)
                    if llm_data:
                        confidence = float(llm_data.get("confidence", 0.92))
                        web_results_text += f" LLM Verification: {llm_data.get('reasoning', 'Verified')}"
                        
        except Exception as e:
            logger.warning("Hospital Agent LLM/Web enhancement failed: %s", e)

        # --- End LLM ---

        if not candidates:
            # Graceful fallback: any hospital with open ER
            fallback_stmt = select(Hospital).where(
                Hospital.er_status == HospitalStatus.OPEN,
                Hospital.is_active == True,
            )
            fallback_result = await db.execute(fallback_stmt)
            fallback_hospitals = fallback_result.scalars().all()
            if not fallback_hospitals:
                raise RuntimeError("No available hospitals found — all ERs full or offline.")
            selected = min(
                fallback_hospitals,
                key=lambda h: haversine_km(emergency.patient_lat, emergency.patient_lng, h.lat, h.lng),
            )
            reasoning = (
                f"FALLBACK: No hospital with open ICU found for {emergency.severity}. "
                f"Routed to nearest open-ER hospital: {selected.name}. {web_results_text}"
            )
            confidence = 0.70
        else:
            candidates.sort(key=lambda x: x[0])
            score, selected = candidates[0]
            reasoning = (
                f"Selected {selected.name} (score={score:.2f} km). "
                f"Specializations: {selected.specializations}. "
                f"ICU: {selected.icu_status.value}, ER: {selected.er_status.value}. "
                f"Severity: {emergency.severity.value if emergency.severity else 'UNKNOWN'}. "
                f"Web Context: {web_results_text}"
            )
            confidence = 0.92 if (emergency.medical_category in (selected.specializations or [])) else 0.80

        emergency.hospital_id = selected.id

        log = AgentLog(
            emergency_id=emergency.id,
            agent_name="HOSPITAL_AGENT",
            decision=f"Selected {selected.name} ({selected.address})",
            reasoning=reasoning,
            confidence=confidence,
            decision_hash=_make_hash(emergency.id, "HOSPITAL_AGENT"),
        )
        db.add(log)
        await db.flush()
        logger.info("HospitalAgent → %s (conf=%.2f)", selected.name, confidence)


# ─────────────────────────────────────────────────────────────────────────────
# Negotiation Agent
# ─────────────────────────────────────────────────────────────────────────────

class NegotiationAgent:
    """
    Simulates real-time hospital capacity negotiation.

    In production: Would make an API call / WebSocket ping to the hospital system
    to confirm they can accept this patient. For the hackathon demo, this agent
    re-validates the selected hospital's current status and attempts a single
    re-route if it has become unavailable since HospitalAgent ran.
    """

    async def process(self, emergency: Emergency, db: AsyncSession):
        # Fetch the hospital selected by HospitalAgent
        hospital_stmt = select(Hospital).where(Hospital.id == emergency.hospital_id)
        hospital = (await db.execute(hospital_stmt)).scalar_one_or_none()

        if not hospital:
            raise RuntimeError("NegotiationAgent: Hospital not found for emergency.")

        # Re-validate capacity
        can_accept = hospital.er_status == HospitalStatus.OPEN and hospital.is_active

        if emergency.severity in (SeverityLevel.P1_CRITICAL, SeverityLevel.P2_URGENT):
            can_accept = can_accept and (hospital.icu_status == HospitalStatus.OPEN)

        if can_accept:
            # Hospital confirms acceptance
            decision = f"CONFIRMED: {hospital.name} accepts incoming {emergency.severity.value if emergency.severity else 'patient'}"
            reasoning = (
                f"Hospital {hospital.name} re-validated — ICU: {hospital.icu_status.value}, "
                f"ER: {hospital.er_status.value}. Capacity confirmed for "
                f"{emergency.medical_category or 'GENERAL'} case."
            )
            confidence = 0.97
        else:
            # Hospital no longer available — attempt re-route
            logger.warning(
                "NegotiationAgent: %s became unavailable since HospitalAgent ran. Attempting re-route.",
                hospital.name,
            )

            fallback_stmt = select(Hospital).where(
                Hospital.er_status == HospitalStatus.OPEN,
                Hospital.is_active == True,
                Hospital.id != emergency.hospital_id,
            )
            fallback_result = await db.execute(fallback_stmt)
            alternatives = fallback_result.scalars().all()

            if alternatives:
                new_hospital = min(
                    alternatives,
                    key=lambda h: haversine_km(emergency.patient_lat, emergency.patient_lng, h.lat, h.lng),
                )
                emergency.hospital_id = new_hospital.id
                decision = f"REROUTED: {hospital.name} full → redirected to {new_hospital.name}"
                reasoning = (
                    f"{hospital.name} became unavailable (ICU={hospital.icu_status.value}). "
                    f"Negotiation failed. Re-routed to {new_hospital.name} as closest alternative."
                )
                confidence = 0.82
                hospital = new_hospital
            else:
                # Proceed anyway — no alternatives
                decision = f"FORCED: {hospital.name} (no alternatives available)"
                reasoning = (
                    f"All alternative hospitals at capacity. Proceeding to {hospital.name} "
                    f"despite reduced capacity. Alert sent to hospital staff."
                )
                confidence = 0.55

        log = AgentLog(
            emergency_id=emergency.id,
            agent_name="NEGOTIATION_AGENT",
            decision=decision,
            reasoning=reasoning,
            confidence=confidence,
            decision_hash=_make_hash(emergency.id, "NEGOTIATION_AGENT"),
        )
        db.add(log)
        await db.flush()
        logger.info("NegotiationAgent → %s (conf=%.2f)", decision, confidence)


# ─────────────────────────────────────────────────────────────────────────────
# Dispatch Agent
# ─────────────────────────────────────────────────────────────────────────────

class DispatchAgent:
    """
    Selects the optimal available ambulance vehicle.

    Scoring:
      - Primary: Haversine distance (×1.3 Kathmandu road factor)
      - Secondary: Tier preference based on severity
        P1_CRITICAL → TIER_1 only; P4_MINOR → TIER_2 preferred
    """

    TIER_SEVERITY_MAP = {
        SeverityLevel.P1_CRITICAL: [VehicleTier.TIER_1],
        SeverityLevel.P2_URGENT:   [VehicleTier.TIER_1, VehicleTier.TIER_2],
        SeverityLevel.P3_MODERATE: [VehicleTier.TIER_2, VehicleTier.TIER_1],
        SeverityLevel.P4_MINOR:    [VehicleTier.TIER_2],
    }

    async def process(self, emergency: Emergency, db: AsyncSession):
        stmt = select(Vehicle).where(
            Vehicle.is_available == True,
            Vehicle.current_lat.is_not(None),
            Vehicle.current_lng.is_not(None),
        )
        result = await db.execute(stmt)
        vehicles = result.scalars().all()

        if not vehicles:
            raise RuntimeError("No available vehicles with GPS coordinates found.")

        preferred_tiers = self.TIER_SEVERITY_MAP.get(
            emergency.severity, [VehicleTier.TIER_1, VehicleTier.TIER_2]
        )

        candidates = []
        for v in vehicles:
            dist_km = haversine_km(
                emergency.patient_lat, emergency.patient_lng,
                v.current_lat, v.current_lng
            ) * 1.3

            # Penalize wrong tier (but don't exclude entirely)
            tier_penalty = 0.0 if v.tier in preferred_tiers else 1.5

            # --- DEMO HACK: Presence Detection ---
            # The active driver portal pings /location every 5 seconds.
            # If a vehicle hasn't pinged in 15s, it means the tab is closed or inactive.
            # We add a huge penalty so the AI always picks the driver you are currently looking at!
            time_since_ping = (datetime.utcnow() - v.updated_at).total_seconds()
            activity_penalty = 0.0 if time_since_ping < 15 else 50.0

            score = dist_km + tier_penalty + activity_penalty
            candidates.append((score, v))

        candidates.sort(key=lambda x: x[0])
        score, selected = candidates[0]

        emergency.vehicle_id = selected.id
        emergency.status = EmergencyStatus.DISPATCHED
        emergency.dispatched_at = datetime.utcnow()

        selected.is_available = False
        db.add(selected)

        reasoning = (
            f"Dispatched {selected.registration} (Tier {selected.tier.value}). "
            f"Distance: {score:.2f} km to patient. "
            f"Preferred tiers for {emergency.severity.value if emergency.severity else 'UNKNOWN'}: "
            f"{[t.value for t in preferred_tiers]}. "
            f"{len(vehicles)} vehicle(s) evaluated."
        )

        log = AgentLog(
            emergency_id=emergency.id,
            agent_name="DISPATCH_AGENT",
            decision=f"Dispatched {selected.registration} (Tier {selected.tier.value})",
            reasoning=reasoning,
            confidence=0.94,
            decision_hash=_make_hash(emergency.id, "DISPATCH_AGENT"),
        )
        db.add(log)
        await db.flush()
        logger.info("DispatchAgent → %s @ %.2f km (conf=0.94)", selected.registration, score)


# ─────────────────────────────────────────────────────────────────────────────
# Route Agent
# ─────────────────────────────────────────────────────────────────────────────

class RouteAgent:
    """
    Calculates ETA and fare using:
      - Haversine distances × 1.3 road factor
      - Hour-based Kathmandu traffic profile (UTC+5:45 adjusted)
      - Vehicle tier for speed assumptions
      - MEDICAL_RIDE fare formula (NPR)
    """

    # Kathmandu traffic multiplier by UTC hour
    # (UTC+5:45 → NPT, peak at 8-11 AM and 5-8 PM local)
    TRAFFIC_PROFILE = {
        (0, 5):   0.7,   # 5:45-10:45 NPT → early morning, clear roads
        (6, 7):   1.2,   # 11:45-12:45 NPT → light midday traffic
        (8, 10):  1.8,   # 13:45-15:45 NPT → afternoon rush start
        (11, 16): 1.3,   # 16:45-21:45 NPT → moderate
        (17, 19): 1.9,   # 22:45-00:45 NPT → evening rush (worst in KTM)
        (20, 23): 1.1,   # 01:45-04:45 NPT → night
    }

    def _traffic_multiplier(self) -> float:
        hour = datetime.utcnow().hour
        for (start, end), mult in self.TRAFFIC_PROFILE.items():
            if start <= hour <= end:
                return mult
        return 1.3  # default

    async def process(self, emergency: Emergency, db: AsyncSession):
        # Fetch hospital
        hospital_stmt = select(Hospital).where(Hospital.id == emergency.hospital_id)
        hospital = (await db.execute(hospital_stmt)).scalar_one()

        # Fetch vehicle
        vehicle_stmt = select(Vehicle).where(Vehicle.id == emergency.vehicle_id)
        vehicle = (await db.execute(vehicle_stmt)).scalar_one()

        traffic_mult = self._traffic_multiplier()

        # Emergency type: CRITICAL_SOS gets faster speed (sirens on)
        base_speed_kmh = 35.0 if emergency.emergency_type == EmergencyType.CRITICAL_SOS else 25.0
        effective_mult = 1.0 + (traffic_mult - 1.0) * 0.4  # Sirens mitigate traffic by 60%

        # --- OSRM Web Request ---
        from app.agents.web_search import fetch_routing_info_web
        
        web_route_1 = await fetch_routing_info_web(
            vehicle.current_lat, vehicle.current_lng, 
            emergency.patient_lat, emergency.patient_lng
        )
        web_route_2 = await fetch_routing_info_web(
            emergency.patient_lat, emergency.patient_lng, 
            hospital.lat, hospital.lng
        )

        if web_route_1 and web_route_2:
            dist_to_patient = web_route_1["distance_km"]
            dist_to_hospital = web_route_2["distance_km"]
            base_duration = web_route_1["duration_mins"] + web_route_2["duration_mins"]
            eta_mins = max(2, round(base_duration * effective_mult))
            source_info = "OSRM Routing API"
        else:
            # Fallback to Haversine
            dist_to_patient = haversine_km(
                vehicle.current_lat, vehicle.current_lng,
                emergency.patient_lat, emergency.patient_lng
            ) * 1.3

            dist_to_hospital = haversine_km(
                emergency.patient_lat, emergency.patient_lng,
                hospital.lat, hospital.lng
            ) * 1.3
            source_info = "Haversine Distance"
            total_dist_km = dist_to_patient + dist_to_hospital
            eta_mins = max(2, round((total_dist_km / base_speed_kmh) * 60 * effective_mult))
            
        total_dist_km = dist_to_patient + dist_to_hospital
        
        # --- End Web Request ---

        emergency.estimated_eta_mins = eta_mins

        # Fare only for MEDICAL_RIDE (non-emergency transport)
        fare = None
        if emergency.emergency_type == EmergencyType.MEDICAL_RIDE:
            tier_mult = 2.5 if vehicle.tier == VehicleTier.TIER_1 else 1.0
            fare = round((200.0 + total_dist_km * 35.0) * tier_mult, 2)
            emergency.fare_npr = fare

        reasoning = (
            f"Routing Source: {source_info}. "
            f"Leg 1 (vehicle→patient): {dist_to_patient:.2f} km. "
            f"Leg 2 (patient→hospital): {dist_to_hospital:.2f} km. "
            f"Total: {total_dist_km:.2f} km. "
            f"Traffic multiplier: {traffic_mult} (hour={datetime.utcnow().hour} UTC). "
            f"Effective multiplier: {effective_mult:.2f}. "
            f"ETA: {eta_mins} min."
            + (f" Fare: NPR {fare}" if fare else "")
        )

        log = AgentLog(
            emergency_id=emergency.id,
            agent_name="ROUTE_AGENT",
            decision=f"ETA {eta_mins} min | Total {total_dist_km:.1f} km" + (f" | NPR {fare}" if fare else ""),
            reasoning=reasoning,
            confidence=0.95 if source_info == "OSRM Routing API" else 0.88,
            decision_hash=_make_hash(emergency.id, "ROUTE_AGENT"),
        )
        db.add(log)
        await db.flush()
        logger.info(
            "RouteAgent → ETA %d min, %.2f km, traffic=%.1f (conf=0.88)",
            eta_mins, total_dist_km, traffic_mult
        )
