'use client';

import { Ambulance, Radio, MapPin } from 'lucide-react';

type Props = {
  wsConnected: boolean;
  ambulanceLatLng: [number, number] | null;
  etaMinutes: number | null;
  lastUpdateAt: Date | null;
};

export function PatientTrackingHud({ wsConnected, ambulanceLatLng, etaMinutes, lastUpdateAt }: Props) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/90 p-4 backdrop-blur-md">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Ambulance className="h-5 w-5 shrink-0 text-amber-400" aria-hidden />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-slate-500">Ambulance</p>
            <p className="truncate text-sm font-semibold text-white">
              {ambulanceLatLng ? 'Live on map' : 'Waiting for first ping…'}
            </p>
          </div>
        </div>
        <div
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs font-bold ${
            wsConnected ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
          }`}
        >
          <Radio className="h-3.5 w-3.5" />
          {wsConnected ? 'Live' : 'Offline'}
        </div>
      </div>

      {etaMinutes != null && (
        <p className="mt-2 text-lg font-bold text-amber-400">
          {etaMinutes <= 0 ? 'Ambulance nearby' : `ETA ~ ${etaMinutes} min`}
        </p>
      )}

      {ambulanceLatLng && (
        <p className="mt-2 flex items-center gap-1.5 font-mono text-xs text-slate-400">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          {ambulanceLatLng[0].toFixed(5)}, {ambulanceLatLng[1].toFixed(5)}
        </p>
      )}

      {lastUpdateAt && (
        <p className="mt-1 text-xs text-slate-500">Updated {lastUpdateAt.toLocaleTimeString()}</p>
      )}
    </div>
  );
}
