/**
 * TEL-01 / TEL-02 (demo version): offline AIS simulator for Manila South Harbor -> Port of Cebu,
 * plus the berthing rule from PRD §8.2. No external API, so the demo cannot be rate-limited.
 */

export interface Tick {
  seq: number;
  lat: number;
  lng: number;
  /** Speed over ground, knots. */
  sog: number;
  /** Course over ground, degrees. */
  cog: number;
  navStatus: string;
  /** 0..1 along the route by distance. */
  progress: number;
  /** Leg name shown in the HUD. */
  leg: string;
  inGeofence: boolean;
  at: string;
}

export const ORIGIN = { name: "Manila South Harbor", lat: 14.58, lng: 120.965 };
export const CEBU = { name: "Port of Cebu", lat: 10.3015, lng: 123.908, radiusM: 800 };

/** Rough VisMin sea lane: Manila Bay, Verde Island Passage, Sibuyan Sea, Visayan Sea, Cebu approach. */
export const WAYPOINTS: { lat: number; lng: number; leg: string }[] = [
  { lat: 14.58, lng: 120.965, leg: "Manila South Harbor" },
  { lat: 14.4, lng: 120.62, leg: "Manila Bay" },
  { lat: 13.75, lng: 120.55, leg: "Batangas coast" },
  { lat: 13.6, lng: 121.05, leg: "Verde Island Passage" },
  { lat: 12.95, lng: 122.05, leg: "Sibuyan Sea" },
  { lat: 12.25, lng: 122.95, leg: "Sibuyan Sea" },
  { lat: 11.3, lng: 123.75, leg: "Visayan Sea" },
  { lat: 10.75, lng: 124.15, leg: "Camotes Sea" },
  { lat: 10.42, lng: 124.0, leg: "Cebu approach" },
  { lat: 10.3015, lng: 123.908, leg: "Port of Cebu" },
];

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export const inCebuGeofence = (p: { lat: number; lng: number }): boolean => distanceM(p, CEBU) <= CEBU.radiusM;

const legDist: number[] = WAYPOINTS.slice(1).map((w, i) => distanceM(WAYPOINTS[i]!, w));
const TOTAL = legDist.reduce((a, b) => a + b, 0);

/** Point at fraction f (0..1) of total route distance. */
function pointAt(f: number): { lat: number; lng: number; leg: string; cog: number } {
  let target = Math.max(0, Math.min(1, f)) * TOTAL;
  for (let i = 0; i < legDist.length; i++) {
    const d = legDist[i]!;
    const a = WAYPOINTS[i]!;
    const b = WAYPOINTS[i + 1]!;
    if (target <= d || i === legDist.length - 1) {
      const t = d === 0 ? 1 : Math.min(1, target / d);
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, leg: t > 0.5 ? b.leg : a.leg, cog: bearing(a, b) };
    }
    target -= d;
  }
  const last = WAYPOINTS[WAYPOINTS.length - 1]!;
  return { ...last, cog: 0 };
}

/** Script of (fraction, sog, navStatus) for each tick. Ends with 3 moored ticks inside the geofence. */
const SCRIPT: { f: number; sog: number; nav: string }[] = [
  { f: 0, sog: 0.1, nav: "Moored" },
  { f: 0.04, sog: 9.5, nav: "Under way using engine" },
  { f: 0.12, sog: 14.2, nav: "Under way using engine" },
  { f: 0.22, sog: 15.1, nav: "Under way using engine" },
  { f: 0.33, sog: 15.4, nav: "Under way using engine" },
  { f: 0.45, sog: 15.0, nav: "Under way using engine" },
  { f: 0.57, sog: 14.8, nav: "Under way using engine" },
  { f: 0.68, sog: 14.6, nav: "Under way using engine" },
  { f: 0.79, sog: 13.9, nav: "Under way using engine" },
  { f: 0.89, sog: 11.2, nav: "Under way using engine" },
  { f: 0.96, sog: 6.0, nav: "Restricted manoeuvrability" },
  { f: 0.995, sog: 2.1, nav: "Restricted manoeuvrability" },
  { f: 1, sog: 0.4, nav: "Moored" },
  { f: 1, sog: 0.2, nav: "Moored" },
  { f: 1, sog: 0.1, nav: "Moored" },
];

export const TOTAL_TICKS = SCRIPT.length;

export function makeTick(seq: number): Tick {
  const s = SCRIPT[Math.min(seq, SCRIPT.length - 1)]!;
  const p = pointAt(s.f);
  // Berthed ticks sit at the quay, slightly inside the geofence, with tiny jitter.
  const jitter = s.f >= 1 ? (seq % 3) * 0.00012 : 0;
  const lat = s.f >= 1 ? 10.2992 + jitter : p.lat;
  const lng = s.f >= 1 ? 123.9061 - jitter : p.lng;
  const pos = { lat, lng };
  return {
    seq,
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
    sog: s.sog,
    cog: Math.round(s.f >= 1 ? 142 : p.cog),
    navStatus: s.nav,
    progress: s.f,
    leg: s.f >= 1 ? CEBU.name : s.f === 0 ? ORIGIN.name : p.leg,
    inGeofence: inCebuGeofence(pos),
    at: new Date().toISOString(),
  };
}

/** Ticks that would be produced by jumping straight to the quay (fast-forward). */
export function berthTicksFrom(nextSeq: number): number[] {
  const firstBerth = SCRIPT.findIndex((s) => s.f >= 1);
  const start = Math.max(nextSeq, firstBerth);
  const out: number[] = [];
  for (let i = start; i < SCRIPT.length; i++) out.push(i);
  return out;
}

export const isUnderway = (t: Tick | undefined): boolean => !!t && t.sog >= 3 && !t.inGeofence;

/** PRD §8.2: inside the geofence and SOG <= 0.5 kn for 3 consecutive ticks. */
export function isBerthed(ticks: Tick[]): boolean {
  if (ticks.length < 3) return false;
  return ticks.slice(-3).every((t) => t.inGeofence && t.sog <= 0.5);
}

// ---------- route-agnostic readings (portal voyages to any port) ----------
// Portal routes are free text ("Manila to Davao"), so there are no coordinates to plot. These readings replay the
// same speed script and apply the same rule as the Cebu demo: at the destination quay, SOG <= 0.5 kn, 3 in a row.

export interface Reading {
  seq: number;
  sog: number;
  navStatus: string;
  progress: number;
  atDestination: boolean;
}

export function readingAt(seq: number): Reading {
  const s = SCRIPT[Math.min(seq, SCRIPT.length - 1)]!;
  return { seq, sog: s.sog, navStatus: s.nav, progress: s.f, atDestination: s.f >= 1 };
}

/** Readings received `elapsedMs` into a voyage that lasts `voyageMs` (one every voyageMs / (TOTAL_TICKS - 1)). */
export function readingsAfter(elapsedMs: number, voyageMs: number): Reading[] {
  if (elapsedMs < 0) return [];
  const last = Math.min(TOTAL_TICKS - 1, Math.floor((elapsedMs * (TOTAL_TICKS - 1)) / voyageMs));
  return Array.from({ length: last + 1 }, (_, i) => readingAt(i));
}

export const readingUnderway = (r: Reading): boolean => r.sog >= 3 && !r.atDestination;

/** Same rule as isBerthed: the last 3 readings are at the destination quay at <= 0.5 kn. */
export function readingsBerthed(rs: Reading[]): boolean {
  if (rs.length < 3) return false;
  return rs.slice(-3).every((r) => r.atDestination && r.sog <= 0.5);
}
