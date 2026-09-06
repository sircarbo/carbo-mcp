# syntax=docker/dockerfile:1.7
#
# Carbo MCP Gateway runtime image.
#
# Two stages. The builder has npm, a compiler and the full dependency tree; the
# runtime has none of that. The runtime base is distroless, which means the
# shipped image contains no shell, no package manager, no busybox and no
# coreutils -- there is literally nothing to exec into. Combined with a
# read-only root filesystem and every capability dropped, a compromise of the
# Node process has no local tooling to escalate with.
#
# Both stages are pinned by digest so a rebuild cannot silently pick up a
# different base image.

# ------------------------------------------------------------------ builder
FROM node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
# node:22.23.2-alpine

WORKDIR /build

# Dependencies first, so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-resolve to production dependencies only. devDependencies (typescript,
# vitest, type packages) must not reach the runtime image.
RUN npm ci --omit=dev --no-audit --no-fund

# ------------------------------------------------------------------ runtime
FROM gcr.io/distroless/nodejs22-debian12@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime
# gcr.io/distroless/nodejs22-debian12:nonroot -- runs as uid/gid 65532

WORKDIR /app

COPY --from=builder --chown=65532:65532 /build/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /build/dist ./dist
COPY --from=builder --chown=65532:65532 /build/package.json ./package.json

# Explicit even though the base already defaults to it -- the guarantee is
# worth stating where anyone reading the image will see it.
USER 65532:65532

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=192 \
    MCP_PORT=8110 \
    MCP_SNAPSHOT_DIR=/app/snapshots \
    MCP_AUDIT_DIR=/app/data/audit

EXPOSE 8110

# The base image has no shell, so this is the exec form deliberately: it runs
# node directly rather than going through /bin/sh, which does not exist here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8110)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["dist/server/index.js"]
