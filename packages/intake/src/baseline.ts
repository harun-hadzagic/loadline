import {
  EMPTY_EXTRACTION,
  type ExtractedStop,
  type Extraction,
  extractedStopSchema,
  extractionSchema,
} from "./schema.ts";

/**
 * The regex baseline. No API key, no network: a set of patterns tuned on the
 * layouts in fixtures/. It exists so the new-load page works without a key
 * and so the Claude extractor has a measured bar to clear. Because it was
 * tuned on the same sixty documents the eval scores, its score is an upper
 * bound for those layouts, not a general figure; on a layout it has not seen
 * it is expected to be wrong often.
 */

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
/** Documents often omit the year; callers pass the one to assume (the app: this year). */
const thisYear = () => new Date().getFullYear();

/** True for a real calendar date (no 13th month, no 31 November). */
function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  ),
);

const pad = (n: number) => String(n).padStart(2, "0");

/** Parse a date in any of the fixture formats to YYYY-MM-DD, or null. */
export function parseDate(
  text: string,
  defaultYear: number = thisYear(),
): { date: string; end: number } | null {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const us = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(text);
  const mon =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,)?(?:\s+(\d{4}))?/i.exec(
      text,
    );
  const candidates: Array<{ idx: number; date: string; end: number }> = [];
  if (iso && validDate(Number(iso[1]), Number(iso[2]), Number(iso[3])))
    candidates.push({
      idx: iso.index,
      date: `${iso[1]}-${iso[2]}-${iso[3]}`,
      end: iso.index + iso[0].length,
    });
  if (us) {
    const y = us[3] ? (us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3])) : defaultYear;
    const m = Number(us[1]);
    const d = Number(us[2]);
    if (validDate(y, m, d))
      candidates.push({
        idx: us.index,
        date: `${y}-${pad(m)}-${pad(d)}`,
        end: us.index + us[0].length,
      });
  }
  if (mon) {
    const m =
      MONTHS[(mon[1] as string).toLowerCase().slice(0, 4)] ??
      MONTHS[(mon[1] as string).toLowerCase().slice(0, 3)];
    const y = mon[3] ? Number(mon[3]) : defaultYear;
    if (m && validDate(y, m, Number(mon[2])))
      candidates.push({
        idx: mon.index,
        date: `${y}-${pad(m)}-${pad(Number(mon[2]))}`,
        end: mon.index + mon[0].length,
      });
  }
  candidates.sort((a, b) => a.idx - b.idx);
  const first = candidates[0];
  return first ? { date: first.date, end: first.end } : null;
}

/** Parse "0800", "8:00 AM", "14:00", "7am", "1000" to HH:mm. */
function parseTime(raw: string): string | null {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (raw.trim().length === 4 && !m[2] && !ap) {
    // "0800" / "1600" written without a colon
    h = Number(raw.trim().slice(0, 2));
    return `${pad(h)}:${raw.trim().slice(2)}`;
  }
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

// "0830" must be tried before "08", or "0830-1630" reads as 08:00-16:00.
const TIME_TOKEN = String.raw`\d{4}(?!\d)|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?`;
// Both anchored at the start of what follows the date: a time is "right
// after the date", never a number found somewhere later in the text, so a
// street number or a print stamp two lines down cannot become an appointment.
const LEAD = String.raw`^\s*(?:@|at|appt\.?|appointment:?|fcfs)?\s*`;
const TIME_RANGE = new RegExp(
  String.raw`${LEAD}(${TIME_TOKEN})\s*(?:-|–|to|thru|through)\s*(${TIME_TOKEN})(?![\d:])`,
  "i",
);
const TIME_SINGLE = new RegExp(String.raw`${LEAD}(${TIME_TOKEN})(?![\d:/-])`, "i");

/**
 * Parse an appointment window following a date: "0800", "10:00-16:00",
 * "FCFS 0600-1400", "8:00 AM to 4:00 PM". The time must follow the date on
 * the same line, or stand alone on the next line when the date ends its
 * line (the PDF layout). A date with no time is T00:00 with no end.
 */
export function parseWindow(
  text: string,
  defaultYear: number = thisYear(),
): { start: string | null; end: string | null } {
  const d = parseDate(text, defaultYear);
  if (!d) return { start: null, end: null };
  const after = text.slice(d.end);
  const sameLine = (after.split("\n")[0] ?? "").replace(/^\s*(?:@|at|,)?\s*/i, "").slice(0, 60);
  const nextLine = (after.split("\n")[1] ?? "").trim().slice(0, 60);
  // The next line counts only when it is nothing but a time or a time range.
  const wholeLineTime = new RegExp(
    String.raw`${LEAD}(?:${TIME_TOKEN})(?:\s*(?:-|–|to|thru|through)\s*(?:${TIME_TOKEN}))?\s*\.?$`,
    "i",
  );
  const candidates = /\S/.test(sameLine)
    ? [sameLine]
    : [nextLine].filter((l) => wholeLineTime.test(l));
  for (const rest of candidates) {
    const range = TIME_RANGE.exec(rest);
    if (range) {
      const a = parseTime(range[1] as string);
      const b = parseTime(range[2] as string);
      if (a && b) return { start: `${d.date}T${a}`, end: `${d.date}T${b}` };
    }
    const single = TIME_SINGLE.exec(rest);
    if (single) {
      const t = parseTime(single[1] as string);
      if (t) return { start: `${d.date}T${t}`, end: `${d.date}T${t}` };
    }
  }
  return { start: `${d.date}T00:00`, end: null };
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bLlc\b/g, "LLC")
    .replace(/\bInc\b/g, "Inc")
    .replace(/\bDc\b/g, "DC");
}

const BROKER_WORDS = /(brokerage|logistics|freight|cargo|transport(?:ation)?(?: services)?)/i;

function findBroker(text: string): string | null {
  const explicit =
    /(?:booked with|broker:|brokered by|broker name:?)\s*([A-Z][A-Za-z&.'-]*(?:\s+[A-Z][A-Za-z&.'-]*){0,5}?(?:\s+(?:LLC|Inc\.?|Co\.?|Corp\.?))?)(?=\s*(?:\(|\n|,|MC|$))/im.exec(
      text,
    );
  if (explicit?.[1]) return explicit[1].trim();
  // A company name carrying a brokerage word, as written in signatures or headers.
  const re =
    /\b((?:[A-Z][A-Za-z&.'-]+\s+){0,4}(?:Brokerage|Logistics|Freight(?:\s+Brokerage)?|Cargo(?:\s+\w+)?|Transport(?:\s+Services)?)(?:\s+(?:LLC|Inc\.?|Partners|Group|Co\.?))?)\b/g;
  const counts = new Map<string, number>();
  for (const m of text.matchAll(re)) {
    const name = (m[1] as string).trim();
    if (!BROKER_WORDS.test(name)) continue;
    if (/^(Carrier|Rate|Load|Total|Line|Fuel)\b/i.test(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const upper =
    /^([A-Z][A-Z&.' -]{6,}(?:LLC|INC|BROKERAGE|LOGISTICS|FREIGHT|CARGO|GROUP|PARTNERS))\s*$/m.exec(
      text,
    );
  if (upper?.[1]) {
    const name = titleCase(upper[1].trim());
    counts.set(name, (counts.get(name) ?? 0) + 2);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
  return best ? best[0] : null;
}

function findLoadReference(text: string): string | null {
  // One whitespace class between the keyword and the value, never several
  // overlapping ones: the Phase 6 review found the previous shape backtracked
  // in O(n^4) on a long run of spaces and could stall the process for minutes.
  const re =
    /\b(?:order|load|pro|reference|ref|confirmation)\b[\s:#]*(?:no\.?|number)?[\s:#]*([A-Z]{1,5}-?\d{4,9})\b/i;
  const m = re.exec(text);
  return m?.[1] ?? null;
}

function parseWeight(text: string): number | null {
  const m =
    /(?:weight|wt|gross)[^0-9\n]{0,20}([\d,]+(?:\.\d+)?)\s*(k\b|lbs?|pounds|tons?)?/i.exec(text) ??
    /\b([\d,]{4,7})\s*(lbs|pounds)\b/i.exec(text);
  if (!m) return null;
  const n = Number((m[1] as string).replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit.startsWith("k")) return Math.round(n * 1000);
  if (unit.startsWith("ton")) return Math.round(n * 2000);
  return Math.round(n);
}

function parseEquipment(text: string): Extraction["equipment"] {
  const ctx = /equipment(?:\s*type)?\s*(?:is|:)?\s*\n?\s*([^\n|]+)/i.exec(text)?.[1] ?? text;
  if (/reefer|refrigerated|\bR\b(?!\w)/i.test(ctx) && !/trailer/i.test(ctx.slice(0, 3)))
    return "reefer";
  if (/flat\s*bed|step\s*deck|\bFB\b/i.test(ctx)) return "flatbed";
  if (/dry\s*van|\bvan\b|\bDV\b/i.test(ctx)) return "dry_van";
  return null;
}

function parseCommodity(text: string): string | null {
  const m =
    /commodity(?:\s*is|:)?\s*\n?\s*([^\n.|]+?)(?=\s*(?:\||\n|\.|,\s*(?:weight|equipment)|$))/i.exec(
      text,
    );
  return m?.[1]?.trim() || null;
}

function money(s: string): number {
  return Number(s.replace(/[$,]/g, ""));
}

function parseRate(text: string): number | null {
  // Only labelled totals count; prose such as "the carrier pays $0" in a notes field must not.
  const total =
    /(?:total(?:\s+rate)?|all[- ]in|grand total)\b[^$\n]{0,30}\$\s?([\d,]+(?:\.\d{2})?)/i.exec(
      text,
    );
  if (total) return money(total[1] as string);
  const paying =
    /(?:paying|rate(?:\s*is)?:?|carrier rate:?|agreed rate:?)\s*(?:is\s*)?\$\s?([\d,]+(?:\.\d{2})?)/i.exec(
      text,
    );
  const lineHaul = /line\s*haul[^$\n]{0,20}\$\s?([\d,]+(?:\.\d{2})?)/i.exec(text);
  if (lineHaul) {
    let sum = money(lineHaul[1] as string);
    const fsc = /(?:fuel(?:\s*surcharge)?|fsc)[^$\n]{0,20}\$\s?([\d,]+(?:\.\d{2})?)/i.exec(text);
    if (fsc) sum += money(fsc[1] as string);
    for (const m of text.matchAll(
      /(?:stop[- ]off|detention|accessorial|lumper|tarp)[^$\n]{0,30}\$\s?([\d,]+(?:\.\d{2})?)/gi,
    ))
      sum += money(m[1] as string);
    return sum;
  }
  if (paying) return money(paying[1] as string);
  return null;
}

const REF_TYPES: Array<[RegExp, string]> = [
  [/\bPO\b/i, "PO"],
  [/\bBOL\b/i, "BOL"],
  [/pick\s*-?\s*up/i, "pickup number"],
  [/deliver(?:y)?/i, "delivery number"],
  [/shipper\s*ref/i, "shipper ref"],
  [/trailer/i, "trailer"],
];

function parseOtherReferences(text: string, loadRef: string | null): Extraction["otherReferences"] {
  const out: Extraction["otherReferences"] = [];
  const seen = new Set<string>();
  const re =
    /\b(PO|BOL|Pickup|Pick-up|Delivery|Shipper Ref(?:erence)?|Trailer)\b[\s:#]*(?:no\.?|number)?[\s:#]*([A-Z]{1,4}-?\d{3,9})\b/gi;
  for (const m of text.matchAll(re)) {
    const label = m[1] as string;
    const value = m[2] as string;
    if (value === loadRef || seen.has(value)) continue;
    const type = REF_TYPES.find(([r]) => r.test(label))?.[1];
    if (!type) continue;
    seen.add(value);
    out.push({ type, value });
  }
  return out;
}

interface Segment {
  kind: "pickup" | "delivery";
  text: string;
}

const STOP_MARKER =
  /(?:^|\n)\s*(?:(PU:|PICKUP|Pickup(?:\s+is\s+at|\s*#?\s*\d*:)?|Shipper:|Origin:)|(DEL:|DELIVERY|Delivery(?:\s+is\s+at|\s*#?\s*\d*:)?|Receiver:|Consignee:|Destination:))/g;

function segments(text: string): Segment[] {
  const marks: Array<{ idx: number; kind: "pickup" | "delivery"; len: number }> = [];
  for (const m of text.matchAll(STOP_MARKER)) {
    const start = m.index + m[0].indexOf(m[1] ?? (m[2] as string));
    marks.push({
      idx: start,
      kind: m[1] ? "pickup" : "delivery",
      len: (m[1] ?? m[2] ?? "").length,
    });
  }
  const out: Segment[] = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i] as (typeof marks)[number];
    const next = marks[i + 1]?.idx ?? Math.min(text.length, m.idx + 600);
    const body = text.slice(m.idx + m.len, next);
    // Skip markers that are only in boilerplate ("Pickup #" references, "Delivery" in terms).
    if (!/[A-Z]{2}\b/.test(body)) continue;
    out.push({ kind: m.kind, text: body });
  }
  return out;
}

function parseStop(seg: Segment, defaultYear: number): ExtractedStop | null {
  const t = seg.text.replace(/\r/g, "");
  // City, ST: allow the PDF layout's "City,\nST".
  const cs = /([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3}),\s*\n?\s*([A-Z]{2})\b/.exec(t);
  let city: string | null = null;
  let state: string | null = null;
  if (cs && STATES.has(cs[2] as string)) {
    city = cs[1] as string;
    state = cs[2] as string;
  }
  // Facility: the text right after the marker, up to a comma, a bare number (address) or the city.
  let facility: string | null = null;
  const head = t
    .replace(/^\s*(?:is at\s*)?/, "")
    .split("\n")
    .slice(0, 3)
    .join(" ")
    .trim();
  const fm =
    /^([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z0-9][A-Za-z0-9&.'-]*){0,5})(?=\s*(?:,|\s\d{2,6}\s|\s{2,}|$))/.exec(
      head,
    );
  if (fm?.[1]) facility = fm[1].replace(/\s+(?:Appointment|Appt)$/i, "").trim();
  if (facility && city && facility.includes(city))
    facility = facility.slice(0, facility.indexOf(city)).trim() || null;
  const apptText =
    t.includes("Appointment") || t.includes("Appt") ? t.slice(t.search(/Appointment|Appt/i)) : t;
  const win = parseWindow(apptText, defaultYear);
  if (!city && !win.start) return null;
  return {
    kind: seg.kind,
    facilityName: facility,
    city,
    state,
    appointmentStart: win.start,
    appointmentEnd: win.end,
  };
}

export interface BaselineOptions {
  /** Year assumed when a document omits it; defaults to the current year. */
  defaultYear?: number;
}

export function extractWithBaseline(input: string, opts: BaselineOptions = {}): Extraction {
  const defaultYear = opts.defaultYear ?? thisYear();
  // Bound every whitespace run before any pattern sees the text: runs of
  // spaces to three (the PDF layout's column gaps stay recognisable as "two or
  // more"), blank lines to two. Every pattern's backtracking is then bounded
  // by a constant, whatever is pasted.
  const text = input
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]{4,}/g, "   ")
    .replace(/\n(?:[^\S\n]*\n){2,}/g, "\n\n");
  const loadReference = findLoadReference(text);
  const stops = segments(text)
    .map((seg) => parseStop(seg, defaultYear))
    // A stop the patterns mangled (an odd state code, a malformed time) is dropped, never thrown.
    .filter((s): s is ExtractedStop => s !== null && extractedStopSchema.safeParse(s).success);
  const finite = (n: number | null) => (n !== null && Number.isFinite(n) ? n : null);
  const result: Extraction = {
    ...EMPTY_EXTRACTION,
    brokerName: findBroker(text),
    loadReference,
    stops,
    rateUsd: finite(parseRate(text)),
    weightLbs: finite(parseWeight(text)),
    commodity: parseCommodity(text),
    equipment: parseEquipment(text),
    otherReferences: parseOtherReferences(text, loadReference),
  };
  // The baseline must always answer; whatever still fails validation is blanked rather than thrown.
  const parsed = extractionSchema.safeParse(result);
  return parsed.success ? parsed.data : { ...EMPTY_EXTRACTION, stops: [] };
}
