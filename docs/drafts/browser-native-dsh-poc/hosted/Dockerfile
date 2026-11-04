# syntax=docker/dockerfile:1

# Hosted browser-native DSH container image.
#
# The build stage installs the workspace and produces the Web preview bundle;
# the backend itself needs only Node built-ins and local modules at runtime, so
# the runtime stage carries no node_modules. Build from the repository root:
#
#   docker build -f docs/drafts/browser-native-dsh-poc/hosted/Dockerfile \
#     -t browser-native-dsh:local .
#
# See hosted-deployment.md for the run command, data volume, TLS proxy, upgrade
# path, and the verification script that exercises this image.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build

ARG PNPM_VERSION=11.28.5
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    DSH_POC_HOST=0.0.0.0 \
    DSH_POC_PORT=4185 \
    DSH_POC_DATA_DIR=/data \
    DSH_POC_DIST_ROOT=/app/apps/web/dist \
    DSH_POC_BUILD=0

WORKDIR /app
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY --from=build /src/docs/drafts/browser-native-dsh-poc ./docs/drafts/browser-native-dsh-poc
COPY --from=build /src/package.json ./package.json

RUN groupadd --system --gid 10001 dsh \
    && useradd --system --uid 10001 --gid dsh --home-dir /app dsh \
    && mkdir -p /data && chown dsh:dsh /data

USER 10001:10001
VOLUME ["/data"]
EXPOSE 4185

# Without the local process token the API answers 401; either status proves the
# server is accepting requests, so the probe checks reachability rather than auth.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4185/api/browser-native/health').then(r => process.exit(r.status === 401 || r.status === 200 ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "/app/docs/drafts/browser-native-dsh-poc/hosted/start-hosted.mjs"]
