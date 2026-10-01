# Gamma keeper — long-running rebalance bot for the Hypervisor vault.
#
# The keeper runs its TypeScript directly through tsx rather than being compiled,
# so tsx (a devDependency) is needed AT RUNTIME. `npm ci` therefore has to install
# dev dependencies — do not set NODE_ENV=production during install, it would drop
# tsx and the container would start and immediately fail to resolve the entrypoint.
FROM node:22-alpine

WORKDIR /app

# Dependencies first so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Config comes from the environment. `import 'dotenv/config'` in src/config.ts
# loads a .env when one exists but never overrides an already-set variable, so
# the stack's environment wins and no .env is baked into the image.
ENV NODE_ENV=production

# Don't run as root; the keeper only needs outbound HTTPS.
RUN addgroup -S keeper && adduser -S keeper -G keeper && chown -R keeper:keeper /app
USER keeper

# read-only /status + /healthz when STATUS_PORT=8787; documentation only, never
# publish it. NO HEALTHCHECK here: /healthz is advisory, and a 503 during an rpc
# outage would restart the keeper and erase dwell, regime, the price trail and
# lastCompoundTs. It exits non-zero on a fatal config or chain error and the
# swarm restart policy brings it back.
EXPOSE 8787
CMD ["npm", "start"]
