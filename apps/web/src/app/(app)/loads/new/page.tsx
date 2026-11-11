import { Forbidden } from "@/components/forbidden";
import { LoadForm } from "@/components/load-form";
import { can } from "@/lib/permissions";
import { requireContext } from "@/server/context";
import { listCities } from "@/server/fleet";

export default async function NewLoadPage() {
  const ctx = await requireContext();
  if (!can(ctx.role, "load", "create")) return <Forbidden />;
  const cities = await listCities(ctx);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold">New load</h1>
      <LoadForm cities={cities} />
    </div>
  );
}
