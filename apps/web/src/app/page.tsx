import { redirect } from "next/navigation";
import { requireContext } from "@/server/context";

export const dynamic = "force-dynamic";

export default async function Home() {
  const ctx = await requireContext();
  redirect(ctx.role === "driver" ? "/driver" : "/loads");
}
