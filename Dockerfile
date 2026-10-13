# syntax=docker/dockerfile:1
#
# browserbay images. Two targets from one file:
#
#   box    (default) Chromium + everything. `docker run` starts the all-in-one box (relay + a browser node); override the
#          command with `node` to run a browser node alone, or `relay` for the relay alone.
#   relay  the relay only, without Chromium: a small image for the machine that fronts your nodes.
#
#   docker build -t browserbay .
#   docker build --target relay -t browserbay-relay .

FROM node:26-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# Compile the TypeScript and keep only what runs.
FROM base AS build
# playwright is a dev dependency (the tests use it); the image gets its Chromium below, not from here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod --ignore-scripts

# The application as it runs: compiled output only. No sources, no tests (the build leaves them out), no dev dependencies.
FROM base AS app
ENV NODE_ENV=production
COPY LICENSE package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

FROM node:26-bookworm-slim AS relay
ENV NODE_ENV=production
ENV PORT=8788
WORKDIR /app
COPY --from=app --chown=node:node /app ./
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8788) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["relay"]

# Last, so a plain `docker build .` makes this one.
FROM node:26-bookworm-slim AS box

# The Chromium build the tests ran against. Keep in step with the playwright version in package.json.
ARG PLAYWRIGHT_VERSION=1.62.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install full Chromium (not the headless shell) and its system libraries, then drop what this image never uses.
RUN mkdir /tmp/pw && cd /tmp/pw \
  && npm init -y >/dev/null \
  && npm install --no-audit --no-fund playwright@${PLAYWRIGHT_VERSION} \
  && npx playwright install --with-deps chromium \
  && rm -rf /ms-playwright/ffmpeg-* /ms-playwright/chromium_headless_shell-* /tmp/pw /var/lib/apt/lists/* /root/.npm

# A failed download must fail the build, not ship a browser-less image.
RUN test -n "$(find /ms-playwright -maxdepth 3 -name chrome -type f | head -1)"

ENV NODE_ENV=production
ENV PORT=8788
WORKDIR /app
COPY --from=app --chown=node:node /app ./
USER node
EXPOSE 8788
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]
