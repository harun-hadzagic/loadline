import type { ExtractedStop, Extraction } from "../schema.ts";

// Scoring: exact match after normalising case, whitespace, money and dates.
// Per field, over all documents, plus whole-document accuracy.
//
// What the numbers do and do not say:
// - "stops" is one field: the whole list must match, in order, every
//   sub-field. One wrong minute on one stop fails the field. The stopFields
//   breakdown is only counted when the stop counts agree; a missing or extra
//   stop counts every sub-field of that document as a miss.
// - Field accuracy is the unweighted mean of the eight per-field accuracies,
//   so a rare field weighs as much as the rate.
// - Text fields are compared after lower-casing and stripping punctuation;
//   "Sterling Plastics Inc." and "sterling plastics inc" match, a different
//   spelling does not. There is no partial credit.

export const FIELDS = [
  "brokerName",
  "loadReference",
  "stops",
  "rateUsd",
  "weightLbs",
  "commodity",
  "equipment",
  "otherReferences",
] as const;
export type Field = (typeof FIELDS)[number];

export const STOP_FIELDS = [
  "kind",
  "facilityName",
  "city",
  "state",
  "appointmentStart",
  "appointmentEnd",
] as const;

export function normText(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = v
    .toLowerCase()
    .replace(/[.,;:#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s === "" ? null : s;
}

export function normMoney(v: number | null | undefined): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.round(v * 100) / 100;
}

export function normInt(v: number | null | undefined): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.round(v);
}

/** Dates compare as "YYYY-MM-DDTHH:mm"; anything unparsable compares as its trimmed text. */
export function normDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(v.trim());
  if (!m) return v.trim().toLowerCase();
  return `${m[1]}-${m[2]}-${m[3]}T${(m[4] as string).padStart(2, "0")}:${m[5]}`;
}

export function normStop(s: ExtractedStop): Record<string, string | null> {
  return {
    kind: s.kind,
    facilityName: normText(s.facilityName),
    city: normText(s.city),
    state: normText(s.state),
    appointmentStart: normDate(s.appointmentStart),
    appointmentEnd: normDate(s.appointmentEnd),
  };
}

function normRefs(refs: Extraction["otherReferences"]): string[] {
  return refs.map((r) => `${normText(r.type) ?? ""}=${normText(r.value) ?? ""}`).sort();
}

export function normalizeField(field: Field, x: Extraction): unknown {
  switch (field) {
    case "brokerName":
      return normText(x.brokerName);
    case "loadReference":
      return normText(x.loadReference);
    case "commodity":
      return normText(x.commodity);
    case "equipment":
      return x.equipment;
    case "rateUsd":
      return normMoney(x.rateUsd);
    case "weightLbs":
      return normInt(x.weightLbs);
    case "stops":
      return x.stops.map(normStop);
    case "otherReferences":
      return normRefs(x.otherReferences);
  }
}

export function fieldMatches(field: Field, got: Extraction, expected: Extraction): boolean {
  return (
    JSON.stringify(normalizeField(field, got)) === JSON.stringify(normalizeField(field, expected))
  );
}

export interface DocumentScore {
  name: string;
  fields: Record<Field, boolean>;
  /** Per stop sub-field matches, for the breakdown; counted only when the stop counts agree. */
  stopFields: Record<(typeof STOP_FIELDS)[number], { matched: number; total: number }>;
  allCorrect: boolean;
}

export function scoreDocument(name: string, got: Extraction, expected: Extraction): DocumentScore {
  const fields = Object.fromEntries(
    FIELDS.map((f) => [f, fieldMatches(f, got, expected)]),
  ) as Record<Field, boolean>;
  const stopFields = Object.fromEntries(
    STOP_FIELDS.map((f) => [f, { matched: 0, total: 0 }]),
  ) as DocumentScore["stopFields"];
  if (got.stops.length === expected.stops.length) {
    expected.stops.forEach((e, i) => {
      const g = normStop(got.stops[i] as ExtractedStop);
      const ne = normStop(e);
      for (const f of STOP_FIELDS) {
        stopFields[f].total++;
        if (g[f] === ne[f]) stopFields[f].matched++;
      }
    });
  } else {
    for (const f of STOP_FIELDS) stopFields[f].total += expected.stops.length;
  }
  return { name, fields, stopFields, allCorrect: FIELDS.every((f) => fields[f]) };
}

export interface Summary {
  documents: number;
  documentAccuracy: number;
  /** Mean of the per-field accuracies. */
  fieldAccuracy: number;
  fields: Record<Field, { accuracy: number; correct: number }>;
  stopFields: Record<
    (typeof STOP_FIELDS)[number],
    { accuracy: number; matched: number; total: number }
  >;
  failures: Array<{ name: string; wrong: Field[] }>;
}

export function summarize(scores: DocumentScore[]): Summary {
  const n = scores.length || 1;
  const fields = Object.fromEntries(
    FIELDS.map((f) => {
      const correct = scores.filter((s) => s.fields[f]).length;
      return [f, { accuracy: correct / n, correct }];
    }),
  ) as Summary["fields"];
  const stopFields = Object.fromEntries(
    STOP_FIELDS.map((f) => {
      const matched = scores.reduce((a, s) => a + s.stopFields[f].matched, 0);
      const total = scores.reduce((a, s) => a + s.stopFields[f].total, 0);
      return [f, { accuracy: total ? matched / total : 0, matched, total }];
    }),
  ) as Summary["stopFields"];
  return {
    documents: scores.length,
    documentAccuracy: scores.filter((s) => s.allCorrect).length / n,
    fieldAccuracy: FIELDS.reduce((a, f) => a + fields[f].accuracy, 0) / FIELDS.length,
    fields,
    stopFields,
    failures: scores
      .filter((s) => !s.allCorrect)
      .map((s) => ({ name: s.name, wrong: FIELDS.filter((f) => !s.fields[f]) })),
  };
}
