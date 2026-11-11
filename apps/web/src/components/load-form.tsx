"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createLoadAction, updateLoadAction } from "@/server/actions";
import type { ActionResult } from "@/server/errors";
import type { CityOption } from "@/server/fleet";
import type { LoadView } from "@/server/loads";

export interface StopDraft {
  kind: "pickup" | "delivery";
  cityId: string;
  facilityName: string;
  appointmentStart: string; // datetime-local value, interpreted in the stop city's zone
  appointmentEnd: string;
}

export interface LoadDraft {
  reference: string;
  brokerName: string;
  commodity: string;
  weightLbs: string;
  rateDollars: string;
  equipment: "" | "dry_van" | "reefer" | "flatbed";
  notes: string;
  stops: StopDraft[];
}

const plusHours = (h: number) => {
  const d = new Date(Date.now() + h * 3_600_000);
  d.setMinutes(0, 0, 0);
  return d;
};

/** Format a Date as a datetime-local value in a given zone. */
export function toLocalInput(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

/** Interpret a datetime-local value as wall-clock time in a zone and return an ISO instant. */
export function fromLocalInput(value: string, timeZone: string): string {
  const [datePart, timePart] = value.split("T");
  const [y, m, d] = (datePart ?? "").split("-").map(Number);
  const [hh, mm] = (timePart ?? "").split(":").map(Number);
  // First guess: treat the wall time as UTC, then correct by the zone's offset at that instant (twice for DST edges).
  let guess = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  for (let i = 0; i < 2; i++) {
    const asLocal = toLocalInput(new Date(guess), timeZone);
    const [gd, gt] = asLocal.split("T");
    const [gy, gm, gday] = (gd ?? "").split("-").map(Number);
    const [gh, gmin] = (gt ?? "").split(":").map(Number);
    const seen = Date.UTC(gy ?? 1970, (gm ?? 1) - 1, gday ?? 1, gh ?? 0, gmin ?? 0);
    guess += Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0) - seen;
  }
  return new Date(guess).toISOString();
}

export function draftFromLoad(load: LoadView): LoadDraft {
  return {
    reference: load.reference,
    brokerName: load.brokerName ?? "",
    commodity: load.commodity ?? "",
    weightLbs: load.weightLbs?.toString() ?? "",
    rateDollars: load.rateCents !== null ? (load.rateCents / 100).toString() : "",
    equipment: load.equipment ?? "",
    notes: load.notes ?? "",
    stops: load.stops.map((s) => ({
      kind: s.kind,
      cityId: String(s.cityId),
      facilityName: s.facilityName ?? "",
      appointmentStart: toLocalInput(new Date(s.appointmentStart), s.timezone),
      appointmentEnd: toLocalInput(new Date(s.appointmentEnd), s.timezone),
    })),
  };
}

export function emptyDraft(defaultCity: CityOption | undefined): LoadDraft {
  const tz = defaultCity?.timezone ?? "America/Chicago";
  return {
    reference: "",
    brokerName: "",
    commodity: "",
    weightLbs: "",
    rateDollars: "",
    equipment: "",
    notes: "",
    stops: [
      {
        kind: "pickup",
        cityId: defaultCity ? String(defaultCity.id) : "",
        facilityName: "",
        appointmentStart: toLocalInput(plusHours(24), tz),
        appointmentEnd: toLocalInput(plusHours(26), tz),
      },
      {
        kind: "delivery",
        cityId: "",
        facilityName: "",
        appointmentStart: toLocalInput(plusHours(48), tz),
        appointmentEnd: toLocalInput(plusHours(52), tz),
      },
    ],
  };
}

export function draftToInput(draft: LoadDraft, cities: CityOption[]) {
  const zoneOf = (cityId: string) =>
    cities.find((c) => String(c.id) === cityId)?.timezone ?? "America/Chicago";
  return {
    reference: draft.reference,
    brokerName: draft.brokerName || null,
    commodity: draft.commodity || null,
    weightLbs: draft.weightLbs ? Number(draft.weightLbs) : null,
    rateCents: draft.rateDollars ? Math.round(Number(draft.rateDollars) * 100) : null,
    equipment: draft.equipment || null,
    notes: draft.notes || null,
    stops: draft.stops.map((s) => ({
      kind: s.kind,
      cityId: Number(s.cityId),
      facilityName: s.facilityName || null,
      appointmentStart: fromLocalInput(s.appointmentStart, zoneOf(s.cityId)),
      appointmentEnd: fromLocalInput(s.appointmentEnd, zoneOf(s.cityId)),
    })),
  };
}

interface Props {
  cities: CityOption[];
  load?: LoadView;
  initial?: LoadDraft;
  /** Called instead of navigating after a successful save (used by the intake panel). */
  onSaved?: (load: LoadView) => void;
}

export function LoadForm({ cities, load, initial, onSaved }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<LoadDraft>(
    () =>
      initial ?? (load ? draftFromLoad(load) : emptyDraft(cities.find((c) => c.name === "Dallas"))),
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const setStop = (i: number, patch: Partial<StopDraft>) =>
    setDraft((d) => ({ ...d, stops: d.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  const submit = () => {
    setError(null);
    start(async () => {
      const input = draftToInput(draft, cities);
      const result: ActionResult<LoadView> = load
        ? await updateLoadAction({ ...input, id: load.id, version: load.version })
        : await createLoadAction(input);
      if (!result.ok) {
        setError(result.message);
        toast.error(result.message);
        if (result.status === 409) router.refresh();
        return;
      }
      toast.success(load ? "Load updated" : `Load ${result.data.reference} created`);
      if (onSaved) onSaved(result.data);
      else {
        router.push(`/loads/${result.data.id}`);
        router.refresh();
      }
    });
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Reference" htmlFor="reference">
          <Input
            id="reference"
            required
            value={draft.reference}
            onChange={(e) => setDraft({ ...draft, reference: e.target.value })}
          />
        </Field>
        <Field label="Broker" htmlFor="broker">
          <Input
            id="broker"
            value={draft.brokerName}
            onChange={(e) => setDraft({ ...draft, brokerName: e.target.value })}
          />
        </Field>
        <Field label="Commodity" htmlFor="commodity">
          <Input
            id="commodity"
            value={draft.commodity}
            onChange={(e) => setDraft({ ...draft, commodity: e.target.value })}
          />
        </Field>
        <Field label="Equipment" htmlFor="equipment">
          <select
            id="equipment"
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={draft.equipment}
            onChange={(e) =>
              setDraft({ ...draft, equipment: e.target.value as LoadDraft["equipment"] })
            }
          >
            <option value="">Any</option>
            <option value="dry_van">Dry van</option>
            <option value="reefer">Reefer</option>
            <option value="flatbed">Flatbed</option>
          </select>
        </Field>
        <Field label="Weight (lb)" htmlFor="weight">
          <Input
            id="weight"
            type="number"
            min={0}
            value={draft.weightLbs}
            onChange={(e) => setDraft({ ...draft, weightLbs: e.target.value })}
          />
        </Field>
        <Field label="Rate (USD)" htmlFor="rate">
          <Input
            id="rate"
            type="number"
            min={0}
            step="0.01"
            value={draft.rateDollars}
            onChange={(e) => setDraft({ ...draft, rateDollars: e.target.value })}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Stops</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft((d) => {
                const last = d.stops[d.stops.length - 1];
                const stop: StopDraft = {
                  kind: "delivery",
                  cityId: "",
                  facilityName: "",
                  appointmentStart:
                    last?.appointmentEnd ?? toLocalInput(plusHours(72), "America/Chicago"),
                  appointmentEnd:
                    last?.appointmentEnd ?? toLocalInput(plusHours(76), "America/Chicago"),
                };
                return { ...d, stops: [...d.stops, stop] };
              })
            }
          >
            Add stop
          </Button>
        </div>
        {draft.stops.map((s, i) => (
          <div
            key={`${i}-${s.kind}`}
            className="grid gap-3 rounded-md border p-3 sm:grid-cols-6"
            data-testid={`stop-${i}`}
          >
            <Field label="Kind" htmlFor={`kind-${i}`}>
              <select
                id={`kind-${i}`}
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={s.kind}
                onChange={(e) => setStop(i, { kind: e.target.value as StopDraft["kind"] })}
              >
                <option value="pickup">Pickup</option>
                <option value="delivery">Delivery</option>
              </select>
            </Field>
            <Field label="City" htmlFor={`city-${i}`} className="sm:col-span-2">
              <select
                id={`city-${i}`}
                required
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={s.cityId}
                onChange={(e) => setStop(i, { cityId: e.target.value })}
              >
                <option value="">Choose a city</option>
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}, {c.state}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Facility" htmlFor={`facility-${i}`} className="sm:col-span-3">
              <Input
                id={`facility-${i}`}
                value={s.facilityName}
                onChange={(e) => setStop(i, { facilityName: e.target.value })}
              />
            </Field>
            <Field label="Window start (local)" htmlFor={`start-${i}`} className="sm:col-span-3">
              <Input
                id={`start-${i}`}
                type="datetime-local"
                required
                value={s.appointmentStart}
                onChange={(e) => setStop(i, { appointmentStart: e.target.value })}
              />
            </Field>
            <Field label="Window end (local)" htmlFor={`end-${i}`} className="sm:col-span-2">
              <Input
                id={`end-${i}`}
                type="datetime-local"
                required
                value={s.appointmentEnd}
                onChange={(e) => setStop(i, { appointmentEnd: e.target.value })}
              />
            </Field>
            <div className="flex items-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={draft.stops.length <= 2}
                onClick={() =>
                  setDraft((d) => ({ ...d, stops: d.stops.filter((_, j) => j !== i) }))
                }
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>

      <Field label="Notes" htmlFor="notes">
        <Textarea
          id="notes"
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : load ? "Save changes" : "Create load"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`grid gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
