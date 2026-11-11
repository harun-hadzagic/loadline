# One-shot migrate image: roles, migrations, city table, seed.
FROM node:24-bookworm-slim

RUN npm install -g pnpm@12.18.0 --no-fund --no-audit

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile --filter @loadline/db

COPY packages/db packages/db

CMD ["pnpm", "--filter", "@loadline/db", "run", "setup"]
