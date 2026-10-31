# Imagen oficial verificada por digest; actualizar de forma controlada junto a las pruebas.
FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium chromium-sandbox fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/pdf-renderer/package.json services/pdf-renderer/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /build/dist/core/security/pdf-renderer.js ./dist/core/security/pdf-renderer.js
COPY services/pdf-renderer/server.mjs ./services/pdf-renderer/server.mjs
ENV NODE_ENV=production CHROME_PATH=/usr/bin/chromium PDF_RENDER_CONCURRENCY=1 PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "services/pdf-renderer/server.mjs"]
