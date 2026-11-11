import { type SQL, sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Parse the EWKB hex PostGIS returns for a geography(Point, 4326). */
export function parseEwkbPoint(hex: string): GeoPoint {
  const buf = Buffer.from(hex, "hex");
  const littleEndian = buf.readUInt8(0) === 1;
  const read32 = (o: number) => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const read64 = (o: number) => (littleEndian ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  const type = read32(1);
  const hasSrid = (type & 0x20000000) !== 0;
  if ((type & 0xff) !== 1) throw new Error(`expected a Point, got geometry type ${type & 0xff}`);
  const offset = hasSrid ? 9 : 5;
  return { lng: read64(offset), lat: read64(offset + 8) };
}

export function pointSql(p: GeoPoint): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;
}

export const geographyPoint = customType<{ data: GeoPoint; driverData: string }>({
  dataType: () => "geography(Point,4326)",
  toDriver: (value) => pointSql(value),
  fromDriver: (value) => parseEwkbPoint(value),
});

/** A half-open timestamptz range [lower, upper). null bounds are unbounded. */
export interface TimeRange {
  lower: Date | null;
  upper: Date | null;
}

const rangeRe = /^([[(])("?)(.*?)\2,("?)(.*?)\4([\])])$/;

function parsePgTimestamp(s: string): Date {
  // "2026-11-11 16:00:00.123+00" -> "2026-11-11T16:00:00.123+00:00"
  const normalized = s
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) throw new Error(`cannot parse timestamp ${s}`);
  return d;
}

export function parseTstzRange(text: string): TimeRange {
  if (text === "empty") return { lower: null, upper: null };
  const m = rangeRe.exec(text);
  if (!m) throw new Error(`cannot parse tstzrange ${text}`);
  const unbounded = (v: string | undefined) => !v || v === "infinity" || v === "-infinity";
  const lower = unbounded(m[3]) ? null : parsePgTimestamp(m[3] as string);
  const upper = unbounded(m[5]) ? null : parsePgTimestamp(m[5] as string);
  return { lower, upper };
}

export function formatTstzRange(r: TimeRange): string {
  const lo = r.lower ? `"${r.lower.toISOString()}"` : "";
  const hi = r.upper ? `"${r.upper.toISOString()}"` : "";
  return `[${lo},${hi})`;
}

export const tstzrange = customType<{ data: TimeRange; driverData: string }>({
  dataType: () => "tstzrange",
  toDriver: (value) => formatTstzRange(value),
  fromDriver: (value) => parseTstzRange(value),
});

/** xid8 comes back as a decimal string; keep it as a string (it can exceed 2^53). */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => "xid8",
});

export const uuidArray = customType<{ data: string[]; driverData: string[] | string }>({
  dataType: () => "uuid[]",
  fromDriver: (value) =>
    Array.isArray(value)
      ? value
      : value
          .replace(/^\{|\}$/g, "")
          .split(",")
          .filter(Boolean),
});
