// Synthetic demo data. Every company, person, broker and load is invented.
// Ids are fixed so tests, e2e flows and the auth seed can refer to them.

export type DemoRole = "owner" | "admin" | "dispatcher" | "driver";

export interface DemoUser {
  /** Better Auth user id (text). The auth seed creates the user with this id. */
  id: string;
  email: string;
  name: string;
  role: DemoRole;
}

export interface DemoCompany {
  key: "acme" | "blueridge";
  /** Fixed uuidv7-shaped company id. */
  id: string;
  /** Better Auth organization id. */
  orgId: string;
  slug: string;
  name: string;
  timezone: string;
  hq: [string, string];
  emailDomain: string;
  refPrefix: string;
  users: DemoUser[];
  driverNames: string[];
  /** Cities this company's loads run between, as [name, state]. */
  lanes: Array<[string, string]>;
}

function users(
  key: string,
  domain: string,
  people: { owner: string; admin: string; dispatchers: [string, string]; drivers: string[] },
): DemoUser[] {
  const out: DemoUser[] = [
    { id: `user_${key}_owner`, email: `owner@${domain}`, name: people.owner, role: "owner" },
    { id: `user_${key}_admin`, email: `admin@${domain}`, name: people.admin, role: "admin" },
    {
      id: `user_${key}_dispatcher_1`,
      email: `dispatch1@${domain}`,
      name: people.dispatchers[0],
      role: "dispatcher",
    },
    {
      id: `user_${key}_dispatcher_2`,
      email: `dispatch2@${domain}`,
      name: people.dispatchers[1],
      role: "dispatcher",
    },
  ];
  people.drivers.forEach((name, i) => {
    out.push({
      id: `user_${key}_driver_${i + 1}`,
      email: `driver${i + 1}@${domain}`,
      name,
      role: "driver",
    });
  });
  return out;
}

const ACME_DRIVERS = [
  "Marcus Bell",
  "Elena Ortiz",
  "Troy Whitaker",
  "Dana Kowalski",
  "Jamal Reed",
  "Priya Natarajan",
  "Owen Gallagher",
  "Rosa Delgado",
];

const BLUERIDGE_DRIVERS = [
  "Caleb Henson",
  "Monique Dubois",
  "Travis Lane",
  "Yusuf Demir",
  "Hannah Pruitt",
  "Deshawn Mills",
  "Ingrid Solberg",
  "Victor Alvarez",
];

export const DEMO_COMPANIES: DemoCompany[] = [
  {
    key: "acme",
    id: "01930000-0000-7000-8000-00000000a001",
    orgId: "org_acme_freight",
    slug: "acme-freight",
    name: "Acme Freight",
    timezone: "America/Chicago",
    hq: ["Dallas", "TX"],
    emailDomain: "acme-freight.example",
    refPrefix: "ACM",
    users: users("acme", "acme-freight.example", {
      owner: "Harriet Vance",
      admin: "Luis Carrillo",
      dispatchers: ["Nadia Brooks", "Sam Okafor"],
      drivers: ACME_DRIVERS,
    }),
    driverNames: ACME_DRIVERS,
    lanes: [
      ["Dallas", "TX"],
      ["Fort Worth", "TX"],
      ["Houston", "TX"],
      ["San Antonio", "TX"],
      ["Austin", "TX"],
      ["Oklahoma City", "OK"],
      ["Tulsa", "OK"],
      ["Memphis", "TN"],
      ["Little Rock", "AR"],
      ["Shreveport", "LA"],
      ["New Orleans", "LA"],
      ["Kansas City", "MO"],
      ["Denver", "CO"],
      ["Phoenix", "AZ"],
      ["Atlanta", "GA"],
      ["El Paso", "TX"],
      ["Albuquerque", "NM"],
      ["Amarillo", "TX"],
    ],
  },
  {
    key: "blueridge",
    id: "01930000-0000-7000-8000-00000000b002",
    orgId: "org_blue_ridge_haulers",
    slug: "blue-ridge-haulers",
    name: "Blue Ridge Haulers",
    timezone: "America/New_York",
    hq: ["Charlotte", "NC"],
    emailDomain: "blueridge-haulers.example",
    refPrefix: "BRH",
    users: users("blueridge", "blueridge-haulers.example", {
      owner: "Georgia Whitfield",
      admin: "Tomas Reyes",
      dispatchers: ["Kendra Boyd", "Felix Marsh"],
      drivers: BLUERIDGE_DRIVERS,
    }),
    driverNames: BLUERIDGE_DRIVERS,
    lanes: [
      ["Charlotte", "NC"],
      ["Raleigh", "NC"],
      ["Greensboro", "NC"],
      ["Atlanta", "GA"],
      ["Richmond", "VA"],
      ["Nashville", "TN"],
      ["Knoxville", "TN"],
      ["Columbia", "SC"],
      ["Greenville", "SC"],
      ["Jacksonville", "FL"],
      ["Savannah", "GA"],
      ["Chattanooga", "TN"],
      ["Baltimore", "MD"],
      ["Norfolk", "VA"],
      ["Louisville", "KY"],
      ["Birmingham", "AL"],
      ["Asheville", "NC"],
      ["Wilmington", "NC"],
    ],
  },
];

export const BROKERS = [
  "Northwind Logistics",
  "Harbor Light Brokerage",
  "Prairie Sky Freight",
  "Copperline Logistics",
  "Bluewater Freight Partners",
  "Summit Ridge Brokerage",
  "Ironwood Transport Services",
  "Meridian Cargo Group",
];

export const COMMODITIES: Array<[string, "dry_van" | "reefer" | "flatbed", number, number]> = [
  // commodity, equipment, weight lbs, rate cents
  ["Paper products", "dry_van", 38_000, 185_000],
  ["Packaged beverages", "dry_van", 42_500, 210_000],
  ["Auto parts", "dry_van", 31_200, 162_500],
  ["Furniture", "dry_van", 18_400, 240_000],
  ["Frozen poultry", "reefer", 40_000, 265_000],
  ["Fresh produce", "reefer", 36_800, 298_000],
  ["Dairy", "reefer", 41_000, 231_000],
  ["Steel coil", "flatbed", 46_000, 310_000],
  ["HVAC units", "flatbed", 22_000, 275_000],
  ["Lumber", "flatbed", 44_500, 195_000],
];

export const DEMO = {
  companies: DEMO_COMPANIES,
  /** Every demo user signs in with DEMO_PASSWORD from .env (local use only). */
  passwordEnv: "DEMO_PASSWORD",
} as const;
