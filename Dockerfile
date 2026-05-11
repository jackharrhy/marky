# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for marky.
#
# Base image is `node:24-trixie-slim` (Debian 13, glibc 2.41). uWebSockets.js
# prebuilt binaries are glibc-only — Alpine breaks them without `gcompat`, and
# uWS v20.55+ targets glibc 2.38+ which bookworm (Debian 12, glibc 2.36) no
# longer satisfies. Trixie is the Debian release uWS itself builds against.

ARG NODE_VERSION=24-trixie-slim

# ---- deps ---------------------------------------------------------------------
# Install npm dependencies in a separate stage so the resulting node_modules
# layer can be reused as long as package*.json don't change.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- runtime ------------------------------------------------------------------
# Production image. We keep the full node_modules tree because there's no build
# step that prunes dev deps — typecheck and tests run in CI, not at image build.
# `tsx` (used by `npm start`) is a runtime dep so it stays.
FROM node:${NODE_VERSION} AS runtime

ENV NODE_ENV=production \
    PORT=44100 \
    MARKY_CONTENT_DIR=/app/content

WORKDIR /app

# Copy dependencies and source.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.json server.ts ./
COPY app ./app

# Empty content dir; operators bind-mount their vault on top of this path.
RUN mkdir -p /app/content && \
    chown -R node:node /app

USER node
EXPOSE 44100

CMD ["npm", "start"]
