import { can, type statements } from "@/lib/permissions";
import type { RequestContext } from "./context";
import { ForbiddenError } from "./errors";

type Resource = keyof typeof statements;
type Action<R extends Resource> = (typeof statements)[R][number];

/** Throw 403 unless the request's role may perform the action. The single place permissions are enforced. */
export function assertCan<R extends Resource>(
  ctx: Pick<RequestContext, "role">,
  resource: R,
  action: Action<R>,
): void {
  if (!can(ctx.role, resource, action)) {
    throw new ForbiddenError(`Role "${ctx.role}" may not ${action} ${resource}.`);
  }
}
