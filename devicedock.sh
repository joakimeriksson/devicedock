#!/usr/bin/env bash
# DeviceDock control script: ./devicedock.sh {console (default)|start|stop|restart|status|open|logs|login|build|pull|upgrade|test|clean}
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-47831}"
RUN=.runtime; PIDFILE=$RUN/backend.pid; LOG=$RUN/backend.log
IMAGE=devicedock-sandbox:local; CONTAINER=devicedock-sandbox
# Which sandbox image: base | contiki | esp32 | full (see sandbox/Dockerfile). Published builds come from REMOTE.
VARIANT="${DEVICEDOCK_VARIANT:-contiki}"
REMOTE="${DEVICEDOCK_REMOTE:-ghcr.io/joakimeriksson/devicedock-sandbox}"
mkdir -p "$RUN"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

need_docker() { docker info >/dev/null 2>&1 || die "Docker is not reachable. Start it (e.g. 'colima start') and retry."; }

# Backend: the self-contained Rust binary (web UI embedded, no Node needed) when there is one; it is built with cargo
# if cargo is installed. DEVICEDOCK_BACKEND=node forces the original Node backend, DEVICEDOCK_BIN picks a binary.
find_bin() {
  local b; for b in "${DEVICEDOCK_BIN:-}" bin/devicedock server-rs/target/release/devicedock; do
    [ -n "$b" ] && [ -x "$b" ] && { echo "$b"; return; }; done; return 0
}
BIN=""
if [ "${DEVICEDOCK_BACKEND:-auto}" != node ]; then
  BIN=$(find_bin)
  if [ -z "$BIN" ] && command -v cargo >/dev/null; then
    say "Building the Rust backend (one time, about a minute)"
    if [ ! -f dist/index.html ] && command -v npm >/dev/null; then [ -d node_modules ] || npm ci; npm run -s build; fi
    cargo build --release --manifest-path server-rs/Cargo.toml && BIN=server-rs/target/release/devicedock
  fi
  [ -n "$BIN" ] || [ "${DEVICEDOCK_BACKEND:-auto}" = auto ] || die "no Rust backend binary; install cargo or put one in bin/devicedock"
fi
[ -n "$BIN" ] || [ -d node_modules ] || { say "Installing dependencies"; npm ci; }
need_node() { command -v npm >/dev/null || die "this needs Node.js (only for developing the web UI)"; [ -d node_modules ] || npm ci; }
ddctl() { if [ -n "$BIN" ]; then "$BIN" "$@"; else case "$1" in
  sandbox) npm run -s "sandbox:$2" ;; open) npm run -s open ;; login-codex) npm run -s login:codex ;; esac; fi; }

backend_pid() {
  # PID listening on our port, only if it is this project's backend.
  local pid; pid=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  [ -n "$pid" ] && ps -o command= -p "$pid" | grep -qE "apps/server/index.ts|devicedock serve" && echo "$pid" || true
}
sandbox_running() { [ "$(docker inspect -f '{{.State.Running}}' $CONTAINER 2>/dev/null || true)" = true ]; }

# An unauthenticated Codex TUI holds its own login server on port 1455 in the
# container and hijacks the login callback. End it when Codex is not logged in.
end_stray_codex() {
  sandbox_running || return 0
  docker exec $CONTAINER codex login status >/dev/null 2>&1 && return 0
  docker exec $CONTAINER sh -c 'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < $p/cmdline 2>/dev/null)" in */bin/codex*) kill ${p#/proc/} 2>/dev/null && echo "Ended unauthenticated codex (pid ${p#/proc/})";; esac; done'
}

build_image() {
  [ -f sandbox/Dockerfile ] || die "building the image needs a source checkout; download it instead (p)"
  say "Building the sandbox image ($VARIANT) locally"; docker build --target "$VARIANT" -t $IMAGE -f sandbox/Dockerfile .; }
# Download the published image for VARIANT and use it as the local sandbox image.
cmd_pull() {
  need_docker; say "Downloading $REMOTE:$VARIANT"
  docker pull "$REMOTE:$VARIANT" && docker tag "$REMOTE:$VARIANT" $IMAGE && say "Using $REMOTE:$VARIANT (recreate the sandbox to switch: rs)"
}
cmd_build() { need_docker; need_node; say "Building frontend"; npm run -s build; build_image; }

# Bring a running installation up to date: the newest published image for the sandbox's own variant, a sandbox
# recreated from it (volumes, so files and agent logins, are kept), and a backend restarted on the current binary.
# In a source checkout it also rebuilds the backend. The installer (install.sh) updates the binary itself.
cmd_upgrade() {
  need_docker
  local v; v=$(docker exec $CONTAINER cat /etc/devicedock-variant 2>/dev/null || true)
  VARIANT="${v:-$VARIANT}"
  if [ "$BIN" = server-rs/target/release/devicedock ] && command -v cargo >/dev/null; then
    say "Rebuilding the backend from this checkout"
    if command -v npm >/dev/null; then need_node; npm run -s build; fi
    cargo build --release --manifest-path server-rs/Cargo.toml || die "backend build failed"
  fi
  cmd_pull || die "could not download the sandbox image"
  if docker inspect $CONTAINER >/dev/null 2>&1; then say "Recreating the sandbox (files and logins kept)"; ddctl sandbox clean; fi
  ddctl sandbox start; end_stray_codex
  cmd_restart_backend
}

start_backend() {
  if [ -n "$(backend_pid)" ]; then
    say "Backend already running (pid $(backend_pid))"
  else
    [ -z "$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)" ] || die "port $PORT is used by another program"
    say "Starting backend on 127.0.0.1:$PORT"
    if [ -n "$BIN" ]; then nohup "$BIN" serve >"$LOG" 2>&1 & else nohup npm start >"$LOG" 2>&1 & fi
    echo $! >"$PIDFILE"
    for _ in $(seq 1 40); do
      curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.5
    done
    [ -n "$(backend_pid)" ] || { tail -20 "$LOG"; die "backend failed to start"; }
  fi
}

# Restart only the backend (the sandbox keeps running). Ends agent terminals and browser sessions.
cmd_restart_backend() {
  local pid; pid=$(backend_pid)
  if [ -n "$pid" ]; then say "Stopping backend ($pid)"; kill "$pid"; sleep 1; fi
  rm -f "$PIDFILE"
  start_backend
  cmd_status
}

cmd_start() {
  need_docker
  docker image inspect $IMAGE >/dev/null 2>&1 || { say "Sandbox image missing"; cmd_pull || build_image; }
  [ -n "$BIN" ] || [ -f dist/index.html ] || { say "Building frontend"; npm run -s build; }
  say "Starting sandbox container"; ddctl sandbox start
  end_stray_codex
  start_backend
  cmd_status
  say "Next: ./devicedock.sh open   (mints a fresh one-time login link; use it whenever you are logged out, no restart needed)"
}

cmd_stop() {
  local pid; pid=$(backend_pid)
  if [ -n "$pid" ]; then say "Stopping backend ($pid)"; kill "$pid"; sleep 1; else echo "Backend not running"; fi
  rm -f "$PIDFILE"
  if docker info >/dev/null 2>&1 && docker inspect $CONTAINER >/dev/null 2>&1; then
    say "Stopping sandbox (workspace and credentials preserved)"; ddctl sandbox stop
  fi
}

cmd_status() {
  local pid; pid=$(backend_pid)
  if [ -n "$pid" ]; then echo "backend : running (pid $pid, http://127.0.0.1:$PORT)"; else echo "backend : stopped"; fi
  if docker info >/dev/null 2>&1; then
    echo "docker  : ok"
    echo "sandbox : $(sandbox_running && echo running || echo stopped)"
    if sandbox_running; then
      for a in codex claude opencode; do
        printf '  %-9s %s\n' "$a" "$(docker exec $CONTAINER $a --version 2>&1 | head -1)"
      done
      echo "  codex login : $(docker exec $CONTAINER codex login status 2>&1 | head -1)"
      echo "  claude login: $(docker exec $CONTAINER claude auth status 2>&1 | grep -o '"loggedIn": *[a-z]*' | head -1)"
    fi
  else echo "docker  : NOT reachable"; fi
}

cmd_login() {
  need_docker; sandbox_running || die "sandbox not running; run ./devicedock.sh start"
  case "${1:-}" in
    codex)    ddctl login-codex; exit ;;
    claude)   exec docker exec -it $CONTAINER claude auth login ;;
    opencode) exec docker exec -it $CONTAINER opencode auth login ;;
    *) die "usage: $0 login {codex|claude|opencode}" ;;
  esac
}

run_tests() {
  if command -v cargo >/dev/null; then cargo test --manifest-path server-rs/Cargo.toml || return 1; fi
  if command -v npm >/dev/null; then need_node; npm run -s typecheck && npm test || return 1
    [ -x server-rs/target/release/devicedock ] && DEVICEDOCK_BIN=server-rs/target/release/devicedock npx tsx --test tests/rust/parity.test.ts; fi
}

cmd_clean() {
  cmd_stop
  docker info >/dev/null 2>&1 && docker inspect $CONTAINER >/dev/null 2>&1 && ddctl sandbox clean
  say "Container removed. Volumes (devicedock-workspace, devicedock-home) kept."
}

# ---- interactive console: starts everything, shows status, takes restart commands ----
web_state() {
  [ -f dist/index.html ] || { [ -n "$BIN" ] && echo "embedded in the backend binary" || echo "not built"; return; }
  local newer; newer=$(find apps/web/src packages -newer dist/index.html -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) 2>/dev/null | grep -v node_modules | head -1)
  [ -n "$newer" ] && echo "STALE (changed: $newer)" || echo "up to date"
}
image_state() {
  docker image inspect $IMAGE >/dev/null 2>&1 || { echo "missing"; return; }
  local img ctr; img=$(docker image inspect -f '{{.Id}}' $IMAGE); ctr=$(docker inspect -f '{{.Image}}' $CONTAINER 2>/dev/null || true)
  [ -z "$ctr" ] || [ "$img" = "$ctr" ] && echo "ok" || echo "container uses an OLDER image (use: rs)"
}
console_status() {
  local pid; pid=$(backend_pid)
  printf '\n\033[1m── DeviceDock %s ──\033[0m\n' "$(date +%T)"
  if [ -n "$pid" ]; then printf 'backend  : \033[32mrunning\033[0m pid %s  http://127.0.0.1:%s\n' "$pid" "$PORT"
  else printf 'backend  : \033[31mstopped\033[0m\n'; fi
  echo "web build: $(web_state)"
  if docker info >/dev/null 2>&1; then
    if sandbox_running; then printf 'sandbox  : \033[32mrunning\033[0m  %s image, %s\n' "$(docker exec $CONTAINER cat /etc/devicedock-variant 2>/dev/null || echo older)" "$(image_state)"
      if [ "$(docker inspect -f '{{index .Config.Labels "devicedock.network"}}' $CONTAINER 2>/dev/null)" = tunnel ]; then
        printf 'network  : \033[32mfirewall on\033[0m  (allowed sites only; Network panel in the page)\n'
      else printf 'network  : \033[33mopen internet\033[0m  (older sandbox: u upgrades it)\n'; fi
      echo "devices  :"; docker exec $CONTAINER device list 2>&1 | sed 's/^/  /' | head -20
    else printf 'sandbox  : \033[31mstopped\033[0m\n'; fi
  else printf 'docker   : \033[31mNOT reachable\033[0m\n'; fi
  local errs; errs=$(grep -iE 'error|fail' "$LOG" 2>/dev/null | tail -3 || true)
  [ -n "$errs" ] && { echo "recent backend errors:"; echo "$errs" | sed 's/^/  /'; }
  return 0
}
console_help() {
  cat <<'H'
commands:  s status   rb restart backend   rs recreate sandbox   u upgrade (newest image + restart)
           w rebuild web   i build image   p download image   o login link   l backend log   d device list   sh sandbox shell   t tests   login <codex|claude|opencode>
           stop  stop everything   q quit (leave running)   x quit and stop everything   h help
H
}
cmd_console() {
  set +e  # a failing command must not end the console
  ( cmd_start ) || say "start reported a problem; fix it and use the commands below"
  console_help; console_status
  local line
  while printf '\n\033[1mdevicedock>\033[0m '; read -r line; do
    case "$line" in
      ""|s|status) console_status ;;
      rb) ( cmd_restart_backend ) ;;
      rs) printf 'Recreate the sandbox container? Agent terminals end; volumes are kept. [y/N] '; read -r a
          [ "$a" = y ] && ( need_docker; ddctl sandbox clean; ddctl sandbox start; end_stray_codex ); console_status ;;
      w)  ( need_node; npm run -s build ) && say "Web rebuilt: reload the DeviceDock page (served from ./dist)" ;;
      i)  ( need_docker; build_image ) && say "Image built: use rs to recreate the sandbox from it" ;;
      p)  ( cmd_pull ) ;;
      u)  printf 'Upgrade: download the newest sandbox image, recreate the sandbox and restart the backend.\nAgent terminals end; files and logins are kept. Continue? [y/N] '; read -r a
          [ "$a" = y ] && ( cmd_upgrade ) ;;
      o)  ddctl open ;;
      l)  tail -n 30 "$LOG" ;;
      d)  docker exec $CONTAINER device list ;;
      sh) docker exec -it -w /workspace $CONTAINER bash -l ;;
      t)  ( run_tests ) ;;
      login\ *) ( cmd_login "${line#login }" ) ;;
      stop) ( cmd_stop ) ;;
      x)  ( cmd_stop ); break ;;
      q|quit|exit) say "Leaving everything running"; break ;;
      h|help|\?) console_help ;;
      *) echo "unknown command: $line (h for help)" ;;
    esac
  done
}

case "${1:-console}" in
  console) cmd_console ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  restart-backend) cmd_restart_backend ;;
  status)  cmd_status ;;
  open)    [ -n "$(backend_pid)" ] || die "backend not running"; ddctl open ;;
  logs)    tail -n 50 -f "$LOG" ;;
  login)   shift; cmd_login "${1:-}" ;;
  build)   cmd_build ;;
  pull)    cmd_pull ;;
  upgrade) cmd_upgrade ;;
  test)    run_tests ;;
  clean)   cmd_clean ;;
  *) echo "usage: $0 {console (default)|start|stop|restart|restart-backend|status|open|logs|login <codex|claude|opencode>|build|pull|upgrade|test|clean}  (DEVICEDOCK_VARIANT=base|contiki|esp32|full, default contiki)"; exit 1 ;;
esac
