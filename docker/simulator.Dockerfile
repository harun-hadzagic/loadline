# The position simulator: a small Node service that posts to the app.
FROM node:24-bookworm-slim
RUN npm install -g pnpm@12.18.0 --no-fund --no-audit
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/simulator/package.json apps/simulator/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile --filter @loadline/simulator...
COPY packages/db packages/db
COPY apps/simulator apps/simulator
USER node
CMD ["pnpm", "--filter", "@loadline/simulator", "start"]
