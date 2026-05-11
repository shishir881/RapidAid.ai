'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import DynamicMap from '@/components/DynamicMap';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api } from '@/lib/api';
import { Navigation, Car, AlertTriangle, CheckCircle, MapPin } from 'lucide-react';

export default function DriverPortal() {
  const [vehicleId, setVehicleId] = useState<string>('');
  const [vehicleData, setVehicleData] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  const [assignment, setAssignment] = useState<any>(null);
  const [currentStatus, setCurrentStatus] = useState<string>('IDLE');
  const [gps, setGps] = useState<[number, number]>([27.7172, 85.3240]);
  const [route, setRoute] = useState<any>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const gpsRef = useRef<[number, number]>(gps);
  useEffect(() => {
    gpsRef.current = gps;
  }, [gps]);
  
  const { lastMessage, sendMessage, isConnected } = useWebSocket(vehicleId ? `/ws/driver/${vehicleId}` : null);

  const routeTarget = useMemo(() => {
    if (!assignment) return null;
    if (currentStatus === 'DISPATCHED' || currentStatus === 'EN_ROUTE') {
      return {
        label: 'Route to patient',
        to: [assignment.patient_lat, assignment.patient_lng] as [number, number],
        description: assignment.patient_address || 'Patient location',
      };
    }
    if ((currentStatus === 'ON_SCENE' || currentStatus === 'TRANSPORTING') && assignment.hospital_lat && assignment.hospital_lng) {
      return {
        label: 'Route to hospital',
        to: [assignment.hospital_lat, assignment.hospital_lng] as [number, number],
        description: assignment.hospital_name || 'Hospital',
      };
    }
    return null;
  }, [assignment, currentStatus]);

  // Fit entire route when we have geometry; otherwise driver + destination. Avoids "static" map stuck on one point.
  const mapFitPoints = useMemo(() => {
    if (route?.positions?.length >= 2) {
      return route.positions as [number, number][];
    }
    if (routeTarget) {
      return [gps, routeTarget.to];
    }
    return undefined;
  }, [route?.positions, gps, routeTarget]);

  const [allVehicles, setAllVehicles] = useState<any[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  const loadDriverContext = async () => {
    setLoadError(null);
    try {
      const res = await api.get('/vehicles/');
      const vehicles = res.data;
      if (!vehicles || vehicles.length === 0) {
        setLoadError('No vehicles found in backend. Seed demo data or add vehicles.');
        return;
      }
      setAllVehicles(vehicles);
      setShowPicker(true); // Show picker instead of auto-selecting
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.response?.data?.detail ||
        err?.message ||
        'Failed to load driver profile (backend unreachable).';
      setLoadError(String(msg));
    }
  };

  const selectVehicle = async (vehicle: any) => {
    setShowPicker(false);
    setVehicleId(vehicle.id);
    setVehicleData(vehicle);
    if (vehicle.current_lat && vehicle.current_lng) {
      setGps([vehicle.current_lat, vehicle.current_lng]);
    }
    try {
      const assignmentRes = await api.get(`/vehicles/${vehicle.id}/assignment`);
      if (assignmentRes.data) {
        setAssignment(assignmentRes.data);
        setCurrentStatus(assignmentRes.data.status);
      } else {
        setAssignment(null);
        setCurrentStatus('IDLE');
      }
    } catch (e) {
      console.error('Failed to fetch assignment', e);
    }
  };

  // Fetch TIER_1 vehicle on mount for demo purposes
  useEffect(() => {
    loadDriverContext();
  }, []);

  // Listen to WS
  useEffect(() => {
    if (lastMessage && lastMessage.event === 'ASSIGNMENT') {
      const alertAudio = new Audio('https://actions.google.com/sounds/v1/alarms/digital_watch_alarm_long.ogg');
      alertAudio.play().catch(() => {});
      
      setAssignment(lastMessage);
      setCurrentStatus(lastMessage.status || 'DISPATCHED');
    }
  }, [lastMessage]);

  useEffect(() => {
    if (!routeTarget || !vehicleId) {
      setRoute(null);
      setRouteError(null);
      return;
    }

    let active = true;
    setRouteLoading(true);
    setRouteError(null);

    api.get('/navigation/route', {
      params: {
        from_lat: gps[0],
        from_lng: gps[1],
        to_lat: routeTarget.to[0],
        to_lng: routeTarget.to[1],
      },
    }).then(res => {
      if (!active) return;
      setRoute({ ...res.data, label: routeTarget.label, description: routeTarget.description });
    }).catch(err => {
      console.error('Navigation load failed', err);
      if (!active) return;
      setRoute(null);
      setRouteError('Unable to load directions.');
    }).finally(() => {
      if (!active) return;
      setRouteLoading(false);
    });

    return () => {
      active = false;
    };
  }, [gps, routeTarget, vehicleId]);

  useEffect(() => {
    if (!route || !route.instructions || route.instructions.length === 0) {
      setCurrentStepIndex(0);
      return;
    }

    for (let i = 0; i < route.instructions.length; i++) {
      const pos = route.instructions[i]?.position as [number, number] | null | undefined;
      if (!pos) continue;
      // Approx meters using degrees to meters conversion (~111km per degree latitude)
      const distanceToGpsM =
        Math.sqrt(Math.pow((gps[0] - pos[0]) * 111, 2) + Math.pow((gps[1] - pos[1]) * 111, 2)) * 1000;

      if (distanceToGpsM < 50) {
        setCurrentStepIndex(i);
        return;
      }
    }
  }, [gps, route]);

  // GPS pings for patient live tracking — must not depend on WebSocket (WS can be offline).
  useEffect(() => {
    if (!vehicleId) return;

    const tick = () => {
      const p = gpsRef.current;
      api.patch(`/vehicles/${vehicleId}/location`, { lat: p[0], lng: p[1] }).catch((err) =>
        console.error('GPS Update Failed', err),
      );
    };

    tick();
    const interval = setInterval(tick, 5000);
    return () => clearInterval(interval);
  }, [vehicleId]);

  const updateEmergencyStatus = async (status: string) => {
    if (!assignment?.short_id) return;
    try {
      // Backend accepts short_id or uuid; use short_id for consistency across WS + HTTP.
      await api.patch(`/emergency/${assignment.short_id}/status?status=${status}`);
      setCurrentStatus(status);
      if (status === 'ARRIVED' || status === 'CLOSED') {
        setAssignment(null);
        setCurrentStatus('IDLE');
      }
    } catch (err) {
      console.error(err);
      alert("Failed to update status");
    }
  };

  const getActionButtons = () => {
    switch (currentStatus) {
      case 'DISPATCHED':
        return (
          <button onClick={() => updateEmergencyStatus('EN_ROUTE')} className="w-full py-4 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-xl text-lg flex items-center justify-center gap-2">
            <Car /> Start Route
          </button>
        );
      case 'EN_ROUTE':
        return (
          <button onClick={() => updateEmergencyStatus('ON_SCENE')} className="w-full py-4 bg-blue-500 hover:bg-blue-400 text-white font-bold rounded-xl text-lg flex items-center justify-center gap-2">
            <MapPin /> Arrived at Scene
          </button>
        );
      case 'ON_SCENE':
        return (
          <button onClick={() => updateEmergencyStatus('TRANSPORTING')} className="w-full py-4 bg-purple-500 hover:bg-purple-400 text-white font-bold rounded-xl text-lg flex items-center justify-center gap-2">
            <Car /> Transporting Patient
          </button>
        );
      case 'TRANSPORTING':
        return (
          <button onClick={() => updateEmergencyStatus('ARRIVED')} className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-white font-bold rounded-xl text-lg flex items-center justify-center gap-2">
            <CheckCircle /> Arrived at Hospital
          </button>
        );
      default:
        return null;
    }
  };

  // Vehicle picker screen
  if (showPicker && allVehicles.length > 0) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="max-w-lg w-full">
          <div className="text-center mb-8">
            <Navigation className="text-amber-500 mx-auto mb-3" size={40} />
            <h1 className="text-3xl font-black">Driver Shift Login (Demo)</h1>
            <p className="text-gray-500 mt-2 text-sm">Select your driver profile to begin</p>
          </div>
          <div className="flex flex-col gap-3">
            {allVehicles.map((v: any) => (
              <button
                key={v.id}
                onClick={() => selectVehicle(v)}
                className="w-full text-left bg-gray-900 hover:bg-gray-800 border border-gray-800 hover:border-amber-500/50 rounded-2xl p-5 transition-all group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-lg font-black border ${
                      v.tier === 'TIER_1'
                        ? 'bg-red-900/30 border-red-500/50 text-red-400'
                        : 'bg-blue-900/30 border-blue-500/50 text-blue-400'
                    }`}>
                      {v.tier === 'TIER_1' ? 'T1' : 'T2'}
                    </div>
                    <div>
                      <p className="font-black text-lg text-white group-hover:text-amber-400 transition-colors">
                        {v.driver_name || 'Unassigned Driver'}
                      </p>
                      <p className="text-gray-500 text-sm">Vehicle: {v.registration}</p>
                    </div>
                  </div>
                  <div className={`px-3 py-1 rounded-full text-xs font-bold border ${
                    v.is_available
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-red-500/10 border-red-500/30 text-red-400'
                  }`}>
                    {v.is_available ? 'Available' : 'On Dispatch'}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!vehicleData) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <Navigation className="text-amber-500 mx-auto mb-3 animate-pulse" size={40} />
          <div className="text-xl font-bold">Driver Portal</div>
          {loadError ? (
            <>
              <div className="mt-3 text-sm text-rose-300">{loadError}</div>
              <button
                onClick={loadDriverContext}
                className="mt-5 w-full py-3 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-xl"
              >
                Retry
              </button>
              <div className="mt-3 text-xs text-slate-400">
                Make sure backend is running and `NEXT_PUBLIC_API_URL` points to it.
              </div>
            </>
          ) : (
            <div className="mt-3 text-sm text-slate-300">Loading Driver Profile...</div>
          )}
        </div>
      </div>
    );
  }


  const markers: any[] = [{ id: 'driver', position: gps, title: 'You', color: 'blue' as any }];
  if (assignment) {
    markers.push({
      id: 'patient',
      position: [assignment.patient_lat, assignment.patient_lng],
      title: 'Patient Location',
      description: assignment.patient_address,
      color: 'red' as any
    });
    if (assignment.hospital_lat && assignment.hospital_lng) {
      markers.push({
        id: 'hospital',
        position: [assignment.hospital_lat, assignment.hospital_lng],
        title: assignment.hospital_name || 'Hospital',
        description: assignment.hospital_address,
        color: 'green' as any
      });
    }
  }

  return (
    <div className="relative w-full h-screen bg-black text-white overflow-hidden flex flex-col">
      
      {/* Header Overlay */}
      <div className="absolute top-0 left-0 w-full p-4 z-20 bg-gradient-to-b from-black/80 to-transparent">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Navigation className="text-amber-500" />
            <h1 className="font-bold text-xl">{vehicleData.registration}</h1>
          </div>
          <div className={`px-3 py-1 rounded-full text-xs font-bold ${isConnected ? 'bg-emerald-500/20 text-emerald-500' : 'bg-red-500/20 text-red-500'}`}>
            {isConnected ? 'ONLINE' : 'OFFLINE'}
          </div>
        </div>
      </div>

      {routeTarget && (
        <div className="absolute top-20 left-0 w-full px-4 z-30">
          <div className="bg-slate-950/90 backdrop-blur-xl rounded-3xl border border-slate-800 p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-4 mb-3">
              <div>
                <p className="text-xs uppercase tracking-[0.35em] text-slate-400">{route?.label ?? routeTarget.label}</p>
                <p className="text-white font-semibold text-lg">{route?.description ?? routeTarget.description}</p>
              </div>
              <div className="text-right">
                {route ? (
                  <>
                    <p className="text-sm text-slate-400">{(route.distance_m / 1000).toFixed(1)} km</p>
                    <p className="text-sm text-slate-400">{Math.ceil(route.duration_s / 60)} min</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-slate-500">— km</p>
                    <p className="text-sm text-slate-500">— min</p>
                  </>
                )}
              </div>
            </div>
            {routeLoading ? (
              <p className="text-sm text-slate-300">Loading navigation...</p>
            ) : routeError ? (
              <p className="text-sm text-rose-300">{routeError}</p>
            ) : route?.instructions && route.instructions.length > 0 ? (
              <div className="space-y-0">
                {currentStepIndex > 0 && (
                  <p className="text-xs text-slate-400 mb-2">
                    {currentStepIndex} of {route.instructions.length} steps completed
                  </p>
                )}
                {route.instructions.slice(currentStepIndex, currentStepIndex + 2).map((step: any, index: number) => {
                  const isActive = index === 0;
                  return (
                    <div
                      key={currentStepIndex + index}
                      className={`p-3 rounded-lg transition ${
                        isActive
                          ? 'bg-amber-900/30 border border-amber-500 text-amber-100'
                          : 'text-slate-300'
                      }`}
                    >
                      <div className="flex gap-2 items-start">
                        {isActive && (
                          <span className="text-amber-400 font-bold text-lg mt-0.5">➤</span>
                        )}
                        <div className="flex-1">
                          <p className={`text-sm ${isActive ? 'font-semibold' : ''}`}>
                            {step.text}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {(step.distance_m / 1000).toFixed(2)} km · {Math.ceil(step.duration_s / 60)} min
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-slate-400">No turn-by-turn steps available.</p>
            )}
          </div>
        </div>
      )}

      {/* Map Area */}
      <div className="flex-1 relative z-0">
        <DynamicMap
          center={gps}
          zoom={15}
          markers={markers}
          route={route?.positions ? { positions: route.positions, color: currentStatus === 'TRANSPORTING' ? '#a855f7' : '#10b981' } : undefined}
          fitBounds={mapFitPoints}
          onMapClick={(lat, lng) => currentStatus === 'IDLE' && setGps([lat, lng])}
        />
      </div>

      {/* Assignment Modal (Pops up when assigned) */}
      <AnimatePresence>
        {assignment && currentStatus === 'DISPATCHED' && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            className="absolute inset-0 z-50 flex items-end bg-black/60 backdrop-blur-sm"
          >
            <div className="bg-gray-900 w-full rounded-t-3xl p-6 border-t border-red-500/50 shadow-[0_-20px_50px_rgba(220,38,38,0.2)]">
              <div className="flex items-center justify-center w-16 h-16 bg-red-500/20 rounded-full mx-auto mb-4 border border-red-500">
                <AlertTriangle className="text-red-500" size={32} />
              </div>
              <h2 className="text-3xl font-black text-center mb-2 uppercase text-white">New Assignment</h2>
              
              <div className="bg-black rounded-xl p-4 my-6 border border-gray-800">
                <p className="text-red-500 font-bold mb-1">Severity: {assignment.severity}</p>
                <p className="text-gray-300">ID: {assignment.short_id}</p>
                <p className="text-gray-300 mt-2 line-clamp-2">Loc: {assignment.patient_address || 'Unknown'}</p>
                {assignment.description && (
                  <p className="text-amber-400 mt-2 text-sm italic border-l-2 border-amber-500 pl-2">
                    "{assignment.description}"
                  </p>
                )}
              </div>

              {getActionButtons()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Persistent Bottom Bar (when active) */}
      <AnimatePresence>
        {assignment && currentStatus !== 'DISPATCHED' && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            className="absolute bottom-0 left-0 w-full z-30 p-4"
          >
            <div className="bg-gray-900/95 backdrop-blur-md rounded-2xl p-4 border border-gray-800 shadow-2xl">
              <div className="flex justify-between items-center mb-4">
                <div>
                  <p className="text-sm text-gray-400">Current Task</p>
                  <p className="font-bold text-amber-500 text-lg">{currentStatus.replace('_', ' ')}</p>
                </div>
                <div className="bg-red-500/20 px-3 py-1 rounded text-red-500 font-bold border border-red-500/20">
                  {assignment.severity}
                </div>
              </div>
              
              {assignment.description && (
                <div className="mb-4 text-sm text-amber-400 italic bg-amber-900/20 p-2 rounded-lg border border-amber-900/50">
                  "{assignment.description}"
                </div>
              )}
              
              {getActionButtons()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Idle State Banner */}
      <AnimatePresence>
        {!assignment && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            className="absolute bottom-0 left-0 w-full z-30 p-4"
          >
            <div className="bg-gray-900 rounded-2xl p-6 text-center border border-gray-800">
              <Car className="mx-auto text-gray-500 mb-2" size={32} />
              <h3 className="font-bold text-xl text-white">Idle & Available</h3>
              <p className="text-gray-400 text-sm mt-1">Waiting for autonomous dispatch...</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
