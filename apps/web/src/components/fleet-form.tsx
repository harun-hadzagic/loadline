"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveDriverAction, saveTruckAction } from "@/server/actions";
import type { CityOption, DriverView, TruckView } from "@/server/fleet";

type Props =
  | { kind: "driver"; cities: CityOption[]; driver?: DriverView }
  | { kind: "truck"; cities: CityOption[]; truck?: TruckView };

export function FleetForm(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const existing = props.kind === "driver" ? props.driver : props.truck;
  const title = existing ? "Edit" : props.kind === "driver" ? "Add driver" : "Add truck";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={existing ? "ghost" : "default"} size="sm" />}>
        {title}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const homeCityId = f.get("homeCityId") ? Number(f.get("homeCityId")) : null;
            const active = f.get("active") === "on";
            start(async () => {
              const result =
                props.kind === "driver"
                  ? await saveDriverAction(
                      { name: f.get("name"), phone: f.get("phone") || null, homeCityId, active },
                      props.driver?.id,
                    )
                  : await saveTruckAction(
                      {
                        unitNumber: f.get("unitNumber"),
                        equipment: f.get("equipment"),
                        homeCityId,
                        active,
                      },
                      props.truck?.id,
                    );
              if (!result.ok) {
                setError(result.message);
                toast.error(result.message);
                return;
              }
              setError(null);
              setOpen(false);
              toast.success("Saved");
              router.refresh();
            });
          }}
        >
          {props.kind === "driver" ? (
            <>
              <Field label="Name" id="name">
                <Input id="name" name="name" required defaultValue={props.driver?.name ?? ""} />
              </Field>
              <Field label="Phone" id="phone">
                <Input id="phone" name="phone" defaultValue={props.driver?.phone ?? ""} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Unit number" id="unitNumber">
                <Input
                  id="unitNumber"
                  name="unitNumber"
                  required
                  defaultValue={props.truck?.unitNumber ?? ""}
                />
              </Field>
              <Field label="Equipment" id="equipment">
                <select
                  id="equipment"
                  name="equipment"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  defaultValue={props.truck?.equipment ?? "dry_van"}
                >
                  <option value="dry_van">Dry van</option>
                  <option value="reefer">Reefer</option>
                  <option value="flatbed">Flatbed</option>
                </select>
              </Field>
            </>
          )}
          <Field label="Home city" id="homeCityId">
            <select
              id="homeCityId"
              name="homeCityId"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              defaultValue={existing?.homeCityId ?? ""}
            >
              <option value="">—</option>
              {props.cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}, {c.state}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="active" defaultChecked={existing?.active ?? true} /> Active
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
