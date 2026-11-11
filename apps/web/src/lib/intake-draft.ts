import type { Extraction } from "@loadline/intake";
import type { LoadDraft, StopDraft } from "@/components/load-form";
import type { CityOption } from "@/server/fleet";

export interface DraftFromExtraction {
  draft: LoadDraft;
  /** Fields the dispatcher must fill or check by hand, in plain words. */
  warnings: string[];
}

function matchCity(
  cities: CityOption[],
  city: string | null,
  state: string | null,
): CityOption | null {
  if (!city) return null;
  const c = city.trim().toLowerCase();
  const s = state?.trim().toUpperCase() ?? null;
  return (
    cities.find((x) => x.name.toLowerCase() === c && (!s || x.state === s)) ??
    cities.find((x) => x.name.toLowerCase() === c) ??
    null
  );
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
    const city = matchCity(cities, s.city, s.state);
    if (!city)
      warnings.push(
        `Stop ${i + 1}: "${[s.city, s.state].filter(Boolean).join(", ") || "no city"}" is not in the city table; pick one.`,
      );
    const start = localValue(s.appointmentStart, "");
    let end = localValue(s.appointmentEnd, start);
    if (!start) warnings.push(`Stop ${i + 1}: no appointment time was found.`);
    if (start && end === start) {
      // A single appointment time: the form needs a window, so assume one hour.
      end = plusOneHour(start);
      warnings.push(
        `Stop ${i + 1}: one appointment time was given; a one-hour window was assumed.`,
      );
    }
    return {
      kind: s.kind,
      cityId: city ? String(city.id) : "",
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
