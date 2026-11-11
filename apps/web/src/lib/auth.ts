import { authPool, firstOrganizationForUser } from "@loadline/db";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins/organization";
import { ac, roles } from "./permissions";

/**
 * Better Auth: email and password, sessions in cookies, the organization
 * plugin with Loadline's four roles. Its tables live in the auth schema and
 * are reached only through loadline_auth (see packages/db authPool()).
 */
export const auth = betterAuth({
  appName: "Loadline",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: authPool(),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 },
  },
  advanced: {
    database: { generateId: "uuid" },
    useSecureCookies:
      process.env.NODE_ENV === "production" &&
      (process.env.BETTER_AUTH_URL ?? "").startsWith("https"),
  },
  telemetry: { enabled: false },
  databaseHooks: {
    session: {
      create: {
        // A person belongs to one company in 0.1: make it active at sign-in,
        // so the organization is on the session from the first request.
        before: async (session) => {
          const organizationId = await firstOrganizationForUser(session.userId);
          return { data: { ...session, activeOrganizationId: organizationId } };
        },
      },
    },
  },
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: "owner",
      // Companies are created by the seed or by an owner; sign-up alone does not make one.
      allowUserToCreateOrganization: false,
      disableOrganizationDeletion: true,
    }),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
