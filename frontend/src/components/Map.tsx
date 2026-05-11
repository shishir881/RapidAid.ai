'use client';

import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { useEffect } from 'react';

// Fix for default marker icons in Next.js
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

interface MapProps {
  center: [number, number];
  zoom?: number;
  markers?: {
    id: string;
    position: [number, number];
    title: string;
    description?: string;
    color?: 'red' | 'blue' | 'green' | 'amber';
    icon?: 'ambulance';
  }[];
  route?: {
    positions: [number, number][];
    color?: string;
  };
  fitBounds?: [number, number][];
  fitBoundsPaddingPx?: number;
  onMapClick?: (lat: number, lng: number) => void;
}

// Follow a single point. Do NOT use together with FitBounds (they fight each other).
function Recenter({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom);
  }, [center, zoom, map]);
  return null;
}

function FitBounds({ points, paddingPx = 56 }: { points?: [number, number][]; paddingPx?: number }) {
  const map = useMap();
  useEffect(() => {
    if (!points || points.length < 2) return;
    const latlngs = points
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => L.latLng(p[0], p[1]));
    if (latlngs.length < 2) return;

    const bounds = L.latLngBounds(latlngs);
    if (!bounds.isValid()) return;

    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const same =
      Math.abs(ne.lat - sw.lat) < 1e-8 && Math.abs(ne.lng - sw.lng) < 1e-8;
    if (same) {
      map.setView(ne, Math.max(map.getZoom(), 15));
      return;
    }

    map.fitBounds(bounds, { padding: [paddingPx, paddingPx], maxZoom: 16 });
  }, [map, points, paddingPx]);
  return null;
}

// A helper to capture clicks
function MapEvents({ onMapClick }: { onMapClick?: (lat: number, lng: number) => void }) {
  const map = useMap();
  useEffect(() => {
    if (!onMapClick) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      onMapClick(e.latlng.lat, e.latlng.lng);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map, onMapClick]);
  return null;
}

export default function Map({ center, zoom = 14, markers = [], route, fitBounds, fitBoundsPaddingPx, onMapClick }: MapProps) {
  const ambulanceSvg = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M7 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" fill="white"/>
      <path d="M17 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" fill="white"/>
      <path d="M3 6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v2h2.2a2 2 0 0 1 1.7.95l1.6 2.7A2 2 0 0 1 24 14.66V16a2 2 0 0 1-2 2h-1.1a3.5 3.5 0 0 0-6.8 0H9.9a3.5 3.5 0 0 0-6.8 0H3a2 2 0 0 1-2-2V6Z" fill="white" opacity="0.95"/>
      <path d="M10.75 6.75h2.5v2h2v2.5h-2v2h-2.5v-2h-2v-2.5h2v-2Z" fill="#f59e0b"/>
    </svg>
  `;

  // Custom icons based on color
  const getIcon = (marker: { color?: string; icon?: 'ambulance' }) => {
    const colorMap: Record<string, string> = {
      red: '#ef4444',
      blue: '#3b82f6',
      green: '#22c55e',
      amber: '#f59e0b',
    };
    const color = marker.color ? (colorMap[marker.color] || marker.color) : '#60a5fa';
    if (marker.icon === 'ambulance') {
      return L.divIcon({
        className: 'custom-marker',
        html: `
          <div style="width:28px;height:28px;background-color:#f59e0b;border-radius:50%;border:3px solid white;display:flex;align-items:center;justify-content:center;box-shadow:0 0 12px rgba(0,0,0,0.55);">
            ${ambulanceSvg}
          </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
    }

    return L.divIcon({
      className: 'custom-marker',
      html: `<div style="width:24px;height:24px;background-color:${color};border-radius:50%;border:3px solid white;box-shadow:0 0 10px rgba(0,0,0,0.5);"></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  };

  return (
    <div className="w-full h-full rounded-xl overflow-hidden border border-gray-800 shadow-2xl relative z-10">
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        {fitBounds && fitBounds.length >= 2 ? (
          <FitBounds points={fitBounds} paddingPx={fitBoundsPaddingPx} />
        ) : (
          <Recenter center={center} zoom={zoom} />
        )}
        <MapEvents onMapClick={onMapClick} />
        <TileLayer
          className="dark-map-tiles"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {route && route.positions.length > 0 && (
          <Polyline
            pathOptions={{ color: route.color ?? '#f97316', weight: 5, opacity: 0.85 }}
            positions={route.positions}
          />
        )}
        {markers.map((marker) => (
          <Marker
            key={marker.id}
            position={marker.position}
            icon={marker.color || marker.icon ? getIcon(marker) : new L.Icon.Default()}
          >
            <Popup>
              <div className="font-semibold">{marker.title}</div>
              {marker.description && <div className="text-sm text-gray-600">{marker.description}</div>}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
