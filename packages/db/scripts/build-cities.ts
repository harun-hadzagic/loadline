// Builds packages/db/data/cities.csv from US Census Gazetteer + population estimates.
// Usage: node packages/db/scripts/build-cities.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DEFAULT, timezoneFor } from "./timezones.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const rawDir = join(dataDir, "raw");
const LIMIT = 1000;

const NON_CONTIGUOUS = new Set(["AK", "HI", "PR"]);
const ALLOWED = new Set(Object.keys(STATE_DEFAULT));

const FIPS_TO_USPS: Record<string, string> = {
  "01": "AL",
  "04": "AZ",
  "05": "AR",
  "06": "CA",
  "08": "CO",
  "09": "CT",
  "10": "DE",
  "11": "DC",
  "12": "FL",
  "13": "GA",
  "16": "ID",
  "17": "IL",
  "18": "IN",
  "19": "IA",
  "20": "KS",
  "21": "KY",
  "22": "LA",
  "23": "ME",
  "24": "MD",
  "25": "MA",
  "26": "MI",
  "27": "MN",
  "28": "MS",
  "29": "MO",
  "30": "MT",
  "31": "NE",
  "32": "NV",
  "33": "NH",
  "34": "NJ",
  "35": "NM",
  "36": "NY",
  "37": "NC",
  "38": "ND",
  "39": "OH",
  "40": "OK",
  "41": "OR",
  "42": "PA",
  "44": "RI",
  "45": "SC",
  "46": "SD",
  "47": "TN",
  "48": "TX",
  "49": "UT",
  "50": "VT",
  "51": "VA",
  "53": "WA",
  "54": "WV",
  "55": "WI",
  "56": "WY",
};

const SUFFIXES = [
  " city and borough",
  " metropolitan government",
  " metro government",
  " consolidated government",
  " unified government",
  " urban county",
  " zona urbana",
  " comunidad",
  " municipality",
  " borough",
  " village",
  " town",
  " city",
  " CDP",
];

/** Cleans a Census place name into a display name. */
export function cleanName(raw: string): string {
  let n = raw.trim().replace(/\s*\(balance\)\s*$/i, "");
  // Consolidated cases: cut at first hyphen or slash only if the remainder looks like a county/government.
  const m = n.match(/^([^-/]+)[-/](.+)$/);
  if (
    m &&
    /County|government|urban county|\(balance\)|Silver Bow|Deer Lodge/.test(m[2] as string)
  ) {
    n = (m[1] as string).trim();
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of SUFFIXES) {
      if (n.length > s.length && n.endsWith(s)) {
        n = n.slice(0, -s.length).trim();
        changed = true;
      }
    }
    const b = n.replace(/\s*\(balance\)\s*$/i, "");
    if (b !== n) {
      n = b;
      changed = true;
    }
  }
  // Alias in parentheses, e.g. "San Buenaventura (Ventura)" -> "Ventura".
  const alias = n.match(/^[^(]+\(([^)]+)\)$/);
  if (alias) n = alias[1] as string;
  // Legal names that nobody uses on a dispatch board.
  const COMMON: Record<string, string> = { "Boise City": "Boise" };
  return COMMON[n] ?? n;
}

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

const SERVICE =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/Places_CouSub_ConCity_SubMCD/MapServer";

type Feature = { attributes: Record<string, string | number | null> };

/** Fetches every page of a layer query; caches each raw JSON page under data/raw/. */
async function fetchLayer(
  layer: number,
  where: string,
  idField: string,
  tag: string,
): Promise<Feature[]> {
  const fields = [
    "GEOID",
    "STATE",
    idField,
    "BASENAME",
    "NAME",
    "LSADC",
    "FUNCSTAT",
    "POP100",
    "INTPTLAT",
    "INTPTLON",
  ];
  const all: Feature[] = [];
  for (let offset = 0; ; ) {
    const file = join(rawDir, `tigerweb-${tag}-${offset}.json`);
    let text: string;
    if (existsSync(file)) {
      text = readFileSync(file, "utf8");
    } else {
      const params = new URLSearchParams({
        where,
        outFields: fields.join(","),
        returnGeometry: "false",
        f: "json",
        orderByFields: "GEOID",
        resultOffset: String(offset),
        resultRecordCount: "100000",
      });
      const url = `${SERVICE}/${layer}/query?${params}`;
      console.log(`Fetching ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      text = await res.text();
      if (text.startsWith(`{"error"`)) throw new Error(`TIGERweb error: ${text.slice(0, 300)}`);
      writeFileSync(file, text);
    }
    const json = JSON.parse(text) as { features: Feature[]; exceededTransferLimit?: boolean };
    all.push(...json.features);
    if (!json.exceededTransferLimit || json.features.length === 0) break;
    offset += json.features.length;
  }
  return all;
}

async function main() {
  mkdirSync(rawDir, { recursive: true });
  const places = await fetchLayer(4, "POP100>25000", "PLACE", "places");
  const consol = await fetchLayer(3, "POP100>0", "CONCITY", "consolidated");
  console.log(`Fetched ${places.length} places and ${consol.length} consolidated cities`);

  type Place = {
    geoid: string;
    name: string;
    state: string;
    lat: number;
    lng: number;
    population: number;
  };
  const byGeoid = new Map<string, Place & { rawName: string }>();
  for (const f of [...places, ...consol]) {
    const a = f.attributes;
    if (!["A", "B", "C"].includes(String(a.FUNCSTAT))) continue;
    const state = FIPS_TO_USPS[String(a.STATE).padStart(2, "0")];
    if (state === undefined || NON_CONTIGUOUS.has(state) || !ALLOWED.has(state)) continue;
    const population = Number(a.POP100);
    const lat = Number(a.INTPTLAT);
    const lng = Number(a.INTPTLON);
    if (!Number.isFinite(population) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const geoid = String(a.GEOID);
    const prev = byGeoid.get(geoid);
    if (prev && prev.population >= population) continue;
    const rawName = String(a.NAME ?? a.BASENAME);
    byGeoid.set(geoid, { geoid, name: cleanName(rawName), rawName, state, lat, lng, population });
  }

  const deduped = new Map<string, Place>();
  for (const p of byGeoid.values()) {
    const key = `${p.name}|${p.state}`;
    const prev = deduped.get(key);
    if (!prev || p.population > prev.population) deduped.set(key, p);
  }

  const top = [...deduped.values()]
    .sort((a, b) => b.population - a.population || a.geoid.localeCompare(b.geoid))
    .slice(0, LIMIT)
    .map((p) => ({
      geoid: p.geoid,
      name: p.name,
      state: p.state,
      lat: p.lat,
      lng: p.lng,
      population: p.population,
      timezone: timezoneFor(p.name, p.state, p.lat, p.lng),
    }));

  const out = ["geoid,name,state,lat,lng,timezone,population"];
  for (const p of top) {
    out.push(
      [
        p.geoid,
        csvField(p.name),
        p.state,
        p.lat.toFixed(5),
        p.lng.toFixed(5),
        p.timezone,
        String(p.population),
      ].join(","),
    );
  }
  writeFileSync(join(dataDir, "cities.csv"), `${out.join("\n")}\n`);

  // Report.
  console.log(`\nRows: ${top.length}  (2020 Census POP100, TIGERweb)`);
  console.log("\nTop 10:");
  for (const p of top.slice(0, 10))
    console.log(
      `  ${p.geoid} ${p.name}, ${p.state} ${p.lat.toFixed(5)} ${p.lng.toFixed(5)} ${p.timezone} ${p.population}`,
    );
  const split = new Set(["FL", "TX", "ID", "OR", "NE", "KS", "SD", "ND", "KY", "TN", "IN", "MI"]);
  console.log("\nNon-default zones in split-zone states:");
  for (const p of top) {
    if (split.has(p.state) && p.timezone !== STATE_DEFAULT[p.state])
      console.log(`  ${p.name}, ${p.state}: ${p.timezone}`);
  }
  console.log("\nSpot checks:");
  for (const [n, s] of [
    ["Dallas", "TX"],
    ["Charlotte", "NC"],
    ["El Paso", "TX"],
    ["Pensacola", "FL"],
    ["Chattanooga", "TN"],
    ["Evansville", "IN"],
    ["Nashville", "TN"],
    ["Louisville", "KY"],
    ["Indianapolis", "IN"],
    ["Rapid City", "SD"],
    ["Coeur d'Alene", "ID"],
    ["Phoenix", "AZ"],
  ] as const) {
    const p = top.find((x) => x.name === n && x.state === s);
    console.log(
      p ? `  ${n}, ${s}: ${p.timezone} (pop ${p.population})` : `  ${n}, ${s}: NOT FOUND`,
    );
  }
  const bad = top.filter((p) => /\(|balance|government|County/.test(p.name));
  console.log(`\nNames still containing ( / balance / government / County: ${bad.length}`);
  for (const p of bad) console.log(`  ${p.name}, ${p.state}`);
  console.log(
    `\n1000th row: ${top.at(-1)?.name}, ${top.at(-1)?.state} pop ${top.at(-1)?.population}`,
  );
  if (bad.length > 0) throw new Error("Uncleaned names remain");
}

// Only run when executed directly (so cleanName can be imported by tests).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
