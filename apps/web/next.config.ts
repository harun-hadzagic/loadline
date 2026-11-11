import type { NextConfig } from "next";

// Security headers for every response. The content security policy allows
// the OpenFreeMap tiles and style (and their fonts/sprites), MapLibre's blob
// workers, inline styles (Tailwind's runtime values and MapLibre's markers),
// and the app's own event stream; nothing else.
const CSP = [
  "default-src 'self'",
  // Next.js dev needs eval; production keeps inline for the RSC bootstrap and nothing else.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tiles.openfreemap.org",
  "font-src 'self' data: https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "child-src blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // One long-lived Node process, self-hosted: the event stream needs it.
  output: "standalone",
  // Every page is per-session and dynamic; the board changes by the second.
  cacheComponents: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@loadline/db", "@loadline/intake"],
  serverExternalPackages: ["pg"],
  typedRoutes: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
