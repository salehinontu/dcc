# Debian rather than Alpine: ONNX Runtime (people counting) ships no musl build.
FROM node:22-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# ffmpeg records the live feeds an operator asks the server to keep (a copy of the stream, no
# re-encode) and makes each clip seekable. Debian's build; the dev image uses the same.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Copy every workspace manifest so the frozen lockfile can be resolved.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY tools/dev-broker/package.json tools/dev-broker/
COPY tools/simulator/package.json tools/simulator/

RUN pnpm install --frozen-lockfile --filter @dji/api...

COPY packages/protocol packages/protocol
COPY apps/api apps/api

WORKDIR /app/apps/api
EXPOSE 3000

CMD ["pnpm", "start"]
