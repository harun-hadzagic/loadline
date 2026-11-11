import type { Extraction } from "@loadline/intake";
import type { LoadDraft, StopDraft } from "@/components/load-form";
import type { CityOption } from "@/server/fleet";

export interface DraftFromExtraction {
  draft: LoadDraft;
  /** Fields the dispatcher must fill or check by hand, in plain words. */
  warnings: string[];
}

/**
 * Find the extracted city in the city table. A city with a state must match
 * both; a same-named city in another state is never substituted silently.
 * Without a state, only an unambiguous name matches.
 */
export function matchCity(
  cities: CityOption[],
  city: string | null,
  state: string | null,
): { city: CityOption | null; note: string | null } {
  if (!city) return { city: null, note: null };
  const wanted = city.trim().toLowerCase();
  const s = state?.trim().toUpperCase() || null;
  const byName = cities.filter((x) => x.name.toLowerCase() === wanted);
  const label = (x: CityOption) => `${x.name}, ${x.state}`;
  if (s) {
    const exact = byName.find((x) => x.state === s);
    if (exact) return { city: exact, note: null };
    return {
      city: null,
      note: byName.length
        ? `"${city}, ${s}" is not in the city table (it has ${byName.map(label).join(" and ")}); pick one.`
        : null,
    };
  }
  if (byName.length === 1) {
    const only = byName[0] as CityOption;
    return { city: only, note: `no state was given; ${label(only)} was assumed.` };
  }
  if (byName.length > 1)
    return {
      city: null,
      note: `"${city}" has no state and matches ${byName.map(label).join(", ")}; pick one.`,
    };
  return { city: null, note: null };
}

/** "YYYY-MM-DDTHH:mm" plus one hour, as wall-clock arithmetic (no zone involved). */
function plusOneHour(local: string): string {
  const [date, time] = local.split("T") as [string, string];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1, d, hh + 1, mm));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

/** "YYYY-MM-DDTHH:mm" from the extraction is already what a datetime-local input wants. */
function localValue(iso: string | null, fallback: string): string {
  return iso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(iso) ? iso : fallback;
}

/**
 * Turn an extraction into the load form's draft. The city table has about
 * 1,000 places; an unknown city leaves the picker empty and says so. Times
 * are kept as the stop's local wall-clock time; the form converts them in
 * the chosen city's zone when it submits.
 */
export function draftFromExtraction(x: Extraction, cities: CityOption[]): DraftFromExtraction {
  const warnings: string[] = [];
  const stops: StopDraft[] = x.stops.map((s, i) => {
    const where = `Stop ${i + 1}`;
    const match = matchCity(cities, s.city, s.state);
    if (!match.city)
      warnings.push(
        `${where}: ${match.note ?? `"${[s.city, s.state].filter(Boolean).join(", ") || "no city"}" is not in the city table; pick one.`}`,
      );
    else if (match.note) warnings.push(`${where}: ${match.note}`);
    let start = localValue(s.appointmentStart, "");
    let end = localValue(s.appointmentEnd, start);
    if (!start) warnings.push(`${where}: no appointment time was found.`);
    else if (start.endsWith("T00:00") && s.appointmentEnd === null) {
      // The extractors encode "a date, no time" as T00:00 with no end. That is
      // not an appointment at midnight: leave the window for the dispatcher.
      warnings.push(
        `${where}: only a date (${start.slice(0, 10)}) was found, no time; enter the appointment window.`,
      );
      start = "";
      end = "";
    } else if (end === start) {
      // A single appointment time: the form needs a window, so assume one hour.
      end = plusOneHour(start);
      warnings.push(`${where}: one appointment time was given; a one-hour window was assumed.`);
    }
    return {
      kind: s.kind,
      cityId: match.city ? String(match.city.id) : "",
      facilityName: s.facilityName ?? "",
      appointmentStart: start,
      appointmentEnd: end,
    };
  });
  if (stops.length < 2)
    warnings.push("Fewer than two stops were found; add the missing pickup or delivery.");
  if (x.rateUsd === null) warnings.push("No rate was found.");
  if (x.loadReference === null) warnings.push("No load reference was found.");
  return {
    draft: {
      reference: x.loadReference ?? "",
      brokerName: x.brokerName ?? "",
      commodity: x.commodity ?? "",
      weightLbs: x.weightLbs !== null ? String(x.weightLbs) : "",
      rateDollars: x.rateUsd !== null ? String(x.rateUsd) : "",
      equipment: x.equipment ?? "",
      notes: x.otherReferences.length
        ? x.otherReferences.map((r) => `${r.type}: ${r.value}`).join("; ")
        : "",
      stops,
    },
    warnings,
  };
}
