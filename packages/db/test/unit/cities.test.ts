import { describe, expect, it } from "vitest";
import { timezoneFor } from "../../scripts/timezones.ts";
import { readCitiesCsv } from "../../src/cities.ts";
import { DEMO_COMPANIES } from "../../src/seed/data.ts";

const ZONES = new Set([
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
]);

describe("the committed city table", () => {
  it("has 1,000 distinct places inside the contiguous US with known zones", async () => {
    const rows = await readCitiesCsv();
    expect(rows).toHaveLength(1000);
    expect(new Set(rows.map((r) => r.geoid)).size).toBe(1000);
    expect(new Set(rows.map((r) => `${r.name}|${r.state}`)).size).toBe(1000);
    for (const r of rows) {
      expect(r.lat).toBeGreaterThan(24);
      expect(r.lat).toBeLessThan(50);
      expect(r.lng).toBeGreaterThan(-125);
      expect(r.lng).toBeLessThan(-66);
      expect(ZONES.has(r.timezone), `${r.name}, ${r.state}: ${r.timezone}`).toBe(true);
      expect(r.population).toBeGreaterThan(0);
      expect(["AK", "HI", "PR"]).not.toContain(r.state);
    }
    // Sorted by population, descending.
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.population).toBeLessThanOrEqual(rows[i - 1]!.population);
  });

  it("contains every city the seed uses", async () => {
    const rows = await readCitiesCsv();
    const keys = new Set(rows.map((r) => `${r.name}|${r.state}`));
    for (const c of DEMO_COMPANIES) {
      for (const [name, state] of c.lanes)
        expect(keys.has(`${name}|${state}`), `${name}, ${state}`).toBe(true);
    }
  });

  it("gets the well-known split-state cases right", async () => {
    const rows = await readCitiesCsv();
    const zone = (name: string, state: string) =>
      rows.find((r) => r.name === name && r.state === state)?.timezone;
    expect(zone("Dallas", "TX")).toBe("America/Chicago");
    expect(zone("El Paso", "TX")).toBe("America/Denver");
    expect(zone("Charlotte", "NC")).toBe("America/New_York");
    expect(zone("Pensacola", "FL")).toBe("America/Chicago");
    expect(zone("Tallahassee", "FL")).toBe("America/New_York");
    expect(zone("Nashville", "TN")).toBe("America/Chicago");
    expect(zone("Chattanooga", "TN")).toBe("America/New_York");
    expect(zone("Knoxville", "TN")).toBe("America/New_York");
    expect(zone("Louisville", "KY")).toBe("America/New_York");
    expect(zone("Bowling Green", "KY")).toBe("America/Chicago");
    expect(zone("Indianapolis", "IN")).toBe("America/New_York");
    expect(zone("Evansville", "IN")).toBe("America/Chicago");
    expect(zone("Gary", "IN")).toBe("America/Chicago");
    expect(zone("Rapid City", "SD")).toBe("America/Denver");
    expect(zone("Sioux Falls", "SD")).toBe("America/Chicago");
    expect(zone("Coeur d'Alene", "ID")).toBe("America/Los_Angeles");
    expect(zone("Boise", "ID")).toBe("America/Denver");
    expect(zone("Phoenix", "AZ")).toBe("America/Phoenix");
    expect(zone("Detroit", "MI")).toBe("America/New_York");
  });
});

describe("timezoneFor", () => {
  it("applies state defaults and the documented exceptions", () => {
    expect(timezoneFor("Eugene", "OR", 44.05, -123.09)).toBe("America/Los_Angeles");
    expect(timezoneFor("Ontario", "OR", 44.03, -116.96)).toBe("America/Denver");
    expect(timezoneFor("Dickinson", "ND", 46.88, -102.79)).toBe("America/Denver");
    expect(timezoneFor("Williston", "ND", 48.15, -103.62)).toBe("America/Chicago");
    expect(timezoneFor("Scottsbluff", "NE", 41.87, -103.66)).toBe("America/Denver");
    expect(timezoneFor("North Platte", "NE", 41.13, -100.76)).toBe("America/Chicago");
    expect(timezoneFor("Ironwood", "MI", 46.45, -90.17)).toBe("America/Chicago");
  });
});
