import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // One long-lived Node process, self-hosted: the event stream needs it.
  output: "standalone",
  // Every page is per-session and dynamic; the board changes by the second.
  cacheComponents: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@loadline/db", "@loadline/intake"],
  serverExternalPackages: ["pg"],
  typedRoutes: true,
};

export default nextConfig;
