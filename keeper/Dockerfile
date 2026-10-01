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

# The keeper is a poll loop with no listening port, so there is nothing to
# healthcheck over the network. It exits non-zero on a fatal config or chain
# error and the swarm restart policy brings it back.
CMD ["npm", "start"]
