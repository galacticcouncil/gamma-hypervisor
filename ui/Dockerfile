# gamma ui: read-only dashboard + /api/v1 over the keeper fleet. built from the
# REPO ROOT, not ui/ — the server imports the keeper's signer-free leaf modules
# as @keeper/* = ../keeper/src, and the root .dockerignore keeps the hardhat
# tree, the audit pdfs and any local .env out of the context:
#
#   docker buildx build --platform linux/amd64 -f ui/Dockerfile \
#     --build-arg COMMIT=$(git rev-parse --short HEAD) \
#     -t galacticcouncil/gamma-ui:$(git rev-parse --short HEAD) --push .
#
# node 22.22 pinned: node:sqlite loads unflagged since 22.13 (verified 22.22.1).
# the ui/ + keeper/src sibling layout is kept in both stages so tsconfig paths
# and the vite alias resolve the same in dev and in the container.
FROM node:22.22-alpine AS build
WORKDIR /app/ui

# tsx runs the server at runtime and vite builds the page here: never set
# NODE_ENV=production before npm ci (the keeper/Dockerfile:3-6 trap).
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund

# ../keeper/src imports zod and ethers bare; node walks up from /app/keeper/src
# and never reaches /app/ui/node_modules, so /app/node_modules points there.
RUN ln -s /app/ui/node_modules /app/node_modules

COPY keeper/package.json /app/keeper/package.json
COPY keeper/src /app/keeper/src
COPY ui/ ./
RUN npm run build

FROM node:22.22-alpine
WORKDIR /app/ui

RUN addgroup -S ui && adduser -S ui -G ui

COPY --from=build --chown=ui:ui /app/ui/node_modules ./node_modules
COPY --from=build --chown=ui:ui /app/ui/build ./build
COPY --from=build --chown=ui:ui /app/ui/server ./server
COPY --from=build --chown=ui:ui /app/ui/package.json /app/ui/tsconfig.json ./
COPY --from=build --chown=ui:ui /app/keeper /app/keeper
RUN ln -s /app/ui/node_modules /app/node_modules \
 && chown -h ui:ui /app/node_modules \
 && chown ui:ui /app /app/ui

# ownership BEFORE VOLUME: a fresh named volume inherits it only from a directory
# that exists and is chown'd in the image; otherwise /data is root:root,
# DatabaseSync fails EACCES, /healthz 503s and swarm restart-loops the task.
RUN mkdir -p /data /backup && chown -R ui:ui /data /backup
VOLUME ["/data", "/backup"]

ARG COMMIT
ENV COMMIT=$COMMIT
ENV NODE_ENV=production
# tsx re-spawns node for the script, so a flag on the outer node may not reach
# the child; the env var does. silences node:sqlite's ExperimentalWarning.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
LABEL org.opencontainers.image.revision=$COMMIT

USER ui
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["./node_modules/.bin/tsx", "server/index.ts"]
