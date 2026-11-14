#!/bin/sh
# claude, codex and opencode all start through this wrapper (it is symlinked under those names).
#
# The agents live in a writable npm prefix in the home volume ($NPM_CONFIG_PREFIX), because the image is read-only
# and their own updaters run `npm install -g <package>`. Each agent is set up there on its first start:
#   codex, opencode  copied from the pinned copy in the image (/opt/agent): offline and fast
#   claude           installed from npm at the pinned version (its licence does not allow shipping it in the image)
#
# DEVICEDOCK_AGENT_UPDATES (set when the sandbox is created; off unless it is "on"):
#   off  the agents' updaters are turned off, and an agent whose version differs from the image's is set up again,
#        so what runs is what the image pins
#   on   the agents update themselves; an agent older than the image's version is set up again
# DEVICEDOCK_AGENT_NO_INSTALL=1 never installs anything (status and health checks): it runs what is there.
set -u
agent=$(basename "$0")
case "$agent" in
  claude) pkg=@anthropic-ai/claude-code ;;
  codex) pkg=@openai/codex ;;
  opencode) pkg=opencode-ai ;;
  *) echo "run this as claude, codex or opencode" >&2; exit 2 ;;
esac
prefix="${NPM_CONFIG_PREFIX:-$HOME/.devicedock/agents}"
seed=/opt/agent
bin="$prefix/bin/$agent"
dest="$prefix/lib/node_modules/$pkg"
updates=off
[ "${DEVICEDOCK_AGENT_UPDATES:-off}" = on ] && updates=on

version_of() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -1; }
# The version the image pins for this agent.
pinned() {
  if [ -d "$seed/lib/node_modules/$pkg" ]; then version_of "$seed/lib/node_modules/$pkg"
  else cat /etc/devicedock-claude-version 2>/dev/null; fi
}

# True when the agent is missing, or is not the version it should be (see DEVICEDOCK_AGENT_UPDATES above).
needs_setup() {
  [ -x "$bin" ] || return 0
  want=$(pinned); have=$(version_of "$dest")
  [ -n "$want" ] && [ -n "$have" ] && [ "$want" != "$have" ] || return 1
  [ "$updates" = off ] || [ "$(printf '%s\n%s\n' "$have" "$want" | sort -V | tail -1)" = "$want" ]
}

setup() {
  want=$(pinned)
  if [ -d "$seed/lib/node_modules/$pkg" ]; then
    # Copy next to the destination, then swap: the agent is never half there, and the bin link comes last.
    tmp="$prefix/.setup-$agent"
    rm -rf "$tmp" "$tmp.old"
    mkdir -p "$prefix/bin" "$(dirname "$dest")" && cp -a "$seed/lib/node_modules/$pkg" "$tmp" || { rm -rf "$tmp"; return 1; }
    [ ! -e "$dest" ] || mv "$dest" "$tmp.old"
    mv "$tmp" "$dest" && rm -f "$bin" && cp -a "$seed/bin/$agent" "$bin"; ok=$?
    rm -rf "$tmp.old"
    return $ok
  else
    echo "Installing Claude Code ${want:-latest} into your home volume (about a minute)..." >&2
    npm install -g --no-fund --no-audit --loglevel=error --fetch-retries=1 "$pkg@${want:-latest}" >&2 || return 1
    npm cache clean --force >/dev/null 2>&1
    rm -rf "$HOME/.devicedock/claude-code" # where earlier images installed it
  fi
}

if [ -z "${DEVICEDOCK_AGENT_NO_INSTALL:-}" ] && needs_setup; then
  # One setup at a time in this prefix; whoever waited checks again, since the other one may have done the work.
  mkdir -p "$prefix"
  (
    flock -n 9 || { echo "Waiting for another agent's setup to finish..." >&2; flock 9; }
    if needs_setup; then setup || echo "Could not set up $agent $(pinned) in your home volume." >&2; fi
  ) 9>"$prefix/.setup.lock"
fi

run="$bin"
if [ ! -x "$bin" ]; then
  run="$seed/bin/$agent"
  if [ ! -x "$run" ]; then echo "$agent is not installed yet (it installs on first start)" >&2; exit 127; fi
  [ -n "${DEVICEDOCK_AGENT_NO_INSTALL:-}" ] || echo "Running the copy of $agent in the image." >&2
fi

if [ "$updates" = off ]; then
  export DISABLE_AUTOUPDATER=1 OPENCODE_DISABLE_AUTOUPDATE=1
  [ "$agent" = codex ] && set -- -c check_for_update_on_startup=false "$@"
fi
# OpenCode unpacks a native library into its temp directory and loads it; /tmp is mounted noexec.
if [ "$agent" = opencode ]; then
  mkdir -p "$HOME/.cache/bun-tmp" && export BUN_TMPDIR="$HOME/.cache/bun-tmp"
fi
exec "$run" "$@"
