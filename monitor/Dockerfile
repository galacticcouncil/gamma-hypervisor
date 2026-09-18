# Watchdog for the Gamma keeper. Runs TypeScript through tsx, so tsx (a
# devDependency) is needed AT RUNTIME — do not set NODE_ENV=production before
# `npm ci` or it is dropped and the container cannot resolve its entrypoint.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
RUN addgroup -S monitor && adduser -S monitor -G monitor && chown -R monitor:monitor /app
USER monitor
# read-only /status + /healthz when STATUS_PORT=8788; documentation only, never
# publish it. NO HEALTHCHECK here: STATUS_PORT defaults to 0, so an image-level
# check would kill every deploy that forgets the var, and each restart
# re-notifies everything firing. the stack service carries a guarded check.
EXPOSE 8788
CMD ["npm", "start"]
