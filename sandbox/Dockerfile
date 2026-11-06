FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git python3 build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/devicedock
COPY package*.json ./
COPY scripts/prepare-pty.mjs ./scripts/prepare-pty.mjs
RUN npm ci && npm install --prefix /opt/agent @openai/codex@0.167.0 @anthropic-ai/claude-code@2.1.319 opencode-ai@1.19.5
COPY packages ./packages
COPY sandbox ./sandbox
RUN printf '#!/bin/sh\nexec /opt/devicedock/node_modules/.bin/tsx /opt/devicedock/packages/device-client/cli.ts "$@"\n' > /usr/local/bin/device && chmod +x /usr/local/bin/device && for b in codex claude opencode; do ln -s /opt/agent/node_modules/.bin/$b /usr/local/bin/$b; done && mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV TERM=xterm-256color
EXPOSE 47832
CMD ["/opt/devicedock/node_modules/.bin/tsx","/opt/devicedock/sandbox/bridge-service/index.ts"]
