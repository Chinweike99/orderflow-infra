# syntax=docker/dockerfile:1

# ---- Base: shared starting point for every stage -------------------------
FROM node:24-alpine AS base
WORKDIR /app

# ---- Stage 1: all dependencies (incl. dev) needed to compile -------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---- Stage 2: compile TypeScript → dist/ ---------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- Stage 3: production dependencies only -------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ---- Stage 4: runtime image ----------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node

# Probes and metrics only — the worker receives no client traffic
EXPOSE 3001

# Explicit for documentation: this is the signal the shutdown logic handles
STOPSIGNAL SIGTERM

CMD ["node", "dist/main.js"]
