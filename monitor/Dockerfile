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
CMD ["npm", "start"]
