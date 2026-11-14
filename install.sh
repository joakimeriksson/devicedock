#!/bin/sh
# DeviceDock installer for macOS and Linux (on Windows: inside WSL 2).
#
#   curl -fsSL https://github.com/joakimeriksson/devicedock/releases/latest/download/install.sh | sh
#
# Downloads the release archive for this computer, checks it against the release's SHA256SUMS, and installs:
#   ~/.devicedock/bin/devicedock   the backend (one binary, web UI included)
#   ~/.devicedock/devicedock.sh    the console script
#   ~/.local/bin/devicedock        a launcher, so `devicedock` starts the console from anywhere
# Run it again to update. Nothing outside those paths is touched, and nothing runs as root.
#
# Settings (environment): DEVICEDOCK_VERSION (default: latest, or e.g. v0.2.0), DEVICEDOCK_HOME (~/.devicedock),
# DEVICEDOCK_BIN_DIR (~/.local/bin), DEVICEDOCK_REPO (joakimeriksson/devicedock).
set -eu

REPO="${DEVICEDOCK_REPO:-joakimeriksson/devicedock}"
VERSION="${DEVICEDOCK_VERSION:-latest}"
DEST="${DEVICEDOCK_HOME:-$HOME/.devicedock}"
BIN_DIR="${DEVICEDOCK_BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is needed"
command -v tar >/dev/null || die "tar is needed"

case "$(uname -s)" in
  Darwin) os=apple-darwin ;;
  Linux) os=unknown-linux-musl ;;
  *) die "DeviceDock runs on macOS and Linux. On Windows, run this inside WSL 2 (see the README)." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=aarch64 ;;
  x86_64 | amd64) arch=x86_64 ;;
  *) die "no DeviceDock build for $(uname -m)" ;;
esac
asset="devicedock-$arch-$os.tar.gz"
if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"
else base="https://github.com/$REPO/releases/download/$VERSION"; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading DeviceDock ($VERSION, $arch-$os)"
curl -fsSL --proto '=https' -o "$tmp/$asset" "$base/$asset" || die "download failed: $base/$asset"
curl -fsSL --proto '=https' -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "$asset is not listed in SHA256SUMS"
if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp/$asset" | awk '{print $1}')
else got=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}'); fi
[ "$got" = "$want" ] || die "checksum mismatch for $asset (expected $want, got $got)"
say "Checksum OK"

mkdir "$tmp/x"
tar -xzf "$tmp/$asset" -C "$tmp/x"
[ -f "$tmp/x/devicedock" ] || die "the archive has no devicedock binary"
[ -f "$tmp/x/devicedock.sh" ] || die "this release predates the installer; use DEVICEDOCK_VERSION=v0.2.0 or later"

update=no
[ -x "$DEST/bin/devicedock" ] && update=yes
mkdir -p "$DEST/bin" "$BIN_DIR"
chmod 755 "$tmp/x/devicedock" "$tmp/x/devicedock.sh"
# Replace by rename: a running backend keeps its old file until it restarts.
mv -f "$tmp/x/devicedock" "$DEST/bin/devicedock"
mv -f "$tmp/x/devicedock.sh" "$DEST/devicedock.sh"
# curl does not quarantine downloads, but a copy that came another way might be.
[ "$os" = apple-darwin ] && xattr -d com.apple.quarantine "$DEST/bin/devicedock" 2>/dev/null || true

launcher="$BIN_DIR/devicedock"
if [ -e "$launcher" ] && ! grep -q 'DeviceDock launcher' "$launcher" 2>/dev/null; then
  warn "$launcher exists and is not the DeviceDock launcher; leaving it alone. Start with: $DEST/devicedock.sh"
else
  cat >"$launcher" <<EOF
#!/bin/sh
# DeviceDock launcher (written by install.sh)
exec "$DEST/devicedock.sh" "\$@"
EOF
  chmod 755 "$launcher"
fi

say "Installed $("$DEST/bin/devicedock" --version) in $DEST"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc):"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
command -v docker >/dev/null || warn "Docker is not installed. DeviceDock needs Docker Desktop, Colima (brew install colima docker) or Docker Engine."
[ "$os" = unknown-linux-musl ] && ! command -v lsof >/dev/null && warn "Install lsof (for example: sudo apt install lsof); the console uses it to find the backend."

echo
if [ "$update" = yes ]; then
  say "Updated. Restart on the new version with:  devicedock upgrade"
  echo "  (also downloads the newest sandbox image and recreates the sandbox; your files and agent logins are kept)"
else
  say "Next: run  devicedock"
  echo "  It downloads the sandbox image the first time (contiki variant; DEVICEDOCK_VARIANT=base|contiki|esp32|full),"
  echo "  starts everything, and 'o' opens the page in Chrome. Plug in a board and share it from the page."
fi
