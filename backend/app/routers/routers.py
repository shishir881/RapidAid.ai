from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, Query
from sqlalchemy import select, func
from datetime import datetime, timedelta
from typing import Optional, List
import httpx
from app.models.db_models import (
    Emergency, Hospital, Vehicle, User, AgentLog,
    EmergencyStatus, SeverityLevel, HospitalStatus, UserRole
)
from app.models.schemas import (
    SOSRequest, EmergencyResponse, EmergencyListItem, AgentDecisionResponse,
    HospitalStatusUpdate, VehicleLocationUpdate, VehicleAvailabilityUpdate,
    DashboardStats, AgentPerformanceStats, LiveFeedEvent
)
from app.database import AsyncSession, get_db
from app.agents.pipeline import pipeline
from app.websockets.manager import manager


# ─────────────────────────── Routers ─────────────────────────────────────────
health_router    = APIRouter(tags=["health"])
emergency_router = APIRouter(prefix="/emergency",  tags=["emergency"])
hospital_router  = APIRouter(prefix="/hospitals",  tags=["hospitals"])
vehicle_router   = APIRouter(prefix="/vehicles",   tags=["vehicles"])
navigation_router = APIRouter(prefix="/navigation", tags=["navigation"])
dashboard_router = APIRouter(prefix="/dashboard",  tags=["dashboard"])
ws_router        = APIRouter(tags=["websockets"])


# ═══════════════════════════ HEALTH ══════════════════════════════════════════

@health_router.get("/", summary="Health check")
async def health_check():
    return {"status": "🟢 ONLINE", "service": "RapidAid.ai API", "version": "1.0.0"}


# ═══════════════════════════ EMERGENCY ═══════════════════════════════════════

@emergency_router.post("/sos", response_model=EmergencyResponse, summary="Trigger SOS — runs 5-agent pipeline")
async def create_sos(request: SOSRequest, db: AsyncSession = Depends(get_db)):
    """
    Core endpoint: Creates emergency record and runs the full 5-agent pipeline.
    Broadcasts WebSocket alerts to hospital and driver after dispatch.
    """
    # Run 5-agent pipeline (does NOT commit internally)
    try:
        emergency = await pipeline.process_sos(request, db)
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))

    # Commit the emergency record
    await db.commit()
    
    # Refresh to load all relationships
    await db.refresh(emergency, ["vehicle", "hospital", "agent_logs"])

    # Broadcast WebSocket alerts (non-blocking, best-effort)
    if emergency.hospital_id:
        hospital = (await db.execute(select(Hospital).where(Hospital.id == emergency.hospital_id))).scalar_one_or_none()
        if hospital:
            await manager.broadcast_hospital_incoming_patient(
                str(hospital.id),
                emergency.short_id,
                emergency.severity.value if emergency.severity else "UNKNOWN",
                emergency.medical_category or "GENERAL",
                emergency.estimated_eta_mins or 0,
                emergency.patient_lat,
                emergency.patient_lng,
            )

    if emergency.vehicle_id:
        vehicle = (await db.execute(select(Vehicle).where(Vehicle.id == emergency.vehicle_id))).scalar_one_or_none()
        if vehicle:
            hospital_name = None
            hospital_lat = None
            hospital_lng = None
            if emergency.hospital_id:
                h = (await db.execute(select(Hospital).where(Hospital.id == emergency.hospital_id))).scalar_one_or_none()
                if h:
                    hospital_name = h.name
                    hospital_lat = h.lat
                    hospital_lng = h.lng
            
            await manager.send_driver_assignment(
                str(vehicle.id),
                str(emergency.id),
                emergency.short_id,
                emergency.patient_lat,
                emergency.patient_lng,
                emergency.patient_address or "Unknown location",
                emergency.description,
                emergency.severity.value if emergency.severity else "UNKNOWN",
                hospital_name,
                hospital_lat,
                hospital_lng,
            )

    return await _emergency_to_response(emergency, db)


@emergency_router.get("/", response_model=List[EmergencyListItem], summary="List emergencies (paginated)")
async def list_emergencies(
    status: Optional[EmergencyStatus] = Query(None, description="Filter by status"),
    severity: Optional[SeverityLevel] = Query(None, description="Filter by severity"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List all emergencies with optional filters. Returns lightweight list items."""
    stmt = select(Emergency).order_by(Emergency.created_at.desc()).limit(limit).offset(offset)
    if status:
        stmt = stmt.where(Emergency.status == status)
    if severity:
        stmt = stmt.where(Emergency.severity == severity)

    result = await db.execute(stmt)
    emergencies = result.scalars().all()

    items = []
    for e in emergencies:
        hospital_name = None
        vehicle_reg = None
        if e.hospital_id:
            h = (await db.execute(select(Hospital).where(Hospital.id == e.hospital_id))).scalar_one_or_none()
            hospital_name = h.name if h else None
        if e.vehicle_id:
            v = (await db.execute(select(Vehicle).where(Vehicle.id == e.vehicle_id))).scalar_one_or_none()
            vehicle_reg = v.registration if v else None

        items.append(EmergencyListItem(
            id=str(e.id),
            short_id=e.short_id,
            status=e.status,
            severity=e.severity,
            medical_category=e.medical_category,
            hospital_name=hospital_name,
            vehicle_reg=vehicle_reg,
            eta_mins=e.estimated_eta_mins,
            created_at=e.created_at,
        ))
    return items


@emergency_router.get("/{emergency_id}", response_model=EmergencyResponse, summary="Get emergency by ID or short_id")
async def get_emergency(emergency_id: str, db: AsyncSession = Depends(get_db)):
    """Get full emergency details including all agent decisions."""
    stmt = select(Emergency).where(Emergency.short_id == emergency_id)
    result = await db.execute(stmt)
    emergency = result.scalar_one_or_none()

    # Try UUID fallback
    if not emergency:
        stmt2 = select(Emergency).where(Emergency.id == emergency_id)
        emergency = (await db.execute(stmt2)).scalar_one_or_none()

    if not emergency:
        raise HTTPException(status_code=404, detail=f"Emergency '{emergency_id}' not found")

    await db.refresh(emergency)
    return await _emergency_to_response(emergency, db)


@emergency_router.patch("/{emergency_id}/status", response_model=EmergencyResponse, summary="Update emergency status")
async def update_emergency_status(
    emergency_id: str,
    status: EmergencyStatus = Query(..., description="New status"),
    db: AsyncSession = Depends(get_db),
):
    """Update emergency lifecycle status. Frees vehicle when ARRIVED."""
    stmt = select(Emergency).where(Emergency.short_id == emergency_id)
    emergency = (await db.execute(stmt)).scalar_one_or_none()
    if not emergency:
        stmt2 = select(Emergency).where(Emergency.id == emergency_id)
        emergency = (await db.execute(stmt2)).scalar_one_or_none()
    if not emergency:
        raise HTTPException(status_code=404, detail="Emergency not found")

    emergency.status = status
    now = datetime.utcnow()
    if status == EmergencyStatus.ON_SCENE:
        emergency.on_scene_at = now
    elif status == EmergencyStatus.ARRIVED:
        emergency.arrived_at_hospital = now
        if emergency.vehicle_id:
            vehicle = (await db.execute(select(Vehicle).where(Vehicle.id == emergency.vehicle_id))).scalar_one_or_none()
            if vehicle:
                vehicle.is_available = True
                db.add(vehicle)
    elif status == EmergencyStatus.CLOSED:
        emergency.closed_at = now

    db.add(emergency)
    await db.commit()

    await manager.broadcast_patient_status_update(str(emergency.id), status.value)
    await db.refresh(emergency)
    return await _emergency_to_response(emergency, db)


# ═══════════════════════════ HOSPITALS ═══════════════════════════════════════

@hospital_router.get("/", summary="List all active hospitals")
async def list_hospitals(db: AsyncSession = Depends(get_db)):
    stmt = select(Hospital).where(Hospital.is_active == True)
    hospitals = (await db.execute(stmt)).scalars().all()
    return [_hospital_dict(h) for h in hospitals]


@hospital_router.get("/{hospital_id}", summary="Get single hospital detail")
async def get_hospital(hospital_id: str, db: AsyncSession = Depends(get_db)):
    stmt = select(Hospital).where(Hospital.id == hospital_id)
    hospital = (await db.execute(stmt)).scalar_one_or_none()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return _hospital_dict(hospital)


@hospital_router.patch("/{hospital_id}/status", summary="Update hospital ICU/ER status")
async def update_hospital_status(
    hospital_id: str,
    update: HospitalStatusUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Toggle ICU/ER/blood_bank/operating_room status for a hospital."""
    # BUG FIX: Compare as plain string (SQLite stores UUIDs as strings)
    stmt = select(Hospital).where(Hospital.id == hospital_id)
    hospital = (await db.execute(stmt)).scalar_one_or_none()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    if update.icu_status is not None:
        hospital.icu_status = update.icu_status
    if update.er_status is not None:
        hospital.er_status = update.er_status
    if update.blood_bank is not None:
        hospital.blood_bank = update.blood_bank
    if update.operating_room is not None:
        hospital.operating_room = update.operating_room

    db.add(hospital)
    await db.commit()
    return _hospital_dict(hospital)


# ═══════════════════════════ VEHICLES ════════════════════════════════════════

@vehicle_router.get("/", summary="List all vehicles with driver info")
async def list_vehicles(db: AsyncSession = Depends(get_db)):
    vehicles = (await db.execute(select(Vehicle))).scalars().all()
    result = []
    for v in vehicles:
        await db.refresh(v, ["driver"])
        result.append(_vehicle_dict(v))
    return result


@vehicle_router.get("/{vehicle_id}/assignment", summary="Get active assignment for a vehicle")
async def get_vehicle_assignment(vehicle_id: str, db: AsyncSession = Depends(get_db)):
    """Returns the current active emergency for this vehicle (for driver portal reload)."""
    active_statuses = [
        EmergencyStatus.DISPATCHED, EmergencyStatus.EN_ROUTE,
        EmergencyStatus.ON_SCENE, EmergencyStatus.TRANSPORTING,
    ]
    stmt = (
        select(Emergency)
        .where(Emergency.vehicle_id == vehicle_id, Emergency.status.in_(active_statuses))
        .order_by(Emergency.created_at.desc())
    )
    emergency = (await db.execute(stmt)).scalars().first()
    if not emergency:
        return None

    hospital_name = None
    hospital_lat = None
    hospital_lng = None
    if emergency.hospital_id:
        h = (await db.execute(select(Hospital).where(Hospital.id == emergency.hospital_id))).scalar_one_or_none()
        if h:
            hospital_name = h.name
            hospital_lat = h.lat
            hospital_lng = h.lng

    return {
        "event": "ASSIGNMENT",
        "emergency_id": str(emergency.id),
        "vehicle_id": str(vehicle_id),
        "short_id": emergency.short_id,
        "patient_lat": emergency.patient_lat,
        "patient_lng": emergency.patient_lng,
        "patient_address": emergency.patient_address,
        "description": emergency.description,
        "hospital_name": hospital_name,
        "hospital_lat": hospital_lat,
        "hospital_lng": hospital_lng,
        "severity": emergency.severity.value if emergency.severity else "UNKNOWN",
        "status": emergency.status.value,
    }


@vehicle_router.get("/assignments", summary="List active assignments for all vehicles")
async def list_vehicle_assignments(db: AsyncSession = Depends(get_db)):
    """Returns active emergency assignments for all vehicles."""
    active_statuses = [
        EmergencyStatus.DISPATCHED, EmergencyStatus.EN_ROUTE,
        EmergencyStatus.ON_SCENE, EmergencyStatus.TRANSPORTING,
    ]
    stmt = (
        select(Emergency)
        .where(Emergency.status.in_(active_statuses))
        .order_by(Emergency.created_at.desc())
    )
    emergencies = (await db.execute(stmt)).scalars().all()

    result = []
    for emergency in emergencies:
        hospital_name = None
        hospital_lat = None
        hospital_lng = None
        if emergency.hospital_id:
            h = (await db.execute(select(Hospital).where(Hospital.id == emergency.hospital_id))).scalar_one_or_none()
            if h:
                hospital_name = h.name
                hospital_lat = h.lat
                hospital_lng = h.lng

        result.append({
            "event": "ASSIGNMENT",
            "emergency_id": str(emergency.id),
            "vehicle_id": str(emergency.vehicle_id) if emergency.vehicle_id else None,
            "short_id": emergency.short_id,
            "patient_lat": emergency.patient_lat,
            "patient_lng": emergency.patient_lng,
            "patient_address": emergency.patient_address,
            "hospital_name": hospital_name,
            "hospital_lat": hospital_lat,
            "hospital_lng": hospital_lng,
            "severity": emergency.severity.value if emergency.severity else "UNKNOWN",
            "status": emergency.status.value,
        })
    return result


# IMPORTANT: Keep this dynamic route AFTER static routes like /assignments
@vehicle_router.get("/{vehicle_id}", summary="Get single vehicle detail")
async def get_vehicle(vehicle_id: str, db: AsyncSession = Depends(get_db)):
    stmt = select(Vehicle).where(Vehicle.id == vehicle_id)
    vehicle = (await db.execute(stmt)).scalar_one_or_none()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    await db.refresh(vehicle, ["driver"])
    return _vehicle_dict(vehicle)


@navigation_router.get("/route", summary="Get driving route between two points")
async def get_navigation_route(
    from_lat: float = Query(..., description="Start latitude"),
    from_lng: float = Query(..., description="Start longitude"),
    to_lat: float = Query(..., description="Destination latitude"),
    to_lng: float = Query(..., description="Destination longitude"),
):
    """Fetch a driving route from OSRM and return a geojson-ready path plus turn-by-turn steps."""
    osrm_url = (
        f"http://router.project-osrm.org/route/v1/driving/"
        f"{from_lng},{from_lat};{to_lng},{to_lat}"
        "?overview=full&geometries=geojson&steps=true"
    )

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(osrm_url)
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Navigation provider error")
        data = resp.json()

    if data.get("code") != "Ok" or not data.get("routes"):
        raise HTTPException(status_code=502, detail="Navigation provider returned no route")

    route = data["routes"][0]
    coordinates = route.get("geometry", {}).get("coordinates", [])
    positions = [[lat, lng] for lng, lat in coordinates]

    steps = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver", {})
            text = maneuver.get("instruction") or ""
            if not text:
                maneuver_type = maneuver.get("type", "")
                modifier = maneuver.get("modifier", "")
                name = step.get("name", "")
                text = f"{maneuver_type.replace('_', ' ')} {modifier}".strip()
                if name:
                    text += f" onto {name}"
                text = text.strip() or "Continue"
            maneuver_loc = maneuver.get("location") or None  # [lng, lat]
            position = None
            if isinstance(maneuver_loc, list) and len(maneuver_loc) == 2:
                # Frontend expects [lat, lng]
                position = [maneuver_loc[1], maneuver_loc[0]]
            steps.append({
                "text": text,
                "distance_m": step.get("distance", 0),
                "duration_s": step.get("duration", 0),
                "position": position,
            })

    return {
        "from": [from_lat, from_lng],
        "to": [to_lat, to_lng],
        "distance_m": route.get("distance", 0),
        "duration_s": route.get("duration", 0),
        "positions": positions,
        "instructions": steps,
    }


async def _osrm_eta_minutes(from_lat: float, from_lng: float, to_lat: float, to_lng: float) -> Optional[int]:
    """Return ETA minutes from OSRM, or None on provider issues."""
    osrm_url = (
        f"http://router.project-osrm.org/route/v1/driving/"
        f"{from_lng},{from_lat};{to_lng},{to_lat}"
        "?overview=false&steps=false"
    )
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            resp = await client.get(osrm_url)
            if resp.status_code != 200:
                return None
            data = resp.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            return None
        duration_s = data["routes"][0].get("duration")
        if duration_s is None:
            return None
        return max(0, int(round(float(duration_s) / 60.0)))
    except Exception:
        return None


@vehicle_router.patch("/{vehicle_id}/location", summary="Driver GPS ping")
async def update_vehicle_location(
    vehicle_id: str,
    update: VehicleLocationUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update vehicle GPS. Broadcasts location to patient if vehicle has active emergency."""
    stmt = select(Vehicle).where(Vehicle.id == vehicle_id)
    vehicle = (await db.execute(stmt)).scalar_one_or_none()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    vehicle.current_lat = update.lat
    vehicle.current_lng = update.lng
    vehicle.updated_at = datetime.utcnow()
    db.add(vehicle)
    await db.commit()

    # Broadcast to patient tracking channel while the run is live (not only en-route to scene).
    track_statuses = [
        EmergencyStatus.DISPATCHED,
        EmergencyStatus.EN_ROUTE,
        EmergencyStatus.ON_SCENE,
        EmergencyStatus.TRANSPORTING,
    ]
    active_stmt = (
        select(Emergency)
        .where(
            Emergency.vehicle_id == vehicle_id,
            Emergency.status.in_(track_statuses),
        )
        .order_by(Emergency.created_at.desc())
    )
    active_emergency = (await db.execute(active_stmt)).scalars().first()
    if active_emergency:
        eta_minutes: Optional[int] = None
        st = active_emergency.status
        if st in (EmergencyStatus.DISPATCHED, EmergencyStatus.EN_ROUTE):
            eta_minutes = await _osrm_eta_minutes(
                update.lat, update.lng, active_emergency.patient_lat, active_emergency.patient_lng
            )
        elif st == EmergencyStatus.ON_SCENE:
            eta_minutes = 0
        elif st == EmergencyStatus.TRANSPORTING and active_emergency.hospital_id:
            h = (
                await db.execute(select(Hospital).where(Hospital.id == active_emergency.hospital_id))
            ).scalar_one_or_none()
            if h:
                eta_minutes = await _osrm_eta_minutes(update.lat, update.lng, h.lat, h.lng)

        await manager.broadcast_patient_vehicle_location(
            str(active_emergency.id), update.lat, update.lng,
            eta_minutes if eta_minutes is not None else (active_emergency.estimated_eta_mins or 0),
        )

    return {"id": vehicle_id, "current_lat": update.lat, "current_lng": update.lng}


@vehicle_router.patch("/{vehicle_id}/availability", summary="Driver marks themselves available/unavailable")
async def update_vehicle_availability(
    vehicle_id: str,
    update: VehicleAvailabilityUpdate,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Vehicle).where(Vehicle.id == vehicle_id)
    vehicle = (await db.execute(stmt)).scalar_one_or_none()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    vehicle.is_available = update.is_available
    db.add(vehicle)
    await db.commit()
    return {"id": vehicle_id, "is_available": vehicle.is_available}


# ═══════════════════════════ DASHBOARD ═══════════════════════════════════════

@dashboard_router.get("/stats", response_model=DashboardStats, summary="Live dashboard statistics")
async def get_dashboard_stats(db: AsyncSession = Depends(get_db)):
    active_statuses = [
        EmergencyStatus.PENDING, EmergencyStatus.TRIAGED,
        EmergencyStatus.DISPATCHED, EmergencyStatus.EN_ROUTE,
        EmergencyStatus.ON_SCENE, EmergencyStatus.TRANSPORTING,
    ]
    today_start = datetime.utcnow() - timedelta(days=1)

    active_count    = (await db.execute(select(func.count(Emergency.id)).where(Emergency.status.in_(active_statuses)))).scalar() or 0
    available_count = (await db.execute(select(func.count(Vehicle.id)).where(Vehicle.is_available == True))).scalar() or 0
    at_capacity     = (await db.execute(select(func.count(Hospital.id)).where((Hospital.icu_status == HospitalStatus.FULL) | (Hospital.er_status == HospitalStatus.FULL)))).scalar() or 0
    avg_eta         = (await db.execute(select(func.avg(Emergency.estimated_eta_mins)).where(Emergency.created_at >= today_start))).scalar() or 0.0
    total_today     = (await db.execute(select(func.count(Emergency.id)).where(Emergency.created_at >= today_start))).scalar() or 0

    return DashboardStats(
        active_emergencies=active_count,
        available_vehicles=available_count,
        hospitals_at_capacity=at_capacity,
        avg_response_time_mins=float(avg_eta),
        total_emergencies_today=total_today,
    )


@dashboard_router.get("/live-feed", response_model=List[LiveFeedEvent], summary="Last 20 emergency events")
async def get_live_feed(db: AsyncSession = Depends(get_db)):
    """Returns the 20 most recent emergencies for the live dashboard feed."""
    stmt = select(Emergency).order_by(Emergency.created_at.desc()).limit(20)
    emergencies = (await db.execute(stmt)).scalars().all()

    feed = []
    for e in emergencies:
        hospital_name = None
        if e.hospital_id:
            h = (await db.execute(select(Hospital).where(Hospital.id == e.hospital_id))).scalar_one_or_none()
            hospital_name = h.name if h else None
        feed.append(LiveFeedEvent(
            short_id=e.short_id,
            status=e.status.value,
            severity=e.severity.value if e.severity else None,
            medical_category=e.medical_category,
            hospital_name=hospital_name,
            created_at=e.created_at,
        ))
    return feed


@dashboard_router.get("/agent-performance", response_model=List[AgentPerformanceStats], summary="Agent confidence analytics")
async def get_agent_performance(db: AsyncSession = Depends(get_db)):
    """Returns per-agent decision statistics: count, avg/min/max confidence."""
    stmt = select(
        AgentLog.agent_name,
        func.count(AgentLog.id).label("total"),
        func.avg(AgentLog.confidence).label("avg_conf"),
        func.min(AgentLog.confidence).label("min_conf"),
        func.max(AgentLog.confidence).label("max_conf"),
    ).group_by(AgentLog.agent_name)

    rows = (await db.execute(stmt)).all()
    return [
        AgentPerformanceStats(
            agent_name=row.agent_name,
            total_decisions=row.total,
            avg_confidence=round(float(row.avg_conf or 0), 4),
            min_confidence=round(float(row.min_conf or 0), 4),
            max_confidence=round(float(row.max_conf or 0), 4),
        )
        for row in rows
    ]


# ═══════════════════════════ WEBSOCKETS ══════════════════════════════════════

@ws_router.websocket("/ws/patient/{emergency_id}")
async def websocket_patient_tracking(websocket: WebSocket, emergency_id: str):
    """Patient tracking channel: receives vehicle location + status updates."""
    await manager.connect_patient(emergency_id, websocket)
    try:
        while True:
            await websocket.receive_text()  # Keep connection alive
    except WebSocketDisconnect:
        manager.disconnect_patient(emergency_id, websocket)


@ws_router.websocket("/ws/driver/{vehicle_id}")
async def websocket_driver_assignment(websocket: WebSocket, vehicle_id: str):
    """Driver channel: receives assignments, can send GPS_UPDATE events."""
    await manager.connect_driver(vehicle_id, websocket)
    try:
        while True:
            data = await websocket.receive_json()
            # GPS_UPDATE from driver app (alternative to PATCH /vehicles/{id}/location)
            if data.get("event") == "GPS_UPDATE":
                lat = data.get("lat")
                lng = data.get("lng")
                if lat is not None and lng is not None:
                    # Delegate to existing HTTP handler logic via direct DB write
                    pass  # Handled by PATCH /vehicles/{id}/location in production
    except WebSocketDisconnect:
        manager.disconnect_driver(vehicle_id)


@ws_router.websocket("/ws/hospital/{hospital_id}")
async def websocket_hospital_alerts(websocket: WebSocket, hospital_id: str):
    """Hospital channel: receives incoming patient alerts."""
    await manager.connect_hospital(hospital_id, websocket)
    try:
        while True:
            await websocket.receive_text()  # Keep connection alive
    except WebSocketDisconnect:
        manager.disconnect_hospital(hospital_id, websocket)


# ═══════════════════════════ HELPERS ═════════════════════════════════════════

def _hospital_dict(h: Hospital) -> dict:
    return {
        "id": str(h.id),
        "name": h.name,
        "phone": h.phone,
        "address": h.address,
        "lat": h.lat,
        "lng": h.lng,
        "specializations": h.specializations or [],
        "icu_status": h.icu_status.value,
        "er_status": h.er_status.value,
        "blood_bank": h.blood_bank,
        "operating_room": h.operating_room,
        "is_active": h.is_active,
    }


def _vehicle_dict(v: Vehicle) -> dict:
    return {
        "id": str(v.id),
        "registration": v.registration,
        "tier": v.tier.value,
        "is_available": v.is_available,
        "current_lat": v.current_lat,
        "current_lng": v.current_lng,
        "driver_name": v.driver.name if v.driver else "Unassigned",
        "driver_phone": v.driver.phone if v.driver else None,
    }


async def _emergency_to_response(emergency: Emergency, db: AsyncSession) -> EmergencyResponse:
    """Convert Emergency ORM object to EmergencyResponse schema."""
    await db.refresh(emergency, ["vehicle", "hospital", "agent_logs"])

    vehicle_registration = None
    if emergency.vehicle_id:
        v = (await db.execute(select(Vehicle).where(Vehicle.id == emergency.vehicle_id))).scalar_one_or_none()
        vehicle_registration = v.registration if v else None

    hospital_name = hospital_address = hospital_phone = None
    hospital_lat = hospital_lng = None
    if emergency.hospital_id:
        h = (await db.execute(select(Hospital).where(Hospital.id == emergency.hospital_id))).scalar_one_or_none()
        if h:
            hospital_name    = h.name
            hospital_address = h.address
            hospital_phone   = h.phone
            hospital_lat     = h.lat
            hospital_lng     = h.lng

    agent_decisions = [
        AgentDecisionResponse(
            agent_name=log.agent_name,
            decision=log.decision,
            reasoning=log.reasoning,
            confidence=log.confidence,
            created_at=log.created_at,
        )
        for log in (emergency.agent_logs or [])
    ]

    return EmergencyResponse(
        id=str(emergency.id),
        short_id=emergency.short_id,
        status=emergency.status,
        severity=emergency.severity,
        medical_category=emergency.medical_category,
        ai_confidence_score=emergency.ai_confidence_score,
        estimated_eta_mins=emergency.estimated_eta_mins,
        fare_npr=emergency.fare_npr,
        vehicle_registration=vehicle_registration,
        hospital_name=hospital_name,
        hospital_address=hospital_address,
        hospital_phone=hospital_phone,
        hospital_lat=hospital_lat,
        hospital_lng=hospital_lng,
        patient_lat=emergency.patient_lat,
        patient_lng=emergency.patient_lng,
        tracking_ws_url=f"/ws/patient/{emergency.id}",
        agent_decisions=agent_decisions,
        created_at=emergency.created_at,
    )
