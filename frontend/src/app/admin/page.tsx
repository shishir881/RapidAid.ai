'use client';

import { useState, useEffect } from 'react';
import DynamicMap from '@/components/DynamicMap';
import { api } from '@/lib/api';
import {
  Activity, LayoutDashboard, Ambulance, Hospital as HospitalIcon,
  Clock, HeartPulse, BarChart3, Radio, ChevronRight,
  AlertTriangle, TrendingUp, CalendarDays
} from 'lucide-react';

const SEVERITY_DOT: Record<string, string> = {
  P1_CRITICAL: 'bg-red-500',
  P2_URGENT:   'bg-orange-400',
  P3_MODERATE: 'bg-yellow-400',
  P4_MINOR:    'bg-blue-400',
};

const STATUS_COLOR: Record<string, string> = {
  PENDING:      'text-yellow-400',
  TRIAGED:      'text-blue-400',
  DISPATCHED:   'text-amber-400',
  EN_ROUTE:     'text-amber-400',
  ON_SCENE:     'text-green-400',
  TRANSPORTING: 'text-purple-400',
  ARRIVED:      'text-green-500',
  CLOSED:       'text-gray-500',
};

type Tab = 'map' | 'feed' | 'agents';

export default function AdminDashboard() {
  const [stats, setStats]       = useState<any>(null);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [hospitals, setHospitals] = useState<any[]>([]);
  const [liveFeed, setLiveFeed] = useState<any[]>([]);
  const [agentStats, setAgentStats] = useState<any[]>([]);
  const [tab, setTab] = useState<Tab>('map');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = async () => {
    try {
      const [statsRes, vehiclesRes, hospitalsRes, feedRes, agentRes] = await Promise.all([
        api.get('/dashboard/stats'),
        api.get('/vehicles/'),
        api.get('/hospitals/'),
        api.get('/dashboard/live-feed'),
        api.get('/dashboard/agent-performance'),
      ]);
      setStats(statsRes.data);
      setVehicles(vehiclesRes.data);
      setHospitals(hospitalsRes.data);
      setLiveFeed(feedRes.data);
      setAgentStats(agentRes.data);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Failed to fetch dashboard data', err);
    }
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, []);

  const mapMarkers = [
    ...vehicles.filter(v => v.current_lat && v.current_lng).map(v => ({
      id: `vehicle-${v.id}`,
      position: [v.current_lat, v.current_lng] as [number, number],
      title: v.registration,
      description: `Driver: ${v.driver_name}\nStatus: ${v.is_available ? 'Available' : 'Dispatched'}`,
      color: v.is_available ? 'green' : 'red' as any,
    })),
    ...hospitals.map(h => ({
      id: `hospital-${h.id}`,
      position: [h.lat, h.lng] as [number, number],
      title: h.name,
      description: `ICU: ${h.icu_status} | ER: ${h.er_status}`,
      color: 'blue' as any,
    })),
  ];

  const STAT_CARDS = [
    {
      label: 'Active Emergencies',
      value: stats?.active_emergencies ?? '—',
      icon: Activity,
      color: 'text-red-500',
      bg: 'bg-red-500/10',
    },
    {
      label: 'Available Vehicles',
      value: stats?.available_vehicles ?? '—',
      icon: Ambulance,
      color: 'text-emerald-500',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'Avg Response Time',
      value: stats?.avg_response_time_mins ? `${stats.avg_response_time_mins.toFixed(1)}m` : '—',
      icon: Clock,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
    },
    {
      label: 'Hospitals at Capacity',
      value: stats?.hospitals_at_capacity ?? '—',
      icon: HospitalIcon,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
    },
    {
      label: 'Total Today',
      value: stats?.total_emergencies_today ?? '—',
      icon: CalendarDays,
      color: 'text-purple-400',
      bg: 'bg-purple-500/10',
    },
  ];

  return (
    <div className="min-h-screen bg-black text-white p-4 sm:p-6">

      {/* ── Header ───────────────────────────────────────── */}
      <header className="flex items-center justify-between mb-6 pb-4 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <LayoutDashboard className="text-emerald-500" size={28} />
          <div>
            <h1 className="text-2xl font-bold">Command Center</h1>
            <p className="text-gray-600 text-xs mt-0.5">RapidAid.ai — Autonomous Dispatch Network</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-gray-600">
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold">
            <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
            LIVE
          </div>
        </div>
      </header>

      {/* ── Stats Grid ───────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {STAT_CARDS.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${bg} ${color} shrink-0`}>
              <Icon size={20} />
            </div>
            <div className="min-w-0">
              <p className="text-gray-500 text-xs leading-tight">{label}</p>
              <p className={`text-2xl font-black ${color}`}>{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Tab Bar ──────────────────────────────────────── */}
      <div className="flex gap-2 mb-5">
        {([
          { id: 'map',    label: '🗺️ Fleet Map',       icon: Radio },
          { id: 'feed',   label: '⚡ Live Feed',        icon: Activity },
          { id: 'agents', label: '🤖 Agent Analytics',  icon: BarChart3 },
        ] as { id: Tab; label: string; icon: any }[]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all border ${
              tab === t.id
                ? 'bg-emerald-600 border-emerald-500 text-white'
                : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Map Tab ──────────────────────────────────────── */}
      {tab === 'map' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 h-[540px] rounded-2xl border border-gray-800 overflow-hidden">
            <DynamicMap center={[27.7172, 85.3240]} zoom={13} markers={mapMarkers} />
          </div>

          {/* Hospital capacity sidebar */}
          <div className="flex flex-col gap-3 overflow-y-auto max-h-[540px] pr-1">
            <h2 className="text-lg font-bold flex items-center gap-2 sticky top-0 bg-black pb-2">
              <HeartPulse className="text-red-500" size={20} /> Hospital Network
            </h2>
            {hospitals.map(h => (
              <div key={h.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="font-bold text-sm mb-3 leading-tight text-white">{h.name}</h3>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className={`rounded-lg px-3 py-2 text-center font-bold border ${
                    h.icu_status === 'OPEN' ? 'bg-blue-900/20 border-blue-700/30 text-blue-400' : 'bg-red-900/20 border-red-700/30 text-red-400'
                  }`}>
                    ICU: {h.icu_status}
                  </div>
                  <div className={`rounded-lg px-3 py-2 text-center font-bold border ${
                    h.er_status === 'OPEN' ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-400' : 'bg-red-900/20 border-red-700/30 text-red-400'
                  }`}>
                    ER: {h.er_status}
                  </div>
                </div>
                {h.specializations?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {h.specializations.map((s: string) => (
                      <span key={s} className="text-xs px-1.5 py-0.5 bg-gray-800 text-gray-400 rounded-md">{s}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Live Feed Tab ─────────────────────────────────── */}
      {tab === 'feed' && (
        <div className="max-w-3xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Activity className="text-emerald-400" size={20} />
              Recent Emergency Events
            </h2>
            <span className="text-xs text-gray-600">{liveFeed.length} events</span>
          </div>

          {liveFeed.length === 0 ? (
            <div className="text-center text-gray-600 py-16 border border-dashed border-gray-800 rounded-2xl">
              <Activity className="mx-auto mb-3 text-gray-700" size={40} />
              <p>No emergency events yet. Trigger a SOS from the Patient Portal to see data here.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {liveFeed.map((e: any, i: number) => (
                <div
                  key={i}
                  className="flex items-center gap-4 bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 hover:border-gray-700 transition"
                >
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${SEVERITY_DOT[e.severity] || 'bg-gray-600'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-white text-sm">{e.short_id}</span>
                      <span className="text-xs text-gray-600">·</span>
                      <span className="text-xs text-gray-400">{e.medical_category}</span>
                    </div>
                    {e.hospital_name && (
                      <p className="text-xs text-gray-600 mt-0.5 truncate">→ {e.hospital_name}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-xs font-bold ${STATUS_COLOR[e.status] || 'text-gray-400'}`}>{e.status}</p>
                    <p className="text-xs text-gray-700">
                      {new Date(e.created_at).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Agent Analytics Tab ───────────────────────────── */}
      {tab === 'agents' && (
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 mb-5">
            <TrendingUp className="text-emerald-400" size={20} />
            <h2 className="text-lg font-bold">Agent Decision Performance</h2>
          </div>

          {agentStats.length === 0 ? (
            <div className="text-center text-gray-600 py-16 border border-dashed border-gray-800 rounded-2xl">
              <BarChart3 className="mx-auto mb-3 text-gray-700" size={40} />
              <p>No agent data yet. Run an SOS to generate decisions.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {agentStats.map((a: any) => (
                <div key={a.agent_name} className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Agent</p>
                      <h3 className="font-black text-lg text-white">{a.agent_name.replace('_', ' ')}</h3>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-500 mb-1">Total Decisions</p>
                      <p className="text-2xl font-black text-emerald-400">{a.total_decisions}</p>
                    </div>
                  </div>

                  {/* Confidence bar */}
                  <div className="mb-3">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>Avg Confidence</span>
                      <span className="font-bold text-white">{(a.avg_confidence * 100).toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 rounded-full transition-all"
                        style={{ width: `${a.avg_confidence * 100}%` }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="bg-gray-800/50 rounded-lg px-3 py-2">
                      <p className="text-gray-600 mb-0.5">Min Confidence</p>
                      <p className="font-bold text-red-400">{(a.min_confidence * 100).toFixed(1)}%</p>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg px-3 py-2">
                      <p className="text-gray-600 mb-0.5">Max Confidence</p>
                      <p className="font-bold text-emerald-400">{(a.max_confidence * 100).toFixed(1)}%</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
