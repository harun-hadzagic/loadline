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

describe("date and window parsing", () => {
  it("reads the formats the fixtures use", () => {
    expect(parseDate("Nov 20, 2026 0800")?.date).toBe("2026-11-20");
    expect(parseDate("11-22-26 @ 10:00-16:00")?.date).toBe("2026-11-22");
    expect(parseDate("2026-11-21 10:00 AM to 4:00 PM")?.date).toBe("2026-11-21");
    expect(parseDate("Tue 11/18 7am-3pm")?.date).toBe("2026-11-18");
    expect(parseWindow("Nov 20, 2026 0800")).toEqual({
      start: "2026-11-20T08:00",
      end: "2026-11-20T08:00",
    });
    expect(parseWindow("11-22-26 @ 10:00-16:00")).toEqual({
      start: "2026-11-22T10:00",
      end: "2026-11-22T16:00",
    });
    expect(parseWindow("2026-11-21 10:00 AM to 4:00 PM")).toEqual({
      start: "2026-11-21T10:00",
      end: "2026-11-21T16:00",
    });
    expect(parseWindow("12/07/2026 FCFS 1000-1600")).toEqual({
      start: "2026-12-07T10:00",
      end: "2026-12-07T16:00",
    });
    expect(parseWindow("Tue 11/18 7am-3pm")).toEqual({
      start: "2026-11-18T07:00",
      end: "2026-11-18T15:00",
    });
    expect(parseWindow("12/01/2026")).toEqual({ start: "2026-12-01T00:00", end: null });
  });
});

describe("the regex baseline", () => {
  it("returns a schema-valid extraction for every fixture without throwing", () => {
    for (const f of fixtures)
      expect(() => extractionSchema.parse(extractWithBaseline(f.document))).not.toThrow();
  });

  it("gets the plain email fixture 001 entirely right", () => {
    const f = fixtures.find((x) => x.name.startsWith("001"))!;
    const score = scoreDocument(f.name, extractWithBaseline(f.document), f.expected);
    expect(score.fields).toEqual(
      Object.fromEntries(Object.keys(score.fields).map((k) => [k, true])),
    );
  });

  it("never obeys an injected instruction: the rate and weight stay what the document states", () => {
    for (const f of fixtures.filter((x) => x.injected)) {
      const got = extractWithBaseline(f.document);
      expect(got.rateUsd, f.name).not.toBe(9999);
      expect(got.rateUsd, f.name).not.toBe(0);
      expect(got.weightLbs, f.name).not.toBe(1);
      expect(got.loadReference, f.name).not.toBe("000000");
    }
  });

  it("clears a measured floor on the whole set (the eval result file is the number that counts)", () => {
    const s = summarize(
      fixtures.map((f) => scoreDocument(f.name, extractWithBaseline(f.document), f.expected)),
    );
    // A floor, not a target: the point of the baseline is to be beaten by the Claude extractor.
    expect(s.fieldAccuracy).toBeGreaterThan(0.5);
    expect(s.fields.loadReference.accuracy).toBeGreaterThan(0.8);
    expect(s.fields.rateUsd.accuracy).toBeGreaterThan(0.7);
  });
});
