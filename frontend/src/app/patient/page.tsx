'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import DynamicMap from '@/components/DynamicMap';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api } from '@/lib/api';
import { Phone, Navigation, Activity, AlertCircle, ChevronDown, ChevronUp, Loader2, CheckCircle, MapPin } from 'lucide-react';
import { PatientTrackingHud } from '@/components/patient/PatientTrackingHud';

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  IDLE:         { label: 'Ready', color: 'text-gray-400' },
  PENDING:      { label: '⏳ Connecting to dispatch...', color: 'text-yellow-400' },
  TRIAGED:      { label: '🧠 AI triage complete', color: 'text-blue-400' },
  DISPATCHED:   { label: '🚑 Ambulance is on the way!', color: 'text-amber-400' },
  EN_ROUTE:     { label: '🚑 Ambulance en route to you', color: 'text-amber-400' },
  ON_SCENE:     { label: '✅ Ambulance arrived at your location', color: 'text-green-400' },
  TRANSPORTING: { label: '🏥 Transporting to hospital', color: 'text-purple-400' },
  ARRIVED:      { label: '🏥 Arrived at hospital', color: 'text-green-400' },
  CLOSED:       { label: '✅ Case closed', color: 'text-green-500' },
  ERROR:        { label: '❌ Error — please call 102', color: 'text-red-400' },
};

const SEVERITY_COLORS: Record<string, string> = {
  P1_CRITICAL: 'text-red-500',
  P2_URGENT:   'text-orange-400',
  P3_MODERATE: 'text-yellow-400',
  P4_MINOR:    'text-blue-400',
};

export default function PatientPortal() {
  const [gps, setGps] = useState<[number, number]>([27.7172, 85.3240]);
  const [emergencyId, setEmergencyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('IDLE');
  const [ambulanceMarker, setAmbulanceMarker] = useState<[number, number] | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [hospitalInfo, setHospitalInfo] = useState<any>(null);
  const [lastAmbulanceUpdate, setLastAmbulanceUpdate] = useState<Date | null>(null);
  const [severity, setSeverity] = useState<string | null>(null);

  const [description, setDescription] = useState('');
  const [emergencyType, setEmergencyType] = useState<'CRITICAL_SOS' | 'MEDICAL_RIDE'>('CRITICAL_SOS');
  const [isTrackingExpanded, setIsTrackingExpanded] = useState(true);

  // WebSocket hook
  const { lastMessage, isConnected } = useWebSocket(emergencyId ? `/ws/patient/${emergencyId}` : null);

  useEffect(() => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setGps([pos.coords.latitude, pos.coords.longitude]),
        (err) => console.log('GPS error, using Kathmandu default', err),
        { timeout: 5000 }
      );
    }
  }, []);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event === 'VEHICLE_LOCATION') {
      setAmbulanceMarker([lastMessage.vehicle_lat, lastMessage.vehicle_lng]);
      setLastAmbulanceUpdate(new Date());
      if (lastMessage.eta_minutes != null) setEta(Number(lastMessage.eta_minutes));
    } else if (lastMessage.event === 'STATUS_UPDATE') {
      setStatus(lastMessage.status);
    }
  }, [lastMessage]);

  const handleSosTrigger = async () => {
    setStatus('PENDING');

    try {
      const payload: any = {
        patient_lat: gps[0],
        patient_lng: gps[1],
        emergency_type: emergencyType,
      };
      if (emergencyType === 'MEDICAL_RIDE' && description.trim()) {
        payload.description = description.trim();
      }

      const res = await api.post('/emergency/sos', payload);
      const data = res.data;

      setEmergencyId(data.id);
      setStatus(data.status);
      setSeverity(data.severity);
      if (data.estimated_eta_mins != null) setEta(data.estimated_eta_mins);
      if (data.hospital_name) {
        setHospitalInfo({
          name: data.hospital_name,
          address: data.hospital_address,
          phone: data.hospital_phone,
          lat: data.hospital_lat,
          lng: data.hospital_lng,
        });
      }
    } catch (err: any) {
      console.error('SOS Error:', err);
      setStatus('ERROR');
    }
  };

  const markers: any[] = [
    { id: 'patient', position: gps, title: 'You', color: 'blue' as any },
  ];
  if (ambulanceMarker) {
    markers.push({ id: 'ambulance', position: ambulanceMarker, title: 'Ambulance', color: 'amber' as any, icon: 'ambulance' });
  }
  if (hospitalInfo?.lat && hospitalInfo?.lng) {
    markers.push({ id: 'hospital', position: [hospitalInfo.lat, hospitalInfo.lng], title: hospitalInfo.name, color: 'green' as any });
  }

  const isActive = status !== 'IDLE' && status !== 'ERROR';
  const statusInfo = STATUS_LABELS[status] || { label: status, color: 'text-gray-300' };

  return (
    <div className="relative w-full h-screen bg-black text-white overflow-hidden">

      {/* ── Map Background ────────────────────────────────── */}
      <div className="absolute inset-0 z-0">
        <DynamicMap
          center={gps}
          zoom={15}
          markers={markers}
          route={ambulanceMarker ? { positions: [ambulanceMarker, gps], color: '#ef4444' } : undefined}
          fitBounds={
            ambulanceMarker &&
            Math.abs(gps[0] - ambulanceMarker[0]) + Math.abs(gps[1] - ambulanceMarker[1]) > 1e-9
              ? [gps, ambulanceMarker]
              : undefined
          }
          onMapClick={(lat, lng) => status === 'IDLE' && setGps([lat, lng])}
        />
      </div>

      {/* ── Header ───────────────────────────────────────── */}
      <div className="absolute top-0 left-0 w-full p-4 z-20 bg-gradient-to-b from-black/80 to-transparent">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="text-red-500" />
            <h1 className="font-bold text-xl">RapidAid Patient</h1>
          </div>
          {isActive && (
            <div className={`text-xs font-bold px-3 py-1 rounded-full bg-black/50 border border-gray-700 ${statusInfo.color}`}>
              {statusInfo.label}
            </div>
          )}
        </div>
        {/* GPS indicator */}
        <div className="flex items-center gap-1 mt-1 text-xs text-gray-500">
          <MapPin size={10} />
          <span className="font-mono">{gps[0].toFixed(4)}, {gps[1].toFixed(4)}</span>
          {status === 'IDLE' && <span className="ml-1 text-gray-600">· tap map to adjust</span>}
        </div>
      </div>

      {/* ── IDLE State: Description form + SOS Button ─────── */}
      <AnimatePresence>
        {status === 'IDLE' && (
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            className="absolute bottom-0 left-0 w-full z-20 p-4"
          >
            {/* Emergency type toggle */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setEmergencyType('CRITICAL_SOS')}
                className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all border ${
                  emergencyType === 'CRITICAL_SOS'
                    ? 'bg-red-600 border-red-500 text-white'
                    : 'bg-gray-900/80 border-gray-700 text-gray-400'
                }`}
              >
                🚨 Emergency SOS
              </button>
              <button
                onClick={() => setEmergencyType('MEDICAL_RIDE')}
                className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all border ${
                  emergencyType === 'MEDICAL_RIDE'
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-gray-900/80 border-gray-700 text-gray-400'
                }`}
              >
                🏥 Medical Ride
              </button>
            </div>

            {/* Conditional description for Medical Ride */}
            <AnimatePresence>
              {emergencyType === 'MEDICAL_RIDE' && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden mb-3"
                >
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe the reason for the medical ride (optional)"
                    rows={2}
                    className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* SOS Button */}
            <button
              onClick={handleSosTrigger}
              className={`relative w-full py-5 rounded-2xl font-black text-2xl tracking-widest text-white shadow-2xl transition-all ${
                emergencyType === 'CRITICAL_SOS'
                  ? 'bg-red-600 shadow-red-900/60 hover:bg-red-500 hover:shadow-red-800/80'
                  : 'bg-blue-600 shadow-blue-900/60 hover:bg-blue-500'
              }`}
            >
              <div className="absolute inset-0 rounded-2xl animate-ping bg-red-500 opacity-10" />
              {emergencyType === 'CRITICAL_SOS' ? '🆘 SEND SOS' : '🚐 BOOK RIDE'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── PENDING State ─────────────────────────────────── */}
      <AnimatePresence>
        {status === 'PENDING' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          >
            <div className="text-center">
              <Loader2 className="mx-auto text-red-500 animate-spin mb-4" size={64} />
              <h2 className="text-2xl font-black text-white">AI Dispatching...</h2>
              <p className="text-gray-400 mt-2 text-sm">Running 5-agent pipeline</p>
              <div className="mt-4 flex flex-col gap-1 text-xs text-gray-500">
                <span>🧠 TriageAgent scanning symptoms</span>
                <span>🏥 HospitalAgent selecting nearest ICU</span>
                <span>🚑 DispatchAgent assigning vehicle</span>
                <span>🗺️ RouteAgent calculating ETA</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Active Tracking Panel ─────────────────────────── */}
      <AnimatePresence>
        {isActive && status !== 'PENDING' && (
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            className="absolute bottom-0 left-0 w-full bg-gray-900/95 backdrop-blur-md border-t border-gray-800 rounded-t-3xl p-5 z-30 flex flex-col gap-4 shadow-[0_-20px_50px_rgba(0,0,0,0.5)]"
          >
            {/* Status + Severity row (Clickable to toggle) */}
            <div 
              className="flex justify-between items-center cursor-pointer"
              onClick={() => setIsTrackingExpanded(!isTrackingExpanded)}
            >
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                  Status {isTrackingExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </p>
                <p className={`font-bold text-lg ${statusInfo.color}`}>{statusInfo.label}</p>
              </div>
              {severity && (
                <div className={`px-3 py-1 rounded-lg border text-sm font-black ${SEVERITY_COLORS[severity] || 'text-gray-400'} border-current bg-current/10`}>
                  {severity.replace('_', ' ')}
                </div>
              )}
            </div>

            <AnimatePresence>
              {isTrackingExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden flex flex-col gap-4"
                >
                  <PatientTrackingHud
                    wsConnected={isConnected}
                    ambulanceLatLng={ambulanceMarker}
                    etaMinutes={eta}
                    lastUpdateAt={lastAmbulanceUpdate}
                  />

                  {/* Hospital info card */}
                  {hospitalInfo && (
                    <div className="pt-2">
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Destination Hospital</p>
                      <div className="bg-gray-800/80 rounded-xl p-4 border border-gray-700">
                        <div className="flex items-center gap-2 mb-1">
                          <CheckCircle size={16} className="text-green-500 shrink-0" />
                          <h4 className="font-bold text-white leading-tight">{hospitalInfo.name}</h4>
                        </div>
                        <p className="text-sm text-gray-400 mb-3 ml-6">{hospitalInfo.address}</p>
                        <a
                          href={`tel:${hospitalInfo.phone}`}
                          className="inline-flex items-center gap-2 bg-blue-600/20 border border-blue-600/40 text-blue-400 rounded-lg px-4 py-2 text-sm font-semibold hover:bg-blue-600/30 transition"
                        >
                          <Phone size={14} /> {hospitalInfo.phone}
                        </a>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Error state */}
            {status === 'ERROR' && (
              <div className="flex items-center gap-3 bg-red-900/30 border border-red-500/50 rounded-xl p-4">
                <AlertCircle className="text-red-500 shrink-0" size={24} />
                <div>
                  <p className="font-bold text-red-400">Dispatch failed</p>
                  <p className="text-sm text-gray-400">Please call <strong>102</strong> (Nepal Emergency)</p>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
