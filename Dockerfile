FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace backend --workspace shared --no-audit --no-fund
COPY shared shared
COPY backend backend
RUN npm run build -w shared && npm run build -w backend
RUN npm prune --omit=dev --workspace backend --workspace shared
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 4000
CMD ["node", "backend/dist/server.js"]
