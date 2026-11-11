import Link from "next/link";

export function Forbidden({ message = "Your role cannot open this page." }: { message?: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center" data-testid="forbidden">
      <h1 className="text-lg font-semibold">Not allowed</h1>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      <Link href="/" className="mt-4 inline-block text-sm underline underline-offset-4">
        Back to your start page
      </Link>
    </div>
  );
}
