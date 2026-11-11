import { describe, expect, it } from "vitest";
import { bearing, distanceMiles, jitterNear, stepToward } from "../src/geo.ts";

const dallas = { lat: 32.7933, lng: -96.7665 };
const houston = { lat: 29.7857, lng: -95.3888 };

describe("great-circle helpers", () => {
  it("measures Dallas to Houston at about 225 miles", () => {
    expect(distanceMiles(dallas, houston)).toBeGreaterThan(220);
    expect(distanceMiles(dallas, houston)).toBeLessThan(232);
  });
  it("heads south-east from Dallas to Houston", () => {
    const b = bearing(dallas, houston);
    expect(b).toBeGreaterThan(150);
    expect(b).toBeLessThan(170);
  });
  it("steps the requested distance toward the target and never past it", () => {
    const p = stepToward(dallas, houston, 50);
    expect(distanceMiles(dallas, p)).toBeCloseTo(50, 0);
    expect(distanceMiles(p, houston)).toBeCloseTo(distanceMiles(dallas, houston) - 50, 0);
    expect(stepToward(dallas, houston, 10_000)).toEqual(houston);
  });
  it("jitters within the idle radius of home", () => {
    let p = null as { lat: number; lng: number } | null;
    for (let i = 0; i < 200; i++) {
      p = jitterNear(dallas, p, 0.6);
      expect(distanceMiles(dallas, p)).toBeLessThanOrEqual(0.6);
    }
  });
});
