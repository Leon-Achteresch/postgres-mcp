FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSPORT=http
ENV BIND_HOST=0.0.0.0
ENV PORT=8000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=10 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8000}/health" || exit 1
CMD ["node", "dist/index.js"]
