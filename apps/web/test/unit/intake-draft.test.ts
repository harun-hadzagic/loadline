import type { Extraction } from "@loadline/intake";
import { describe, expect, it } from "vitest";
import { draftFromExtraction, matchCity } from "@/lib/intake-draft";
import type { CityOption } from "@/server/fleet";

const cities: CityOption[] = [
  { id: 1, name: "Springfield", state: "MO", timezone: "America/Chicago" },
  { id: 2, name: "Springfield", state: "IL", timezone: "America/Chicago" },
  { id: 3, name: "Tulsa", state: "OK", timezone: "America/Chicago" },
] as CityOption[];

const stop = (over: Partial<Extraction["stops"][number]>): Extraction["stops"][number] => ({
  kind: "pickup",
  facilityName: null,
  city: null,
  state: null,
  appointmentStart: null,
  appointmentEnd: null,
  ...over,
});
const base: Extraction = {
  brokerName: null,
  loadReference: "X-1",
  stops: [],
  rateUsd: 100,
  weightLbs: null,
  commodity: null,
  equipment: null,
  otherReferences: [],
};

describe("matchCity", () => {
  it("matches name and state, and never substitutes the same name in another state", () => {
    expect(matchCity(cities, "Tulsa", "OK").city?.id).toBe(3);
    expect(matchCity(cities, "tulsa ", "ok").city?.id).toBe(3);
    const miss = matchCity(cities, "Tulsa", "TX");
    expect(miss.city).toBeNull();
    expect(miss.note).toMatch(/Tulsa, TX.*Tulsa, OK/);
  });

  it("without a state, matches only an unambiguous name and says what it assumed", () => {
    const one = matchCity(cities, "Tulsa", null);
    expect(one.city?.id).toBe(3);
    expect(one.note).toMatch(/assumed/);
    const many = matchCity(cities, "Springfield", null);
    expect(many.city).toBeNull();
    expect(many.note).toMatch(/Springfield, MO.*Springfield, IL/);
    expect(matchCity(cities, "Nowhere", null)).toEqual({ city: null, note: null });
  });
});

describe("draftFromExtraction", () => {
  it("leaves a date-only stop's window empty and says so, instead of inventing midnight", () => {
    const { draft, warnings } = draftFromExtraction(
      {
        ...base,
        stops: [
          stop({ city: "Tulsa", state: "OK", appointmentStart: "2026-12-01T00:00" }),
          stop({
            kind: "delivery",
            city: "Tulsa",
            state: "OK",
            appointmentStart: "2026-12-02T00:00",
            appointmentEnd: "2026-12-02T00:00",
          }),
        ],
      },
      cities,
    );
    expect(draft.stops[0]).toMatchObject({ appointmentStart: "", appointmentEnd: "" });
    expect(warnings).toContainEqual(expect.stringMatching(/Stop 1: only a date \(2026-12-01\)/));
    // A genuine midnight appointment (start = end) keeps the one-hour rule.
    expect(draft.stops[1]).toMatchObject({
      appointmentStart: "2026-12-02T00:00",
      appointmentEnd: "2026-12-02T01:00",
    });
  });

  it("widens a single time to an hour, keeps a range, and warns about cities it could not place", () => {
    const { draft, warnings } = draftFromExtraction(
      {
        ...base,
        stops: [
          stop({
            city: "Tulsa",
            state: "TX",
            appointmentStart: "2026-11-20T08:00",
            appointmentEnd: "2026-11-20T08:00",
          }),
          stop({
            kind: "delivery",
            city: "Springfield",
            state: "IL",
            appointmentStart: "2026-11-21T10:00",
            appointmentEnd: "2026-11-21T16:00",
          }),
        ],
      },
      cities,
    );
    expect(draft.stops[0]).toMatchObject({
      cityId: "",
      appointmentStart: "2026-11-20T08:00",
      appointmentEnd: "2026-11-20T09:00",
    });
    expect(draft.stops[1]).toMatchObject({ cityId: "2", appointmentEnd: "2026-11-21T16:00" });
    expect(warnings).toContainEqual(
      expect.stringMatching(/Stop 1: "Tulsa, TX" is not in the city table/),
    );
    expect(warnings).toContainEqual(expect.stringMatching(/one-hour window/));
  });
});
