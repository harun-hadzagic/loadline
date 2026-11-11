import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";
import { Providers } from "@/components/providers";
import { requireContext } from "@/server/context";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireContext();
  return (
    <div className="flex min-h-screen flex-col">
      <AppNav
        role={ctx.role}
        userName={ctx.userName}
        companyName={ctx.companyName}
        canSeeFleet={ctx.role !== "driver"}
      />
      <Providers>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </Providers>
    </div>
  );
}
