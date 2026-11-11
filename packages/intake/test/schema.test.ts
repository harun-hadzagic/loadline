import { describe, expect, it } from "vitest";
import { EMPTY_EXTRACTION, extractionJsonSchema, extractionSchema } from "../src/schema.ts";

describe("the extraction schema", () => {
  it("accepts an all-null document and rejects the wrong shapes", () => {
    expect(() => extractionSchema.parse(EMPTY_EXTRACTION)).not.toThrow();
    expect(() => extractionSchema.parse({ ...EMPTY_EXTRACTION, rateUsd: "$1" })).toThrow();
    expect(() => extractionSchema.parse({ ...EMPTY_EXTRACTION, equipment: "tanker" })).toThrow();
    expect(() =>
      extractionSchema.parse({
        ...EMPTY_EXTRACTION,
        stops: [
          {
            kind: "pickup",
            facilityName: null,
            city: "Dallas",
            state: "TX",
            appointmentStart: "11/18 8am",
            appointmentEnd: null,
          },
        ],
      }),
    ).toThrow();
  });

  it("keeps the JSON schema for structured output in step with the Zod schema", () => {
    const zodKeys = Object.keys(extractionSchema.shape).sort();
    expect(Object.keys(extractionJsonSchema.properties).sort()).toEqual(zodKeys);
    expect([...extractionJsonSchema.required].sort()).toEqual(zodKeys);
    const stopKeys = Object.keys(extractionSchema.shape.stops.element.shape).sort();
    expect(Object.keys(extractionJsonSchema.properties.stops.items.properties).sort()).toEqual(
      stopKeys,
    );
    expect([...extractionJsonSchema.properties.stops.items.required].sort()).toEqual(stopKeys);
    expect(extractionJsonSchema.properties.equipment.enum).toEqual([
      "dry_van",
      "reefer",
      "flatbed",
      null,
    ]);
  });
});
