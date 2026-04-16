FROM oven/bun:1 AS build

WORKDIR /app

COPY package.json tsconfig.json VERSION ./
COPY README.md LICENSE ./
COPY docs ./docs
COPY examples ./examples
COPY packages ./packages

RUN bun install
RUN cd packages/claudraband-core && \
  bun build src/index.ts --target node --packages external --outdir dist
RUN cd packages/claudraband-cli && \
  bun build src/bin.ts --target node --external '@agentclientprotocol/*' --external 'node-pty' --outdir dist && \
  bun build ../claudraband-core/src/index.ts --target node --external 'node-pty' --outdir dist --entry-naming index.js

FROM oven/bun:1-slim

WORKDIR /app

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && apt-get install -y --no-install-recommends tmux ca-certificates git g++ binutils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app
COPY docker/tmux-entrypoint.sh /usr/local/bin/entrypoint
COPY docker/claude.sh /usr/local/bin/claude
COPY docker/claudraband.sh /usr/local/bin/claudraband

RUN chmod +x /usr/local/bin/entrypoint /usr/local/bin/claude /usr/local/bin/claudraband && \
  ln -sf /usr/local/bin/claude /usr/local/bin/claude-code && \
  ln -sf /usr/local/bin/claudraband /usr/local/bin/cband

ENV CLAUDE_ACCOUNT_DIR=/claude-account
ENV CBAND_DEFAULT_HOST=0.0.0.0
ENV CBAND_DEFAULT_PORT=7842

EXPOSE 7842

ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["serve"]
