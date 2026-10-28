#!/bin/sh
# Checks that this machine can build, test and screenshot the app, and names what
# is missing instead of letting a build fail halfway through.
#
#   make doctor
set -u

failed=0
ok()   { printf '  ok       %s\n' "$1"; }
miss() { printf '  MISSING  %s\n' "$1"; failed=1; }
warn() { printf '  warn     %s\n' "$1"; }

echo "Kubi environment"

pinned=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml 2>/dev/null)
if command -v cargo >/dev/null 2>&1; then
  version=$(cargo --version | awk '{print $2}')
  if [ -n "$pinned" ] && [ "$version" != "$pinned" ]; then
    warn "cargo $version, rust-toolchain.toml pins $pinned (rustup switches per directory)"
  else
    ok "cargo $version"
  fi
else
  miss "cargo — install Rust from https://rustup.rs"
fi

for component in rustfmt clippy; do
  if command -v rustup >/dev/null 2>&1; then
    if rustup component list --installed 2>/dev/null | grep -q "^$component-"; then
      ok "$component"
    else
      miss "$component — rustup component add $component"
    fi
  fi
done

if command -v node >/dev/null 2>&1; then
  major=$(node --version | sed 's/^v\([0-9]*\).*/\1/')
  if [ "$major" -ge 20 ] 2>/dev/null; then
    ok "node $(node --version)"
  else
    miss "node >= 20, found $(node --version)"
  fi
else
  miss "node — install Node 20 or newer"
fi

if [ -d apps/desktop/node_modules ]; then
  ok "apps/desktop/node_modules"
else
  miss "apps/desktop/node_modules — run make install"
fi

# Screenshots are how a UI change gets looked at, so a browser is a working tool,
# not a nicety; without one only `make preview` is available.
browser=""
for candidate in "${CHROME:-}" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then browser="$candidate"; break; fi
done
if [ -z "$browser" ]; then
  for name in chromium google-chrome chromium-browser; do
    if command -v "$name" >/dev/null 2>&1; then browser="$name"; break; fi
  done
fi
if [ -n "$browser" ]; then
  ok "browser for make shots: $browser"
else
  warn "no Chrome or Chromium — make shots needs one (set CHROME to its path)"
fi

# The shell compiles against WebKitGTK on Linux; macOS and Windows need nothing extra.
if [ "$(uname -s)" = "Linux" ]; then
  if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    ok "webkit2gtk-4.1"
  else
    miss "libwebkit2gtk-4.1-dev (apt), libayatana-appindicator3-dev, librsvg2-dev, patchelf"
  fi
fi

if [ "$failed" -eq 0 ]; then
  echo "ready: make verify"
else
  echo "not ready: fix the MISSING lines above"
fi
exit "$failed"
