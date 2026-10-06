# Spec2UI studio: the web app and its API server in one container.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# package-lock.json was written on Windows and carries only Windows native
# binaries (npm/cli#4828), so the Linux ones are added here, pinned to the
# versions the lockfile resolves.
RUN npm ci && npm install --no-save \
      @rollup/rollup-linux-x64-gnu@4.63.3 \
      @esbuild/linux-x64@0.25.12 \
      lightningcss-linux-x64-gnu@1.32.0 \
      @tailwindcss/oxide-linux-x64-gnu@4.3.3
COPY server server
COPY web web
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 WORK_DIR=/app/.work
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# esbuild builds previews at run time, so it needs its Linux binary here too.
RUN npm ci --omit=dev -w server \
 && npm install --no-save --omit=dev -w server @esbuild/linux-x64@0.25.12 \
 && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
