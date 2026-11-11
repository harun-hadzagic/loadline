"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

interface Props {
  role: string;
  userName: string;
  companyName: string;
  canSeeFleet: boolean;
}

export function AppNav({ role, userName, companyName, canSeeFleet }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const links =
    role === "driver"
      ? [{ href: "/driver", label: "My loads" }]
      : [
          { href: "/board", label: "Board" },
          { href: "/map", label: "Map" },
          { href: "/loads", label: "Loads" },
          ...(canSeeFleet
            ? [
                { href: "/fleet/drivers", label: "Drivers" },
                { href: "/fleet/trucks", label: "Trucks" },
              ]
            : []),
        ];
  return (
    <header className="flex items-center gap-4 border-b px-4 py-2 md:px-6">
      <Link href="/" className="font-semibold tracking-tight">
        Loadline
      </Link>
      <span className="hidden text-sm text-muted-foreground sm:inline">{companyName}</span>
      <nav className="flex items-center gap-1">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm hover:bg-accent",
              pathname.startsWith(l.href) ? "bg-accent font-medium" : "text-muted-foreground",
            )}
          >
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <span className="text-sm text-muted-foreground" data-testid="current-user">
          {userName} · {role}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await authClient.signOut();
            router.push("/sign-in");
            router.refresh();
          }}
        >
          Sign out
        </Button>
      </div>
    </header>
  );
}
