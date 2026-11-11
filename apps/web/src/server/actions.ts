"use server";

import { revalidatePath } from "next/cache";
import {
  assignInputSchema,
  driverInputSchema,
  loadInputSchema,
  loadPatchSchema,
  transitionInputSchema,
  truckInputSchema,
} from "@/lib/schemas";
import { requireContextOrThrow } from "./context";
import { type ActionResult, toActionResult } from "./errors";
import { saveDriver, saveTruck } from "./fleet";
import { assignLoad, createLoad, type LoadView, transitionLoad, updateLoad } from "./loads";

// Server actions: validate with Zod, resolve the session, call the service,
// and return a plain result the client can act on (409s carry the current state).

export async function createLoadAction(input: unknown): Promise<ActionResult<LoadView>> {
  return toActionResult(async () => {
    const ctx = await requireContextOrThrow();
    const load = await createLoad(ctx, loadInputSchema.parse(input));
    revalidatePath("/loads");
    return load;
  });
}

export async function updateLoadAction(input: unknown): Promise<ActionResult<LoadView>> {
  return toActionResult(async () => {
    const ctx = await requireContextOrThrow();
    const load = await updateLoad(ctx, loadPatchSchema.parse(input));
    revalidatePath("/loads");
    revalidatePath(`/loads/${load.id}`);
    return load;
  });
}

export async function assignLoadAction(input: unknown): Promise<ActionResult<LoadView>> {
  return toActionResult(async () => {
    const ctx = await requireContextOrThrow();
    const load = await assignLoad(ctx, assignInputSchema.parse(input));
    revalidatePath("/loads");
    revalidatePath(`/loads/${load.id}`);
    return load;
  });
}

export async function transitionLoadAction(input: unknown): Promise<ActionResult<LoadView>> {
  return toActionResult(async () => {
    const ctx = await requireContextOrThrow();
    const load = await transitionLoad(ctx, transitionInputSchema.parse(input));
    revalidatePath("/loads");
    revalidatePath(`/loads/${load.id}`);
    revalidatePath("/driver");
    return load;
  });
}

export async function saveDriverAction(input: unknown, id?: string): Promise<ActionResult<string>> {
  return toActionResult(async () => {
    const ctx = await requireContextOrThrow();
    const result = await saveDriver(ctx, driverInputSchema.parse(input), id);
    revalidatePath("/fleet/drivers");
    return result;
  });
}

export async function saveTruckAction(input: unknown, id?: string): Promise<ActionResult<string>> {
  return toActionResult(async () => {
    const ctx = await requireContextOrThrow();
    const result = await saveTruck(ctx, truckInputSchema.parse(input), id);
    revalidatePath("/fleet/trucks");
    return result;
  });
}
