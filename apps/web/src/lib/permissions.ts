// The one module that says who may do what. Better Auth's organization plugin
// stores the role on the membership; these statements decide what each role
// can do inside Loadline. Database policies separately keep drivers to their
// own loads, whatever this module says.
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

export const statements = {
  ...defaultStatements,
  load: ["create", "update", "assign", "cancel", "pickup", "deliver"],
  intake: ["use"],
  fleet: ["read", "manage"],
  board: ["read"],
  map: ["read"],
  company: ["update", "delete"],
} as const;

export const ac = createAccessControl(statements);

export const dispatcher = ac.newRole({
  load: ["create", "update", "assign", "cancel", "pickup", "deliver"],
  intake: ["use"],
  fleet: ["read"],
  board: ["read"],
  map: ["read"],
});

export const admin = ac.newRole({
  ...dispatcher.statements,
  fleet: ["read", "manage"],
  company: ["update"],
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

export const owner = ac.newRole({
  ...admin.statements,
  company: ["update", "delete"],
  organization: ["update", "delete"],
});

export const driver = ac.newRole({
  load: ["pickup", "deliver"],
});

export const roles = { owner, admin, dispatcher, driver } as const;
export type RoleName = keyof typeof roles;
export const ROLE_NAMES = Object.keys(roles) as RoleName[];

export function isRoleName(value: string): value is RoleName {
  return value in roles;
}

type Resource = keyof typeof statements;
type Action<R extends Resource> = (typeof statements)[R][number];

/** Pure check used by server actions and route handlers (and by the role matrix test). */
export function can<R extends Resource>(role: RoleName, resource: R, action: Action<R>): boolean {
  const result = roles[role].authorize({ [resource]: [action] } as never);
  return result.success;
}
