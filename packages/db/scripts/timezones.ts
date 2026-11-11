// Time-zone assignment for US places. Pure functions, no I/O, so they can be unit-tested.
// Only five IANA names are used: America/New_York, America/Chicago, America/Denver,
// America/Phoenix (Arizona, no DST) and America/Los_Angeles.

export type Timezone =
  | "America/New_York"
  | "America/Chicago"
  | "America/Denver"
  | "America/Phoenix"
  | "America/Los_Angeles";

const EASTERN = "CT DE DC FL GA ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV IN KY";
const CENTRAL = "AL AR IL IA KS LA MN MS MO NE ND OK SD TX WI TN";
const MOUNTAIN = "CO ID MT NM UT WY";
const PACIFIC = "CA NV OR WA";

// State defaults. Arizona is Phoenix (the Navajo Nation DST exception is ignored).
export const STATE_DEFAULT: Readonly<Record<string, Timezone>> = (() => {
  const map: Record<string, Timezone> = { AZ: "America/Phoenix" };
  for (const s of EASTERN.split(" ")) map[s] = "America/New_York";
  for (const s of CENTRAL.split(" ")) map[s] = "America/Chicago";
  for (const s of MOUNTAIN.split(" ")) map[s] = "America/Denver";
  for (const s of PACIFIC.split(" ")) map[s] = "America/Los_Angeles";
  return map;
})();

// Places (by cleaned name) in otherwise-Eastern states that observe Central time.
const KY_CENTRAL = new Set([
  "Bowling Green",
  "Owensboro",
  "Paducah",
  "Hopkinsville",
  "Henderson",
  "Madisonville",
  "Murray",
  "Glasgow",
  "Franklin",
  "Russellville",
  "Mayfield",
  "Princeton",
  "Morganfield",
  "Leitchfield",
  "Central City",
  "Greenville",
  "Marion",
  "Cadiz",
  "Benton",
  "Fulton",
  "Scottsville",
]);
const IN_CENTRAL = new Set([
  "Gary",
  "Hammond",
  "East Chicago",
  "Merrillville",
  "Portage",
  "Valparaiso",
  "Crown Point",
  "Hobart",
  "Schererville",
  "Highland",
  "Munster",
  "Griffith",
  "Lake Station",
  "Dyer",
  "St. John",
  "Cedar Lake",
  "Michigan City",
  "La Porte",
  "Chesterton",
  "Lowell",
  "Winfield",
  "Knox",
  "Rensselaer",
  "Evansville",
  "Princeton",
  "Boonville",
  "Newburgh",
  "Mount Vernon",
  "Tell City",
  "Rockport",
  "Fort Branch",
  "Chandler",
]);
// Four western Upper Peninsula counties.
const MI_CENTRAL = new Set([
  "Ironwood",
  "Iron Mountain",
  "Kingsford",
  "Menominee",
  "Iron River",
  "Norway",
  "Bessemer",
  "Crystal Falls",
]);

/** Returns the IANA zone for a place, or throws for a state with no default. */
export function timezoneFor(name: string, state: string, lat: number, lng: number): Timezone {
  const base = STATE_DEFAULT[state];
  if (base === undefined) throw new Error(`No time zone default for state "${state}"`);
  const central: Timezone = "America/Chicago";
  const mountain: Timezone = "America/Denver";
  switch (state) {
    case "FL": // panhandle west of the Apalachicola River
      return lng < -85.1 ? central : base;
    case "TX": // El Paso area
      return lng < -105.5 ? mountain : base;
    case "ID": // northern panhandle is Pacific
      return lat > 45.5 ? "America/Los_Angeles" : base;
    case "OR": // Malheur County (Ontario, lng about -117.0); east of -117.3
      return lng > -117.3 && lat < 44.5 ? mountain : base;
    case "NE":
      return lng < -101.5 ? mountain : base;
    case "KS":
      return lng < -101.3 ? mountain : base;
    case "SD":
      return lng < -101.0 ? mountain : base;
    case "ND": // southwestern ND (Dickinson)
      return lat < 47.0 && lng < -102.0 ? mountain : base;
    case "KY":
      return KY_CENTRAL.has(name) ? central : base;
    case "TN": // East Tennessee is Eastern
      return lng > -85.35 ? "America/New_York" : base;
    case "IN":
      return IN_CENTRAL.has(name) ? central : base;
    case "MI":
      return MI_CENTRAL.has(name) ? central : base;
    default:
      return base;
  }
}
