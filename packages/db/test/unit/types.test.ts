import { describe, expect, it } from "vitest";
import { parseCsvLine } from "../../src/cities.ts";
import { formatTstzRange, parseEwkbPoint, parseTstzRange } from "../../src/schema/types.ts";

describe("tstzrange", () => {
  it("parses the text form PostgreSQL returns", () => {
    const r = parseTstzRange('["2026-11-11 16:00:00+00","2026-11-12 04:30:00.5+00")');
    expect(r.lower?.toISOString()).toBe("2026-11-11T16:00:00.000Z");
    expect(r.upper?.toISOString()).toBe("2026-11-12T04:30:00.500Z");
  });
  it("handles unbounded sides and offsets with minutes", () => {
    expect(parseTstzRange('["2026-11-11 10:00:00-05:30",)').upper).toBeNull();
    expect(parseTstzRange('["2026-11-11 10:00:00-05:30",)').lower?.toISOString()).toBe(
      "2026-11-11T15:30:00.000Z",
    );
    expect(parseTstzRange("empty")).toEqual({ lower: null, upper: null });
  });
  it("formats half-open ranges", () => {
    const lower = new Date("2026-01-01T00:00:00Z");
    const upper = new Date("2026-01-02T00:00:00Z");
    expect(formatTstzRange({ lower, upper })).toBe(
      '["2026-01-01T00:00:00.000Z","2026-01-02T00:00:00.000Z")',
    );
    expect(formatTstzRange({ lower, upper: null })).toBe('["2026-01-01T00:00:00.000Z",)');
  });
});

describe("EWKB point", () => {
  it("parses a little-endian point with SRID", () => {
    const buf = Buffer.alloc(25);
    buf.writeUInt8(1, 0);
    buf.writeUInt32LE(0x20000001, 1);
    buf.writeUInt32LE(4326, 5);
    buf.writeDoubleLE(-96.7665, 9);
    buf.writeDoubleLE(32.7933, 17);
    expect(parseEwkbPoint(buf.toString("hex"))).toEqual({ lng: -96.7665, lat: 32.7933 });
  });
  it("rejects non-points", () => {
    const buf = Buffer.alloc(9);
    buf.writeUInt8(1, 0);
    buf.writeUInt32LE(2, 1);
    expect(() => parseEwkbPoint(buf.toString("hex"))).toThrow(/Point/);
  });
});

describe("csv", () => {
  it("splits plain and quoted fields", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseCsvLine('1,"St. Louis, MO",x')).toEqual(["1", "St. Louis, MO", "x"]);
    expect(parseCsvLine('"say ""hi""",2')).toEqual(['say "hi"', "2"]);
  });
});
