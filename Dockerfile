FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json* .npmrc* ./
RUN npm install --legacy-peer-deps

COPY index.html vite.config.ts tsconfig.json tsconfig.node.json biome.json ./
COPY src ./src

# An empty public/ directory must exist in source for this COPY to succeed.
COPY public ./public

# VITE_ vars are inlined at build time, so the gateway must be passed as a build arg.
ARG VITE_IPFS_GATEWAY
ENV VITE_IPFS_GATEWAY=$VITE_IPFS_GATEWAY

# Skip tsc in Docker (vite handles TS via esbuild) — avoids type-check failures
# from slightly different package versions in Docker vs local.
RUN npx vite build

RUN ls -la /app/dist/index.html

FROM nginx:alpine

RUN rm -rf /usr/share/nginx/html/*

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY banner.sh /docker-entrypoint.d/99-mustard-banner.sh
RUN chmod +x /docker-entrypoint.d/99-mustard-banner.sh

EXPOSE 5174

CMD ["nginx", "-g", "daemon off;"]
