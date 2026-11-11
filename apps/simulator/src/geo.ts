export interface Point {
  lat: number;
  lng: number;
}

const R_MILES = 3958.7613;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in miles. */
export function distanceMiles(a: Point, b: Point): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const dφ = toRad(b.lat - a.lat);
  const dλ = toRad(b.lng - a.lng);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearing(a: Point, b: Point): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const dλ = toRad(b.lng - a.lng);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `miles` along the great circle from `from` toward `to` (never past it). */
export function stepToward(from: Point, to: Point, miles: number): Point {
  const total = distanceMiles(from, to);
  if (total <= miles || total === 0) return to;
  const θ = toRad(bearing(from, to));
  const δ = miles / R_MILES;
  const φ1 = toRad(from.lat);
  const λ1 = toRad(from.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
}

/** A small random walk that stays within `radiusMiles` of `home`. */
export function jitterNear(
  home: Point,
  current: Point | null,
  radiusMiles: number,
  rng: () => number = Math.random,
): Point {
  const base = current && distanceMiles(home, current) <= radiusMiles ? current : home;
  const angle = rng() * 2 * Math.PI;
  const dist = rng() * 0.15;
  const next = stepToward(
    base,
    { lat: base.lat + Math.cos(angle), lng: base.lng + Math.sin(angle) },
    dist,
  );
  return distanceMiles(home, next) <= radiusMiles ? next : home;
}
