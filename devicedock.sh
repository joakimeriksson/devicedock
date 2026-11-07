#!/usr/bin/env bash
# DeviceDock control script: ./devicedock.sh {start|stop|restart|status|open|logs|login|build|test|clean}
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-47831}"
RUN=.runtime; PIDFILE=$RUN/backend.pid; LOG=$RUN/backend.log
IMAGE=devicedock-sandbox:local; CONTAINER=devicedock-sandbox
mkdir -p "$RUN"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

need_docker() { docker info >/dev/null 2>&1 || die "Docker is not reachable. Start it (e.g. 'colima start') and retry."; }
[ -d node_modules ] || { say "Installing dependencies"; npm ci; }

backend_pid() {
  # PID listening on our port, only if it is this project's backend.
  local pid; pid=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  [ -n "$pid" ] && ps -o command= -p "$pid" | grep -q "apps/server/index.ts" && echo "$pid" || true
}
sandbox_running() { [ "$(docker inspect -f '{{.State.Running}}' $CONTAINER 2>/dev/null || true)" = true ]; }

# An unauthenticated Codex TUI holds its own login server on port 1455 in the
# container and hijacks the login callback. End it when Codex is not logged in.
end_stray_codex() {
  sandbox_running || return 0
  docker exec $CONTAINER codex login status >/dev/null 2>&1 && return 0
  docker exec $CONTAINER sh -c 'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < $p/cmdline 2>/dev/null)" in */bin/codex*) kill ${p#/proc/} 2>/dev/null && echo "Ended unauthenticated codex (pid ${p#/proc/})";; esac; done'
}

cmd_build() { need_docker; say "Building frontend"; npm run -s build; say "Building sandbox image"; npm run -s sandbox:build; }

start_backend() {
  if [ -n "$(backend_pid)" ]; then
    say "Backend already running (pid $(backend_pid))"
  else
    [ -z "$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)" ] || die "port $PORT is used by another program"
    say "Starting backend on 127.0.0.1:$PORT"
    nohup npm start >"$LOG" 2>&1 &
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
  docker image inspect $IMAGE >/dev/null 2>&1 || { say "Sandbox image missing, building"; npm run -s sandbox:build; }
  [ -f dist/index.html ] || { say "Building frontend"; npm run -s build; }
  say "Starting sandbox container"; npm run -s sandbox:start
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
    say "Stopping sandbox (workspace and credentials preserved)"; npm run -s sandbox:stop
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
    codex)    exec npm run -s login:codex ;;
    claude)   exec docker exec -it $CONTAINER claude auth login ;;
    opencode) exec docker exec -it $CONTAINER opencode auth login ;;
    *) die "usage: $0 login {codex|claude|opencode}" ;;
  esac
}

cmd_clean() {
  cmd_stop
  docker info >/dev/null 2>&1 && docker inspect $CONTAINER >/dev/null 2>&1 && npm run -s sandbox:clean
  say "Container removed. Volumes (devicedock-workspace, devicedock-home) kept."
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  restart-backend) cmd_restart_backend ;;
  status)  cmd_status ;;
  open)    [ -n "$(backend_pid)" ] || die "backend not running"; npm run -s open ;;
  logs)    tail -n 50 -f "$LOG" ;;
  login)   shift; cmd_login "${1:-}" ;;
  build)   cmd_build ;;
  test)    npm run -s typecheck && npm test ;;
  clean)   cmd_clean ;;
  *) echo "usage: $0 {start|stop|restart|restart-backend|status|open|logs|login <codex|claude|opencode>|build|test|clean}"; exit 1 ;;
esac
