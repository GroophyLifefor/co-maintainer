# syntax=docker/dockerfile:1

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json main.ts mod.ts ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-slim AS tools
COPY src/tools/codegraph.ts /tmp/codegraph.ts
RUN version="$(sed -n 's/^export const CODEGRAPH_VERSION = "\(.*\)";/\1/p' /tmp/codegraph.ts)" \
 && test -n "$version" \
 && npm install "@colbymchenry/codegraph@$version" \
      --prefix "/opt/cm-tools/codegraph/$version" --no-audit --no-fund

FROM node:26-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache \
    CM_TOOLS_DIR=/opt/cm-tools
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=tools /opt/cm-tools /opt/cm-tools
COPY --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "/app/docker-entrypoint.sh"]
CMD ["serve", "--port=5000"]
