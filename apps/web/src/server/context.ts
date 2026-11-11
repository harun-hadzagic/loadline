import { type AppRole, companyIdForOrg, type TenantContext, withTenant } from "@loadline/db";
import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";
import { isRoleName, type RoleName } from "@/lib/permissions";
import { AppError } from "./errors";

export interface RequestContext {
  userId: string;
  userName: string;
  email: string;
  orgId: string;
  companyId: string;
  companyName: string;
  companyTimezone: string;
  role: RoleName;
  /** Set when the signed-in user is linked to a driver row. */
  driverId: string | null;
}

/** The withTenant context for this request. */
export function tenant(ctx: RequestContext): TenantContext {
  return {
    companyId: ctx.companyId,
    role: ctx.role as AppRole,
    userId: ctx.userId,
    driverId: ctx.driverId,
  };
}

async function resolve(): Promise<RequestContext | null> {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) return null;

  let orgId = session.session.activeOrganizationId ?? null;
  if (!orgId) {
    const orgs = await auth.api.listOrganizations({ headers: h });
    const first = orgs[0];
    if (!first) throw new AppError(403, "Your account is not a member of any company.");
    orgId = first.id;
    await auth.api.setActiveOrganization({ headers: h, body: { organizationId: orgId } });
  }

  const member = await auth.api.getActiveMember({ headers: h });
  // Better Auth may store several roles comma-separated; Loadline gives one per membership.
  const roleName = (member?.role ?? "").split(",")[0]?.trim() ?? "";
  if (!isRoleName(roleName))
    throw new AppError(403, `Unknown role "${roleName}" on this membership.`);

  const companyId = await companyIdForOrg(orgId);
  if (!companyId)
    throw new AppError(
      500,
      "This organization has no company row. Run the seed or create the company.",
    );

  const details = await withTenant(
    { companyId, role: "system", userId: session.user.id },
    async (tx) => {
      const company = await tx.execute<{ name: string; timezone: string }>(
        sql`SELECT name, timezone FROM app.companies WHERE id = ${companyId}`,
      );
      const driver = await tx.execute<{ id: string }>(
        sql`SELECT id FROM app.drivers WHERE user_id = ${session.user.id} AND active`,
      );
      return { company: company.rows[0], driverId: driver.rows[0]?.id ?? null };
    },
  );
  if (!details.company) throw new AppError(500, "Company row is missing.");
  if (roleName === "driver" && !details.driverId) {
    throw new AppError(
      403,
      "This driver account is not linked to a driver. Ask an admin to link it.",
    );
  }

  return {
    userId: session.user.id,
    userName: session.user.name,
    email: session.user.email,
    orgId,
    companyId,
    companyName: details.company.name,
    companyTimezone: details.company.timezone,
    role: roleName,
    driverId: details.driverId,
  };
}

/** Per-request cached context, or null when nobody is signed in. */
export const getContext = cache(resolve);

/** Context or a redirect to the sign-in page. For pages. */
export async function requireContext(): Promise<RequestContext> {
  const ctx = await getContext();
  if (!ctx) redirect("/sign-in");
  return ctx;
}

/** Context or a 401 AppError. For actions and route handlers. */
export async function requireContextOrThrow(): Promise<RequestContext> {
  const ctx = await getContext();
  if (!ctx) throw new AppError(401, "Sign in first.");
  return ctx;
}
