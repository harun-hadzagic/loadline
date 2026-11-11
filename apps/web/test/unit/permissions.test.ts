import { describe, expect, it } from "vitest";
import { can, ROLE_NAMES, type RoleName, statements } from "@/lib/permissions";

// The role matrix: every role against every action. This is the single table
// the application consults, so a change here is a product decision.
const EXPECTED: Record<RoleName, string[]> = {
  owner: [
    "load:create",
    "load:update",
    "load:assign",
    "load:cancel",
    "load:pickup",
    "load:deliver",
    "intake:use",
    "fleet:read",
    "fleet:manage",
    "board:read",
    "map:read",
    "company:update",
    "company:delete",
    "organization:update",
    "organization:delete",
    "member:create",
    "member:update",
    "member:delete",
    "invitation:create",
    "invitation:cancel",
  ],
  admin: [
    "load:create",
    "load:update",
    "load:assign",
    "load:cancel",
    "load:pickup",
    "load:deliver",
    "intake:use",
    "fleet:read",
    "fleet:manage",
    "board:read",
    "map:read",
    "company:update",
    "organization:update",
    "member:create",
    "member:update",
    "member:delete",
    "invitation:create",
    "invitation:cancel",
  ],
  dispatcher: [
    "load:create",
    "load:update",
    "load:assign",
    "load:cancel",
    "load:pickup",
    "load:deliver",
    "intake:use",
    "fleet:read",
    "board:read",
    "map:read",
  ],
  driver: ["load:pickup", "load:deliver"],
};

describe("role matrix", () => {
  const all: string[] = [];
  for (const [resource, actions] of Object.entries(statements)) {
    for (const action of actions) all.push(`${resource}:${action}`);
  }

  for (const role of ROLE_NAMES) {
    it(`${role} may do exactly the expected actions`, () => {
      const allowed = all.filter((key) => {
        const [resource, action] = key.split(":") as [keyof typeof statements, string];
        return can(role, resource, action as never);
      });
      expect(allowed.sort()).toEqual([...EXPECTED[role]].sort());
    });
  }

  it("drivers can never create, assign or cancel loads, or touch the fleet", () => {
    for (const action of ["create", "update", "assign", "cancel"] as const)
      expect(can("driver", "load", action)).toBe(false);
    expect(can("driver", "fleet", "read")).toBe(false);
    expect(can("driver", "fleet", "manage")).toBe(false);
    expect(can("driver", "board", "read")).toBe(false);
  });
});
