# OpenOCD from a pinned master commit: Debian's 0.12 predates the CMSIS-DAP TCP backend (added mid-2025) that DeviceDock's
# debug-probe endpoints speak. Built in its own stage so autotools and -dev packages stay out of the sandbox image.
FROM debian:bookworm-slim AS openocd
ARG OPENOCD_COMMIT=6fbe9e772476ce55c634cb0e8cd14244588ee9e2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git build-essential autoconf automake libtool \
      pkg-config texinfo libusb-1.0-0-dev libjim-dev && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/openocd-org/openocd.git /src && cd /src && git checkout "$OPENOCD_COMMIT" \
 && ./bootstrap nosubmodule && ./configure --prefix=/opt/openocd --disable-werror --disable-doxygen-html \
      --enable-cmsis-dap-tcp --enable-cmsis-dap-v2 --disable-internal-jimtcl \
 && make -j"$(nproc)" && make install-strip

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git python3 build-essential ca-certificates procps python3-venv \
      gcc-arm-none-eabi libnewlib-arm-none-eabi libusb-1.0-0 libjim0.81 && rm -rf /var/lib/apt/lists/*
COPY --from=openocd /opt/openocd /opt/openocd
RUN ln -s /opt/openocd/bin/openocd /usr/local/bin/openocd
WORKDIR /opt/devicedock
COPY package*.json ./
COPY scripts/prepare-pty.mjs ./scripts/prepare-pty.mjs
RUN npm ci && npm install --prefix /opt/agent @openai/codex@0.167.0 @anthropic-ai/claude-code@2.1.319 opencode-ai@1.19.5
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir esptool pyserial mpremote
ENV PATH="/opt/venv/bin:$PATH"
# Login shells (bash -l) reset PATH, so export it from profile.d as well.
RUN echo 'export PATH="/opt/venv/bin:$PATH"' > /etc/profile.d/devicedock-venv.sh
COPY packages ./packages
COPY sandbox ./sandbox
RUN printf '#!/bin/sh\nexec /opt/devicedock/node_modules/.bin/tsx /opt/devicedock/packages/device-client/cli.ts "$@"\n' > /usr/local/bin/device && chmod +x /usr/local/bin/device && for b in codex claude opencode; do ln -s /opt/agent/node_modules/.bin/$b /usr/local/bin/$b; done && mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV TERM=xterm-256color
EXPOSE 47832
CMD ["/opt/devicedock/node_modules/.bin/tsx","/opt/devicedock/sandbox/bridge-service/index.ts"]
