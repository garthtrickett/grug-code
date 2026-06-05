# syntax=docker/dockerfile:1
FROM oven/bun:1-slim AS deps
WORKDIR /usr/src/app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /usr/src/app
COPY . .
ARG VITE_ROOT_DOMAIN
ENV VITE_ROOT_DOMAIN=$VITE_ROOT_DOMAIN
RUN bun run build

FROM oven/bun:1-slim AS production
WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/src ./src
COPY --from=build /usr/src/app/package.json ./package.json
COPY --from=build /usr/src/app/mastra.config.ts ./mastra.config.ts

EXPOSE 42069
CMD ["bun", "run", "start"]
