# ---- build the SPA ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: one Node process serves API + SSE + static files ----
FROM node:22-alpine
WORKDIR /app
# Needs DATABASE_URL (PostgreSQL) at runtime.
ENV NODE_ENV=production \
    PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
