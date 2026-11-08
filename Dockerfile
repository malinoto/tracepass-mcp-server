# TracePass MCP server — hosted HTTP service.
#
# Two-stage build: compile TypeScript in a full-deps stage, then run
# from a slim stage with production deps only. The same image runs
# the HTTP service (default CMD); the npm package is published
# separately from the same `dist/` output.
#
# Served at https://ai.tracepass.eu/mcp once deployed (see
# tracepass-environment/docker-mcp.yml).

# ---- build stage --------------------------------------------------
# Base image pinned tag@digest (reproducible builds); Dependabot
# (.github/dependabot.yml) proposes the digest bumps.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app

# Install ALL deps (incl. devDependencies) for the tsc build.
COPY package.json package-lock.json* ./
RUN npm ci

# Compile src/ -> dist/.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ------------------------------------------------
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only — no typescript / vitest / eslint.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# The compiled output.
COPY --from=build /app/dist ./dist

# Run as the non-root `node` user the base image provides.
USER node

EXPOSE 8080
# The HTTP service entrypoint. PORT + TRACEPASS_BASE_URL are read
# from the environment (see the compose file).
CMD ["node", "dist/http.js"]
