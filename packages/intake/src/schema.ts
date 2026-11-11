import { z } from "zod";

// The one extraction schema. Every field may be null when the document does
// not state it. Times are the stop's local wall-clock time without a zone
// ("YYYY-MM-DDTHH:mm"); the city resolves the zone later. Money is dollars
// (the total rate: line haul plus fuel surcharge and accessorials when the
// document states them). Weight is pounds.

export const equipmentSchema = z.enum(["dry_van", "reefer", "flatbed"]);

export const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "local time as YYYY-MM-DDTHH:mm");

export const extractedStopSchema = z.object({
  kind: z.enum(["pickup", "delivery"]),
  facilityName: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().length(2).nullable(),
  appointmentStart: localDateTime.nullable(),
  appointmentEnd: localDateTime.nullable(),
});

export const extractionSchema = z.object({
  brokerName: z.string().nullable(),
  loadReference: z.string().nullable(),
  stops: z.array(extractedStopSchema),
  rateUsd: z.number().nullable(),
  weightLbs: z.number().int().nullable(),
  commodity: z.string().nullable(),
  equipment: equipmentSchema.nullable(),
  otherReferences: z.array(z.object({ type: z.string(), value: z.string() })),
});

export type Extraction = z.infer<typeof extractionSchema>;
export type ExtractedStop = z.infer<typeof extractedStopSchema>;

export const EMPTY_EXTRACTION: Extraction = {
  brokerName: null,
  loadReference: null,
  stops: [],
  rateUsd: null,
  weightLbs: null,
  commodity: null,
  equipment: null,
  otherReferences: [],
};

/** JSON Schema for the Claude structured-output request; kept in step with the Zod schema by a test. */
export const extractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "brokerName",
    "loadReference",
    "stops",
    "rateUsd",
    "weightLbs",
    "commodity",
    "equipment",
    "otherReferences",
  ],
  properties: {
    brokerName: { type: ["string", "null"] },
    loadReference: { type: ["string", "null"] },
    stops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "facilityName", "city", "state", "appointmentStart", "appointmentEnd"],
        properties: {
          kind: { type: "string", enum: ["pickup", "delivery"] },
          facilityName: { type: ["string", "null"] },
          city: { type: ["string", "null"] },
          state: { type: ["string", "null"], description: "Two-letter US state code" },
          appointmentStart: {
            type: ["string", "null"],
            description: "Local time, YYYY-MM-DDTHH:mm",
          },
          appointmentEnd: { type: ["string", "null"], description: "Local time, YYYY-MM-DDTHH:mm" },
        },
      },
    },
    rateUsd: {
      type: ["number", "null"],
      description: "Total rate in US dollars including fuel surcharge",
    },
    weightLbs: { type: ["integer", "null"] },
    commodity: { type: ["string", "null"] },
    equipment: { type: ["string", "null"], enum: ["dry_van", "reefer", "flatbed", null] },
    otherReferences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "value"],
        properties: { type: { type: "string" }, value: { type: "string" } },
      },
    },
  },
} as const;
