# The Next.js app as one long-lived Node process (output: "standalone").
FROM node:24-bookworm-slim AS deps
RUN npm install -g pnpm@12.18.0 --no-fund --no-audit
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/intake/package.json packages/intake/package.json
RUN pnpm install --frozen-lockfile --filter @loadline/web...

FROM deps AS build
COPY packages/db packages/db
COPY packages/intake packages/intake
COPY apps/web apps/web
# No database is reachable at build time; Better Auth does not validate the schema then.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @loadline/web build

FROM node:24-bookworm-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3000
USER node
CMD ["node", "apps/web/server.js"]
