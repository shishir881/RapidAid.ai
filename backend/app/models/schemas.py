from pydantic import BaseModel, Field, field_validator
from typing import Optional, List
from datetime import datetime
from app.models.db_models import (
    UserRole, VehicleTier, SeverityLevel,
    EmergencyType, EmergencyStatus, HospitalStatus
)
import re


# ─────────────────────────── Validators ──────────────────────────────────────

PHONE_RE = re.compile(r"^\+?[\d\s\-]{7,20}$")


# ─────────────────────────── SOS / Emergency ─────────────────────────────────

class SOSRequest(BaseModel):
    # Core location fields — always required
    patient_lat:     float = Field(..., ge=-90, le=90, description="Patient latitude")
    patient_lng:     float = Field(..., ge=-180, le=180, description="Patient longitude")
    emergency_type:  EmergencyType = EmergencyType.CRITICAL_SOS

    # Optional context — used by TriageAgent keyword scan
    description:     Optional[str] = Field(None, max_length=2000, description="Voice-to-text or typed description of the emergency")
    patient_address: Optional[str] = Field(None, max_length=300, description="Human-readable address of patient")
    patient_name:    Optional[str] = Field("Anonymous", max_length=100)
    patient_phone:   Optional[str] = Field(None, max_length=20)
    image_url:       Optional[str] = Field(None, max_length=500, description="Image URL for Phase 2 YOLO inference")


class AgentDecisionResponse(BaseModel):
    agent_name:  str
    decision:    str
    reasoning:   str
    confidence:  float
    created_at:  datetime

    class Config:
        from_attributes = True


class EmergencyResponse(BaseModel):
    # BUG FIX: id is stored as str(uuid) in DB — use str not UUID
    id:                   str
    short_id:             str
    status:               EmergencyStatus
    severity:             Optional[SeverityLevel] = None
    medical_category:     Optional[str] = None
    ai_confidence_score:  Optional[float] = None
    estimated_eta_mins:   Optional[int] = None
    fare_npr:             Optional[float] = None
    vehicle_registration: Optional[str] = None
    hospital_name:        Optional[str] = None
    hospital_address:     Optional[str] = None
    hospital_phone:       Optional[str] = None
    hospital_lat:         Optional[float] = None
    hospital_lng:         Optional[float] = None
    patient_lat:          Optional[float] = None
    patient_lng:          Optional[float] = None
    tracking_ws_url:      Optional[str] = None
    agent_decisions:      List[AgentDecisionResponse] = []
    created_at:           datetime

    class Config:
        from_attributes = True


class EmergencyListItem(BaseModel):
    """Lightweight emergency for list/paginated views."""
    id:               str
    short_id:         str
    status:           EmergencyStatus
    severity:         Optional[SeverityLevel] = None
    medical_category: Optional[str] = None
    hospital_name:    Optional[str] = None
    vehicle_reg:      Optional[str] = None
    eta_mins:         Optional[int] = None
    created_at:       datetime

    class Config:
        from_attributes = True


class EmergencyStatusUpdate(BaseModel):
    status: EmergencyStatus


# ─────────────────────────── Hospital ────────────────────────────────────────

class HospitalStatusUpdate(BaseModel):
    icu_status:      Optional[HospitalStatus] = None
    er_status:       Optional[HospitalStatus] = None
    blood_bank:      Optional[bool] = None
    operating_room:  Optional[bool] = None


# ─────────────────────────── Vehicle ─────────────────────────────────────────

class VehicleLocationUpdate(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


class VehicleAvailabilityUpdate(BaseModel):
    is_available: bool


# ─────────────────────────── Dashboard ───────────────────────────────────────

class DashboardStats(BaseModel):
    active_emergencies:        int
    available_vehicles:        int
    hospitals_at_capacity:     int
    avg_response_time_mins:    float
    total_emergencies_today:   int


class AgentPerformanceStats(BaseModel):
    agent_name:       str
    total_decisions:  int
    avg_confidence:   float
    min_confidence:   float
    max_confidence:   float


class LiveFeedEvent(BaseModel):
    short_id:         str
    status:           str
    severity:         Optional[str]
    medical_category: Optional[str]
    hospital_name:    Optional[str]
    created_at:       datetime
