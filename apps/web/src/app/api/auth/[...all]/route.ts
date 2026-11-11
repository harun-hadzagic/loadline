import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { clientKey, LIMITS, limiter } from "@/server/rate-limit";

const handler = toNextJsHandler(auth.handler);

export const GET = handler.GET;

/** Sign-in attempts are rate limited per address; everything else passes straight to Better Auth. */
export async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.endsWith("/sign-in/email")) {
    try {
      limiter("sign-in", LIMITS.signIn).take(clientKey(request));
    } catch (err) {
      const retry =
        (err as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds ?? 60;
      return Response.json(
        { error: "Too many sign-in attempts. Try again later." },
        { status: 429, headers: { "retry-after": String(retry) } },
      );
    }
  }
  return handler.POST(request);
}
