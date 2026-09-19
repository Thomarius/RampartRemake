# syntax=docker/dockerfile:1

# One process is the whole deployment: it serves the built client over HTTP and runs
# the authoritative match loop over the same port's WebSocket. See docs/PLAN.md §2.

FROM node:24-alpine AS build
WORKDIR /app

# Manifests first, so a source-only change does not reinstall the dependency tree.
# Every workspace's package.json has to be present or `npm ci` refuses the lockfile.
COPY package.json package-lock.json ./
COPY packages/ai/package.json packages/ai/
COPY packages/client/package.json packages/client/
COPY packages/config/package.json packages/config/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/sim/package.json packages/sim/
COPY tools/headless/package.json tools/headless/
RUN npm ci

COPY . .

# The client compiles the config JSON in through import assertions, and the server
# bundle carries the simulation, AI and protocol with it. Both therefore need the
# repository present at this point, and neither needs it afterwards.
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Everything the server touches at runtime, and nothing else — no node_modules, no
# TypeScript, no toolchain. `ws` and `zod` are inside the bundle; the two optional
# native accelerators `ws` looks for are deliberately absent and it copes.
#
# The layout is not arbitrary. `packages/server/src/paths.ts` finds the repository
# root by walking three directories up from itself, which is where `config/` and the
# built client are looked up; `dist` sits at the same depth as `src`, so this works
# unchanged. Moving any of these three breaks startup.
COPY --from=build /app/config ./config
COPY --from=build /app/packages/client/dist ./packages/client/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist

USER node

# The config file's port, which PORT overrides — hosts that assign one (Fly, Railway)
# set it themselves, and the server reads it there first.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/main.js"]
