FROM node:22-alpine AS build

# Empty/root by default; set to /drone-fleet/ when the dashboard is served under a
# reverse-proxy path prefix.
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/protocol/package.json packages/protocol/
COPY tools/dev-broker/package.json tools/dev-broker/
COPY tools/simulator/package.json tools/simulator/

RUN pnpm install --frozen-lockfile --filter @dji/web...

COPY packages/protocol packages/protocol
COPY apps/web apps/web

RUN pnpm --filter @dji/web build

# Compress every text file once here, at the best level, so Nginx (`gzip_static`) sends the small copy and never
# spends CPU on it per request. The originals stay for browsers that do not ask for gzip.
RUN cd apps/web/dist \
 && find . -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.svg' -o -name '*.json' \) -size +1k \
      -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \;

FROM nginx:alpine

RUN rm -f /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/app.conf.template /etc/nginx/templates/app.conf.template
COPY infra/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf

# A `stream` block (RTMPS, see infra/nginx/rtmps.conf) has to sit at the top level of nginx.conf, outside http.
# The folder is empty unless a compose file mounts a file into it, so every other use of this image is unchanged.
RUN mkdir -p /etc/nginx/stream.d \
 && printf '\ninclude /etc/nginx/stream.d/*.conf;\n' >> /etc/nginx/nginx.conf

EXPOSE 80 443 1936
