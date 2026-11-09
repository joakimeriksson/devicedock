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

# Cooja-NG (cngsim): the C re-implementation of Cooja/MSPSim. Emulates the real firmware ELF for Sky/Z1 (MSP430),
# CC2538/Zoul, CC1352R1/CC1312R7 LaunchPads and nRF52840/nRF54L15, alone or as a radio network. Pinned upstream commit;
# NATIVE_FLAG= keeps the binary portable (no -march=native), so a `docker save`d image runs on other machines.
FROM debian:bookworm-slim AS cooja-ng
ARG COOJA_NG_COMMIT=c8345345835fc085457a71b30421a5b46a449f78
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git build-essential pkg-config python3 && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/mikroverk/cooja-ng.git /src && cd /src && git checkout "$COOJA_NG_COMMIT" \
 && make -j"$(nproc)" NATIVE_FLAG= && make install PREFIX=/opt/cooja-ng NATIVE_FLAG=

# ---------------------------------------------------------------------------------------------------------------------
# Image variants (docker build --target <variant>):
#   base     DeviceDock bridge, agents, OpenOCD, ARM GCC, Cooja-NG, esptool/pyserial/mpremote
#   contiki  base + a pinned Contiki-NG checkout (/opt/contiki-ng) + MSP430 GCC (amd64 only: no arm64 build exists)
#   esp32    base + ESP-IDF (/opt/esp-idf) for esp32, esp32s3, esp32c3, esp32c6
#   full     contiki + esp32
# Claude Code is NOT in any image (its licence is not a redistribution licence): `claude` installs it into the
# home volume on first use. Codex (Apache-2.0) and OpenCode (MIT) are included.
# ---------------------------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ARG CLAUDE_CODE_VERSION=2.1.319
RUN apt-get update && apt-get install -y --no-install-recommends bash git python3 build-essential ca-certificates procps python3-venv \
      gcc-arm-none-eabi libnewlib-arm-none-eabi libusb-1.0-0 libjim0.81 curl && rm -rf /var/lib/apt/lists/*
COPY --from=openocd /opt/openocd /opt/openocd
RUN ln -s /opt/openocd/bin/openocd /usr/local/bin/openocd
COPY --from=cooja-ng /opt/cooja-ng /opt/cooja-ng
RUN ln -s /opt/cooja-ng/bin/cngsim /usr/local/bin/cngsim
WORKDIR /opt/devicedock
COPY package*.json ./
COPY scripts/prepare-pty.mjs ./scripts/prepare-pty.mjs
RUN npm ci && npm install --prefix /opt/agent @openai/codex@0.167.0 opencode-ai@1.19.5 && npm cache clean --force
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir esptool pyserial mpremote
ENV PATH="/opt/venv/bin:$PATH"
# Login shells (bash -l) reset PATH, so export it from profile.d as well.
RUN echo 'export PATH="/opt/venv/bin:$PATH"' > /etc/profile.d/devicedock-venv.sh
COPY packages ./packages
COPY sandbox ./sandbox
# `claude`: installs Claude Code into the home volume the first time, then runs it (later starts are instant).
RUN printf '%s\n' '#!/bin/sh' \
      'dir="$HOME/.devicedock/claude-code"; bin="$dir/node_modules/.bin/claude"' \
      'if [ ! -x "$bin" ]; then' \
      '  echo "Installing Claude Code '"$CLAUDE_CODE_VERSION"' into your home volume (first start only, about a minute)..." >&2' \
      '  npm install --prefix "$dir" --no-fund --no-audit --loglevel=error "@anthropic-ai/claude-code@'"$CLAUDE_CODE_VERSION"'" >&2 || exit 1' \
      'fi' \
      'exec "$bin" "$@"' > /usr/local/bin/claude && chmod 755 /usr/local/bin/claude
RUN printf '#!/bin/sh\nexec /opt/devicedock/node_modules/.bin/tsx /opt/devicedock/packages/device-client/cli.ts "$@"\n' > /usr/local/bin/device && chmod +x /usr/local/bin/device \
 && for b in codex opencode; do ln -s /opt/agent/node_modules/.bin/$b /usr/local/bin/$b; done && mkdir /workspace && chown node:node /workspace \
 && echo base > /etc/devicedock-variant
USER node
WORKDIR /workspace
ENV TERM=xterm-256color
EXPOSE 47832
CMD ["/opt/devicedock/node_modules/.bin/tsx","/opt/devicedock/sandbox/bridge-service/index.ts"]

# ---- Contiki-NG: a read-only reference checkout with submodules; copy it to /workspace to work on it. ----
FROM base AS contiki
ARG CONTIKI_NG_COMMIT=a3c7119915a5d1d137cee9990c0c3ba0a32bfbb7
ARG TARGETARCH
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 srecord xxd && rm -rf /var/lib/apt/lists/* \
 && if [ "$TARGETARCH" = amd64 ] || [ "$(uname -m)" = x86_64 ]; then \
      curl -fsSL https://github.com/pjonsson/msp430gcc-binary/releases/download/v1.1/mspgcc-4.7.4-linux-x86_64.tar.bz2 \
        | tar xj -C /usr/local --strip-components=1 --no-same-owner; \
    else echo "MSP430 GCC: no arm64 build exists; Sky/Z1 firmware cannot be built in this image" > /usr/local/share/NO-MSP430-GCC; fi
RUN git clone https://github.com/contiki-ng/contiki-ng.git /opt/contiki-ng && cd /opt/contiki-ng \
 && git checkout "$CONTIKI_NG_COMMIT" && git submodule update --init --recursive --depth 1 \
 && git config --system --add safe.directory '*' \
 && echo contiki > /etc/devicedock-variant
USER node

# ---- ESP-IDF, installed once in its own stage and copied into esp32 and full. ----
FROM base AS esp-idf-build
ARG ESP_IDF_VERSION=v5.5.6
ARG ESP_IDF_TARGETS=esp32,esp32s3,esp32c3,esp32c6
USER root
RUN apt-get update && apt-get install -y --no-install-recommends wget flex bison gperf cmake ninja-build ccache libffi-dev \
      libssl-dev dfu-util && rm -rf /var/lib/apt/lists/*
ENV IDF_TOOLS_PATH=/opt/espressif
RUN git clone --depth 1 -b "$ESP_IDF_VERSION" --recursive --shallow-submodules https://github.com/espressif/esp-idf.git /opt/esp-idf \
 && PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /opt/esp-idf/install.sh "$ESP_IDF_TARGETS" \
 && rm -rf /opt/espressif/dist /root/.cache
# ESP-IDF keeps project-independent managed components (and a lock file it rewrites on every build) under
# $IDF_TOOLS_PATH/root_managed_components, which is read-only in the sandbox. Point it at the user's home volume;
# get_idf creates the target directory.
RUN rm -rf /opt/espressif/root_managed_components \
 && ln -s /home/node/.cache/esp-idf-root-components /opt/espressif/root_managed_components

FROM base AS esp32
USER root
RUN apt-get update && apt-get install -y --no-install-recommends flex bison gperf cmake ninja-build ccache libffi8 dfu-util \
      && rm -rf /var/lib/apt/lists/*
COPY --from=esp-idf-build /opt/esp-idf /opt/esp-idf
COPY --from=esp-idf-build /opt/espressif /opt/espressif
ENV IDF_TOOLS_PATH=/opt/espressif IDF_PATH=/opt/esp-idf
# `get_idf` (or `. $IDF_PATH/export.sh`) puts idf.py and the toolchains on PATH; not done for every shell (it is slow).
RUN cp /opt/devicedock/sandbox/profile-idf.sh /etc/profile.d/devicedock-idf.sh && echo esp32 > /etc/devicedock-variant
USER node

FROM contiki AS full
USER root
RUN apt-get update && apt-get install -y --no-install-recommends flex bison gperf cmake ninja-build ccache libffi8 dfu-util \
      && rm -rf /var/lib/apt/lists/*
COPY --from=esp-idf-build /opt/esp-idf /opt/esp-idf
COPY --from=esp-idf-build /opt/espressif /opt/espressif
ENV IDF_TOOLS_PATH=/opt/espressif IDF_PATH=/opt/esp-idf
RUN cp /opt/devicedock/sandbox/profile-idf.sh /etc/profile.d/devicedock-idf.sh && echo full > /etc/devicedock-variant
USER node
