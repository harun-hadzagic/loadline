import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CITIES_CSV = path.resolve(here, "../data/cities.csv");

export interface CityRow {
  geoid: number;
  name: string;
  state: string;
  lat: number;
  lng: number;
  timezone: string;
  population: number;
}

/** Minimal RFC 4180 line parser: handles quoted fields with commas and doubled quotes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

export async function readCitiesCsv(file = CITIES_CSV): Promise<CityRow[]> {
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0] ?? "");
  const expected = ["geoid", "name", "state", "lat", "lng", "timezone", "population"];
  if (header.join(",") !== expected.join(",")) {
    throw new Error(`unexpected cities.csv header: ${header.join(",")}`);
  }
  return lines.slice(1).map((line) => {
    const [geoid, name, state, lat, lng, timezone, population] = parseCsvLine(line);
    return {
      geoid: Number(geoid),
      name: name ?? "",
      state: state ?? "",
      lat: Number(lat),
      lng: Number(lng),
      timezone: timezone ?? "",
      population: Number(population),
    };
  });
}

/** Upsert the committed city table. Reference data, so this runs as loadline_owner with no RLS. */
export async function loadCities(
  client: pg.Client | pg.PoolClient,
  file = CITIES_CSV,
): Promise<number> {
  const rows = await readCitiesCsv(file);
  const batch = 200;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const values: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      const b = j * 7;
      values.push(r.geoid, r.name, r.state, r.lng, r.lat, r.timezone, r.population);
      return `($${b + 1}, $${b + 2}, $${b + 3}, ST_SetSRID(ST_MakePoint($${b + 4}, $${b + 5}), 4326)::geography, $${b + 6}, $${b + 7})`;
    });
    await client.query(
      `INSERT INTO app.cities (id, name, state, location, timezone, population)
       VALUES ${tuples.join(",")}
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, state = EXCLUDED.state, location = EXCLUDED.location,
         timezone = EXCLUDED.timezone, population = EXCLUDED.population`,
      values,
    );
  }
  return rows.length;
}
