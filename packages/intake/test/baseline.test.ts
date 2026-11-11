import { describe, expect, it } from "vitest";
import { extractWithBaseline, parseDate, parseWindow } from "../src/baseline.ts";
import { scoreDocument, summarize } from "../src/eval/score.ts";
import { loadFixtures } from "../src/fixtures.ts";
import { extractionSchema } from "../src/schema.ts";

const fixtures = loadFixtures();

describe("fixtures", () => {
  it("has 60 documents, 8 of them with an injection attempt, all validating against the schema", () => {
    expect(fixtures).toHaveLength(60);
    expect(fixtures.filter((f) => f.injected).map((f) => f.name.slice(0, 3))).toEqual([
      "008",
      "015",
      "023",
      "031",
      "039",
      "046",
      "052",
      "058",
    ]);
    for (const f of fixtures) expect(() => extractionSchema.parse(f.expected)).not.toThrow();
  });
});

const Y = 2026;

describe("date and window parsing", () => {
  it("reads the formats the fixtures use", () => {
    expect(parseDate("Nov 20, 2026 0800", Y)?.date).toBe("2026-11-20");
    expect(parseDate("11-22-26 @ 10:00-16:00", Y)?.date).toBe("2026-11-22");
    expect(parseDate("2026-11-21 10:00 AM to 4:00 PM", Y)?.date).toBe("2026-11-21");
    expect(parseDate("Tue 11/18 7am-3pm", Y)?.date).toBe("2026-11-18");
    expect(parseWindow("Nov 20, 2026 0800", Y)).toEqual({
      start: "2026-11-20T08:00",
      end: "2026-11-20T08:00",
    });
    expect(parseWindow("11-22-26 @ 10:00-16:00", Y)).toEqual({
      start: "2026-11-22T10:00",
      end: "2026-11-22T16:00",
    });
    expect(parseWindow("2026-11-21 10:00 AM to 4:00 PM", Y)).toEqual({
      start: "2026-11-21T10:00",
      end: "2026-11-21T16:00",
    });
    expect(parseWindow("12/07/2026 FCFS 1000-1600", Y)).toEqual({
      start: "2026-12-07T10:00",
      end: "2026-12-07T16:00",
    });
    expect(parseWindow("Tue 11/18 7am-3pm", Y)).toEqual({
      start: "2026-11-18T07:00",
      end: "2026-11-18T15:00",
    });
    expect(parseWindow("12/01/2026", Y)).toEqual({ start: "2026-12-01T00:00", end: null });
  });

  it("keeps the minutes of a four-digit range (0830-1630 is not 08:00-16:00)", () => {
    expect(parseWindow("Nov 20, 2026 0830-1630", Y)).toEqual({
      start: "2026-11-20T08:30",
      end: "2026-11-20T16:30",
    });
    expect(parseWindow("Appt 12-04-26\n@ 09:30", Y)).toEqual({
      start: "2026-12-04T09:30",
      end: "2026-12-04T09:30",
    });
    expect(parseWindow("Appt Dec 1, 2026\n0800", Y)).toEqual({
      start: "2026-12-01T08:00",
      end: "2026-12-01T08:00",
    });
  });

  it("does not read a street number or a print stamp as an appointment time", () => {
    // The time must follow the date; a number further on is not one.
    expect(parseWindow("12/01/2026\n1234 Industrial Pkwy", Y)).toEqual({
      start: "2026-12-01T00:00",
      end: null,
    });
    expect(parseWindow("Appointment: 12/01/2026. Printed 11/12/2026 14:32:07", Y)).toEqual({
      start: "2026-12-01T00:00",
      end: null,
    });
    expect(parseWindow("12/01/2026 Dock 7", Y)).toEqual({ start: "2026-12-01T00:00", end: null });
  });

  it("rejects impossible dates and assumes the year it is given", () => {
    expect(parseDate("13/45/2026", Y)).toBeNull();
    expect(parseDate("Nov 31 2026", Y)).toBeNull();
    expect(parseDate("2026-02-30", Y)).toBeNull();
    expect(parseDate("Tue 11/18", 2031)?.date).toBe("2031-11-18");
    expect(parseDate("Tue 11/18")?.date).toBe(`${new Date().getFullYear()}-11-18`);
  });
});

describe("the regex baseline", () => {
  it("returns a schema-valid extraction for every fixture without throwing", () => {
    for (const f of fixtures)
      expect(() =>
        extractionSchema.parse(extractWithBaseline(f.document, { defaultYear: Y })),
      ).not.toThrow();
  });

  it("never throws on hostile or empty input", () => {
    for (const text of [
      "",
      "\u0000\uffff",
      "Pickup: ,, ZZ\nAppointment: 99/99/99 25:61",
      "x".repeat(50_000),
    ])
      expect(() =>
        extractionSchema.parse(extractWithBaseline(text, { defaultYear: Y })),
      ).not.toThrow();
  });

  it("gets the plain email fixture 001 entirely right", () => {
    const f = fixtures.find((x) => x.name.startsWith("001"))!;
    const score = scoreDocument(
      f.name,
      extractWithBaseline(f.document, { defaultYear: Y }),
      f.expected,
    );
    expect(score.fields).toEqual(
      Object.fromEntries(Object.keys(score.fields).map((k) => [k, true])),
    );
  });

  it("never obeys an injected instruction: the rate and weight stay what the document states", () => {
    for (const f of fixtures.filter((x) => x.injected)) {
      const got = extractWithBaseline(f.document, { defaultYear: Y });
      expect(got.rateUsd, f.name).not.toBe(9999);
      expect(got.rateUsd, f.name).not.toBe(0);
      expect(got.weightLbs, f.name).not.toBe(1);
      expect(got.loadReference, f.name).not.toBe("000000");
    }
  });

  it("clears a measured floor on the whole set (the eval result file is the number that counts)", () => {
    const s = summarize(
      fixtures.map((f) =>
        scoreDocument(f.name, extractWithBaseline(f.document, { defaultYear: Y }), f.expected),
      ),
    );
    // A floor, not a target: the point of the baseline is to be beaten by the Claude extractor.
    expect(s.fieldAccuracy).toBeGreaterThan(0.5);
    expect(s.fields.loadReference.accuracy).toBeGreaterThan(0.8);
    expect(s.fields.rateUsd.accuracy).toBeGreaterThan(0.7);
  });
});
