'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api } from '@/lib/api';
import {
  AlertTriangle, CheckCircle, Clock, Activity, Settings2,
  ChevronDown, Hospital, Droplets, Scissors
} from 'lucide-react';

const SEVERITY_BG: Record<string, string> = {
  P1_CRITICAL: 'bg-red-900/30 border-red-500/60 text-red-400',
  P2_URGENT:   'bg-orange-900/30 border-orange-500/60 text-orange-400',
  P3_MODERATE: 'bg-yellow-900/30 border-yellow-500/60 text-yellow-400',
  P4_MINOR:    'bg-blue-900/30 border-blue-500/60 text-blue-400',
};

export default function HospitalPortal() {
  const [hospitals, setHospitals] = useState<any[]>([]);
  const [hospitalId, setHospitalId] = useState<string>('');
  const [hospitalData, setHospitalData] = useState<any>(null);
  const [queue, setQueue] = useState<any[]>([]);
  const [flashAlert, setFlashAlert] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const { lastMessage, isConnected } = useWebSocket(hospitalId ? `/ws/hospital/${hospitalId}` : null);

  // Fetch all hospitals on mount
  useEffect(() => {
    api.get('/hospitals/').then(res => {
      const list = res.data;
      setHospitals(list);
      // Default: auto-select TUTH or first
      const tuth = list.find((h: any) => h.name.includes('Teaching Hospital') || h.name.includes('TUTH'));
      const defaultHospital = tuth || list[0];
      if (defaultHospital) {
        setHospitalId(defaultHospital.id);
        setHospitalData(defaultHospital);
      }
      setLoading(false);
    }).catch(err => {
      console.error(err);
      setLoading(false);
    });
  }, []);

  // When hospital changes from dropdown, refresh data
  const selectHospital = (id: string) => {
    const h = hospitals.find(h => h.id === id);
    if (h) {
      setHospitalId(h.id);
      setHospitalData(h);
      setQueue([]); // Clear queue when switching
    }
  };

  // WebSocket incoming patient events
  useEffect(() => {
    if (lastMessage?.event === 'INCOMING_PATIENT') {
      try {
        const alertAudio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');
        alertAudio.play().catch(() => {});
      } catch {}
      setFlashAlert(lastMessage);
      setQueue(prev => [{ ...lastMessage, receivedAt: new Date().toLocaleTimeString() }, ...prev]);
      setTimeout(() => setFlashAlert(null), 10000);
    }
  }, [lastMessage]);

  const toggleStatus = async (field: 'icu_status' | 'er_status') => {
    if (!hospitalData) return;
    const current = hospitalData[field];
    const next = current === 'OPEN' ? 'FULL' : 'OPEN';
    try {
      await api.patch(`/hospitals/${hospitalId}/status`, { [field]: next });
      setHospitalData({ ...hospitalData, [field]: next });
    } catch (err) {
      console.error(err);
      alert('Failed to update status');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <Activity className="animate-pulse text-blue-500 mx-auto mb-3" size={40} />
          <p className="text-gray-400">Loading hospital network...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-black text-white">

      {/* ── Flash Alert Overlay ──────────────────────────── */}
      <AnimatePresence>
        {flashAlert && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-red-950/95 backdrop-blur-sm"
          >
            <motion.div
              animate={{ scale: [1, 1.02, 1] }}
              transition={{ repeat: Infinity, duration: 0.9 }}
              className="bg-black border-4 border-red-500 rounded-3xl p-10 max-w-2xl w-full mx-4 text-center shadow-[0_0_80px_rgba(239,68,68,0.4)]"
            >
              <AlertTriangle size={80} className="mx-auto text-red-500 mb-4 animate-pulse" />
              <h1 className="text-5xl font-black text-white mb-1 uppercase tracking-wider">⚠ Incoming</h1>
              <h2 className="text-2xl font-bold text-red-400 mb-6">Patient Alert</h2>

              <div className={`rounded-2xl p-6 text-left mb-6 border ${SEVERITY_BG[flashAlert.severity] || 'bg-gray-900 border-gray-700 text-gray-300'}`}>
                <p className="text-3xl font-black mb-1">{flashAlert.severity?.replace('_', ' ')}</p>
                <p className="text-xl text-gray-300 mb-1">Category: <strong>{flashAlert.medical_category}</strong></p>
                <p className="text-lg text-gray-400">Case ID: {flashAlert.short_id}</p>
                <p className="text-4xl font-black text-amber-400 mt-4 flex items-center gap-3">
                  <Clock size={32} />
                  ETA: {flashAlert.eta_minutes} min
                </p>
              </div>

              <button
                onClick={() => setFlashAlert(null)}
                className="bg-red-600 hover:bg-red-500 text-white font-black py-4 px-12 rounded-2xl text-xl w-full transition-colors"
              >
                ACKNOWLEDGE
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="max-w-5xl mx-auto p-6 pt-8">

        {/* ── Header + Hospital Selector ───────────────────── */}
        <header className="mb-8">
          <div className="flex items-center justify-between flex-wrap gap-4 mb-4">
            <div className="flex items-center gap-3">
              <Hospital className="text-blue-500" size={32} />
              <div>
                <h1 className="text-3xl font-bold">{hospitalData?.name || 'Hospital Portal'}</h1>
                <p className="text-gray-500 text-sm mt-0.5">Capacity Management & Incoming Alerts</p>
              </div>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border ${isConnected ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              {isConnected ? 'Alert System Live' : 'Disconnected'}
            </div>
          </div>

          {/* Hospital selector */}
          {hospitals.length > 1 && (
            <div className="relative">
              <select
                value={hospitalId}
                onChange={e => selectHospital(e.target.value)}
                className="w-full appearance-none bg-gray-900 border border-gray-700 text-white rounded-xl px-4 py-3 pr-10 text-sm focus:outline-none focus:border-blue-500 cursor-pointer"
              >
                {hospitals.map((h: any) => (
                  <option key={h.id} value={h.id}>{h.name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={18} />
            </div>
          )}
        </header>

        {/* ── ICU + ER Toggle Buttons ──────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
          {/* ICU */}
          <button
            onClick={() => toggleStatus('icu_status')}
            className={`relative overflow-hidden p-8 rounded-3xl border-2 transition-all text-left group ${
              hospitalData?.icu_status === 'OPEN'
                ? 'bg-blue-900/20 border-blue-500/50 hover:bg-blue-900/30'
                : 'bg-red-900/20 border-red-500/50 hover:bg-red-900/30'
            }`}
          >
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs uppercase tracking-widest text-gray-500 mb-2">ICU Capacity</p>
                <h2 className={`text-5xl font-black mb-2 ${hospitalData?.icu_status === 'OPEN' ? 'text-blue-400' : 'text-red-400'}`}>
                  {hospitalData?.icu_status === 'OPEN' ? 'OPEN' : 'FULL'}
                </h2>
                <p className="text-gray-500 text-sm">Tap to toggle instantly</p>
              </div>
              {hospitalData?.icu_status === 'OPEN'
                ? <CheckCircle size={52} className="text-blue-500 opacity-80" />
                : <AlertTriangle size={52} className="text-red-500 animate-pulse" />
              }
            </div>
          </button>

          {/* ER */}
          <button
            onClick={() => toggleStatus('er_status')}
            className={`relative overflow-hidden p-8 rounded-3xl border-2 transition-all text-left group ${
              hospitalData?.er_status === 'OPEN'
                ? 'bg-emerald-900/20 border-emerald-500/50 hover:bg-emerald-900/30'
                : 'bg-red-900/20 border-red-500/50 hover:bg-red-900/30'
            }`}
          >
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs uppercase tracking-widest text-gray-500 mb-2">Emergency Room</p>
                <h2 className={`text-5xl font-black mb-2 ${hospitalData?.er_status === 'OPEN' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {hospitalData?.er_status === 'OPEN' ? 'OPEN' : 'FULL'}
                </h2>
                <p className="text-gray-500 text-sm">Tap to toggle instantly</p>
              </div>
              {hospitalData?.er_status === 'OPEN'
                ? <CheckCircle size={52} className="text-emerald-500 opacity-80" />
                : <AlertTriangle size={52} className="text-red-500 animate-pulse" />
              }
            </div>
          </button>
        </div>

        {/* ── Hospital Details Row ─────────────────────────── */}
        {hospitalData && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-3">
              <Droplets className={hospitalData.blood_bank ? 'text-red-400' : 'text-gray-600'} size={20} />
              <div>
                <p className="text-xs text-gray-500">Blood Bank</p>
                <p className={`font-bold text-sm ${hospitalData.blood_bank ? 'text-red-400' : 'text-gray-600'}`}>
                  {hospitalData.blood_bank ? 'Available' : 'None'}
                </p>
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-3">
              <Scissors className={hospitalData.operating_room ? 'text-purple-400' : 'text-gray-600'} size={20} />
              <div>
                <p className="text-xs text-gray-500">Operating Room</p>
                <p className={`font-bold text-sm ${hospitalData.operating_room ? 'text-purple-400' : 'text-gray-600'}`}>
                  {hospitalData.operating_room ? 'Ready' : 'Unavailable'}
                </p>
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 col-span-2">
              <p className="text-xs text-gray-500 mb-2">Specializations</p>
              <div className="flex flex-wrap gap-1.5">
                {(hospitalData.specializations || []).map((s: string) => (
                  <span key={s} className="px-2 py-0.5 bg-blue-900/40 border border-blue-700/40 text-blue-300 text-xs rounded-full font-medium">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Incoming Queue ───────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-xl font-bold flex items-center gap-2">
              <Activity className="text-gray-400" />
              Incoming Queue
            </h3>
            {queue.length > 0 && (
              <span className="bg-red-500/20 border border-red-500/30 text-red-400 text-xs font-bold px-3 py-1 rounded-full">
                {queue.length} incoming
              </span>
            )}
          </div>

          {queue.length === 0 ? (
            <div className="bg-gray-900/50 border border-dashed border-gray-800 rounded-2xl p-12 text-center">
              <CheckCircle className="mx-auto text-gray-700 mb-3" size={40} />
              <p className="text-gray-600">No incoming patients at the moment.</p>
              <p className="text-gray-700 text-sm mt-1">Alerts will appear here via WebSocket when an SOS is dispatched to this hospital.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {queue.map((q, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4"
                >
                  <div className="flex items-center gap-4">
                    <div className={`px-3 py-2 rounded-xl border text-sm font-black ${SEVERITY_BG[q.severity] || 'bg-gray-800 border-gray-700 text-gray-400'}`}>
                      {q.severity?.replace('_', ' ')}
                    </div>
                    <div>
                      <p className="font-bold text-lg text-white">{q.medical_category}</p>
                      <p className="text-gray-500 text-sm">Case {q.short_id}</p>
                      {q.receivedAt && <p className="text-gray-600 text-xs mt-0.5">Received {q.receivedAt}</p>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-gray-500 mb-1">Estimated Arrival</p>
                    <p className="font-black text-2xl text-amber-400 flex items-center gap-1">
                      <Clock size={18} /> {q.eta_minutes} min
                    </p>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
