import { redirect } from "next/navigation";
import { getContext } from "@/server/context";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  const ctx = await getContext().catch(() => null);
  if (ctx) redirect(ctx.role === "driver" ? "/driver" : "/loads");
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Loadline</h1>
        <p className="text-sm text-muted-foreground">Sign in to your company's dispatch board.</p>
      </div>
      <SignInForm />
      <p className="text-xs text-muted-foreground">
        Demo logins are listed in the README. Every demo account uses the password from{" "}
        <code>DEMO_PASSWORD</code> in your <code>.env</code>.
      </p>
    </main>
  );
}
