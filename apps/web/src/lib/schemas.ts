import { z } from "zod";

export const equipmentSchema = z.enum(["dry_van", "reefer", "flatbed"]);
export const loadStatusSchema = z.enum([
  "open",
  "assigned",
  "in_transit",
  "delivered",
  "cancelled",
]);
export const stopKindSchema = z.enum(["pickup", "delivery"]);

const isoDate = z.iso.datetime({ offset: true }).or(z.iso.datetime());

export const stopInputSchema = z
  .object({
    kind: stopKindSchema,
    cityId: z.coerce.number().int().positive(),
    facilityName: z.string().trim().max(120).nullish(),
    appointmentStart: isoDate,
    appointmentEnd: isoDate,
  })
  .refine((s) => new Date(s.appointmentEnd) > new Date(s.appointmentStart), {
    message: "The appointment window must end after it starts.",
    path: ["appointmentEnd"],
  });

export type StopInput = z.infer<typeof stopInputSchema>;

/** Stop list rules shared by create and edit: pickup first, delivery last, time order. */
function checkStops(stops: StopInput[], ctx: z.RefinementCtx): void {
  if (stops[0]?.kind !== "pickup") {
    ctx.addIssue({ code: "custom", message: "The first stop must be a pickup.", path: ["stops"] });
  }
  if (stops[stops.length - 1]?.kind !== "delivery") {
    ctx.addIssue({ code: "custom", message: "The last stop must be a delivery.", path: ["stops"] });
  }
  const ordered = stops.every(
    (s, i) =>
      i === 0 || new Date(s.appointmentStart) >= new Date(stops[i - 1]?.appointmentStart ?? 0),
  );
  if (!ordered)
    ctx.addIssue({ code: "custom", message: "Stops must be in time order.", path: ["stops"] });
}

// Kept free of refinements so .partial() works for the edit schema.
const loadBaseSchema = z.object({
  reference: z.string().trim().min(1).max(40),
  brokerName: z.string().trim().max(120).nullish(),
  commodity: z.string().trim().max(120).nullish(),
  weightLbs: z.coerce.number().int().min(0).max(200_000).nullish(),
  rateCents: z.coerce.number().int().min(0).max(100_000_000).nullish(),
  equipment: equipmentSchema.nullish(),
  notes: z.string().trim().max(2000).nullish(),
  stops: z.array(stopInputSchema).min(2).max(10),
});

export const loadInputSchema = loadBaseSchema.superRefine((l, ctx) => checkStops(l.stops, ctx));
export type LoadInput = z.infer<typeof loadInputSchema>;

export const loadPatchSchema = loadBaseSchema
  .partial()
  .extend({ id: z.uuid(), version: z.number().int().positive() })
  .superRefine((l, ctx) => {
    if (l.stops) checkStops(l.stops, ctx);
  });
export type LoadPatch = z.infer<typeof loadPatchSchema>;

export const assignInputSchema = z.object({
  loadId: z.uuid(),
  version: z.number().int().positive(),
  driverId: z.uuid(),
  truckId: z.uuid(),
});
export type AssignInput = z.infer<typeof assignInputSchema>;

export const transitionInputSchema = z.object({
  loadId: z.uuid(),
  version: z.number().int().positive(),
  to: loadStatusSchema,
});
export type TransitionInput = z.infer<typeof transitionInputSchema>;

export const driverInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(30).nullish(),
  homeCityId: z.coerce.number().int().positive().nullish(),
  active: z.boolean().default(true),
  /** Email of an existing member to link, or null. */
});
export type DriverInput = z.infer<typeof driverInputSchema>;

export const truckInputSchema = z.object({
  unitNumber: z.string().trim().min(1).max(20),
  equipment: equipmentSchema,
  homeCityId: z.coerce.number().int().positive().nullish(),
  active: z.boolean().default(true),
});
export type TruckInput = z.infer<typeof truckInputSchema>;
