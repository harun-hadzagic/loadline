export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function pounds(lbs: number | null | undefined): string {
  if (lbs === null || lbs === undefined) return "—";
  return `${new Intl.NumberFormat("en-US").format(lbs)} lb`;
}

/** Appointment times are shown in the stop's local zone; everything else in the company's zone. */
export function inZone(
  iso: string | null | undefined,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...opts,
  }).format(new Date(iso));
}

export function windowInZone(start: string, end: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(start));
  const t = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(
      new Date(iso),
    );
  const abbr =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(new Date(start))
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${day}, ${t(start)}–${t(end)} ${abbr}`;
}

export const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  assigned: "Assigned",
  in_transit: "In transit",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export const EQUIPMENT_LABEL: Record<string, string> = {
  dry_van: "Dry van",
  reefer: "Reefer",
  flatbed: "Flatbed",
};

export function miles(meters: number): string {
  return `${Math.round(meters / 1609.344)} mi`;
}
