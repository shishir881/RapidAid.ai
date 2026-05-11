from typing import Set, Dict, Optional
from fastapi import WebSocket
import json


class ConnectionManager:
    """Manages WebSocket connections across 3 channels: patient, driver, hospital."""
    
    def __init__(self):
        # emergency_id -> Set of WebSocket connections
        self.patient_connections: Dict[str, Set[WebSocket]] = {}
        # vehicle_id -> Single WebSocket connection
        self.driver_connections: Dict[str, WebSocket] = {}
        # hospital_id -> Set of WebSocket connections
        self.hospital_connections: Dict[str, Set[WebSocket]] = {}

    # ===== Patient Channel =====
    async def connect_patient(self, emergency_id: str, websocket: WebSocket):
        await websocket.accept()
        if emergency_id not in self.patient_connections:
            self.patient_connections[emergency_id] = set()
        self.patient_connections[emergency_id].add(websocket)
        
        await websocket.send_json({
            "event": "CONNECTED",
            "message": f"Connected to patient tracking for {emergency_id}",
            "emergency_id": emergency_id
        })

    def disconnect_patient(self, emergency_id: str, websocket: WebSocket):
        if emergency_id in self.patient_connections:
            self.patient_connections[emergency_id].discard(websocket)
            if not self.patient_connections[emergency_id]:
                del self.patient_connections[emergency_id]

    async def broadcast_patient_vehicle_location(self, emergency_id: str, vehicle_lat: float, vehicle_lng: float, eta_minutes: int):
        """Broadcast vehicle location to all patients tracking this emergency."""
        if emergency_id in self.patient_connections:
            message = {
                "event": "VEHICLE_LOCATION",
                "vehicle_lat": vehicle_lat,
                "vehicle_lng": vehicle_lng,
                "eta_minutes": eta_minutes,
                "timestamp": __import__('datetime').datetime.utcnow().isoformat()
            }
            for websocket in self.patient_connections[emergency_id]:
                try:
                    await websocket.send_json(message)
                except Exception:
                    pass  # Client disconnected

    async def broadcast_patient_status_update(self, emergency_id: str, status: str):
        """Broadcast status update to patient."""
        if emergency_id in self.patient_connections:
            message = {
                "event": "STATUS_UPDATE",
                "status": status,
                "message": f"Emergency status updated to {status}",
                "timestamp": __import__('datetime').datetime.utcnow().isoformat()
            }
            for websocket in self.patient_connections[emergency_id]:
                try:
                    await websocket.send_json(message)
                except Exception:
                    pass

    # ===== Driver Channel =====
    async def connect_driver(self, vehicle_id: str, websocket: WebSocket):
        await websocket.accept()
        self.driver_connections[vehicle_id] = websocket
        
        await websocket.send_json({
            "event": "CONNECTED",
            "message": f"Connected as driver for vehicle {vehicle_id}",
            "vehicle_id": vehicle_id
        })

    def disconnect_driver(self, vehicle_id: str):
        if vehicle_id in self.driver_connections:
            del self.driver_connections[vehicle_id]

    async def send_driver_assignment(
        self,
        vehicle_id: str,
        emergency_id: str,
        emergency_short_id: str,
        patient_lat: float,
        patient_lng: float,
        patient_address: str,
        description: Optional[str],
        severity: str,
        hospital_name: Optional[str] = None,
        hospital_lat: Optional[float] = None,
        hospital_lng: Optional[float] = None,
    ):
        """Send emergency assignment to driver."""
        if vehicle_id in self.driver_connections:
            message = {
                "event": "ASSIGNMENT",
                "emergency_id": emergency_id,
                "short_id": emergency_short_id,
                "vehicle_id": vehicle_id,
                "patient_lat": patient_lat,
                "patient_lng": patient_lng,
                "patient_address": patient_address,
                "description": description,
                "hospital_name": hospital_name,
                "hospital_lat": hospital_lat,
                "hospital_lng": hospital_lng,
                "severity": severity,
                "status": "DISPATCHED",
                "message": f"🚨 Emergency {emergency_short_id} assigned to you",
                "timestamp": __import__('datetime').datetime.utcnow().isoformat()
            }
            try:
                await self.driver_connections[vehicle_id].send_json(message)
            except Exception:
                pass

    # ===== Hospital Channel =====
    async def connect_hospital(self, hospital_id: str, websocket: WebSocket):
        await websocket.accept()
        if hospital_id not in self.hospital_connections:
            self.hospital_connections[hospital_id] = set()
        self.hospital_connections[hospital_id].add(websocket)
        
        await websocket.send_json({
            "event": "CONNECTED",
            "message": f"Connected to hospital alerts for {hospital_id}",
            "hospital_id": hospital_id
        })

    def disconnect_hospital(self, hospital_id: str, websocket: WebSocket):
        if hospital_id in self.hospital_connections:
            self.hospital_connections[hospital_id].discard(websocket)
            if not self.hospital_connections[hospital_id]:
                del self.hospital_connections[hospital_id]

    async def broadcast_hospital_incoming_patient(self, hospital_id: str, emergency_short_id: str, severity: str, medical_category: str, eta_minutes: int, patient_lat: float, patient_lng: float):
        """Broadcast incoming patient alert to hospital."""
        if hospital_id in self.hospital_connections:
            message = {
                "event": "INCOMING_PATIENT",
                "severity": severity,
                "short_id": emergency_short_id,
                "medical_category": medical_category,
                "eta_minutes": eta_minutes,
                "patient_lat": patient_lat,
                "patient_lng": patient_lng,
                "message": f"🚨 INCOMING {severity} — ETA {eta_minutes} min",
                "timestamp": __import__('datetime').datetime.utcnow().isoformat()
            }
            for websocket in self.hospital_connections[hospital_id]:
                try:
                    await websocket.send_json(message)
                except Exception:
                    pass


# Global singleton
manager = ConnectionManager()
