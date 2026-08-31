# NestJS API and agent worker. One image, two entry points (ADR-016).
#
# Multi-stage so the runtime image carries no compiler and no dev dependency.
# The build context is the repository root because the npm workspace lockfile
# lives there.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
# The frontend manifest is copied only so the workspace lockfile resolves; its
# dependencies are not installed into this image.
RUN npm ci --workspace backend --include-workspace-root

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY package.json package-lock.json ./
COPY backend ./backend
RUN cd backend && npx nest build

FROM node:20-alpine AS runtime
WORKDIR /app/backend
ENV NODE_ENV=production

# Runs unprivileged. The node image already provides a `node` user.
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/dist ./dist
COPY --from=build --chown=node:node /app/backend/drizzle ./drizzle
COPY --from=build --chown=node:node /app/backend/package.json ./package.json

USER node
EXPOSE 4000

# Overridden by the compose service: dist/main.js for the API, dist/worker.js
# for the worker, and npm run db:migrate for the migration job.
CMD ["node", "dist/main.js"]
