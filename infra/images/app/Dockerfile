# QualityOS application image: one image, several processes (api, worker, web, migrate,
# execution-controller). Each Compose service picks its command. Build context: repository root.
#
# Known limitation (P1): the image keeps dev dependencies. Pruning to production dependencies
# and pinning the base image by digest are hardening items for P11.
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1 CI=1
RUN corepack enable
WORKDIR /repo
# Manifests first, so the dependency layer is reused when only source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY packages packages
COPY apps apps
COPY tools tools
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
# Created here so a named volume mounted on it starts out owned by the unprivileged user.
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
CMD ["node", "apps/api/dist/main.js"]
