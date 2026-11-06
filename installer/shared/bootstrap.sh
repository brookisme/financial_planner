#!/usr/bin/env bash
# Desktop app bootstrap: make sure pixi and the app environment exist, then hand off to the
# menu-bar app (python -m financial_planner.desktop). Sourced by the macOS app's launch script,
# which sets:
#   APP_SUPPORT  per-user folder for pixi, the environment and logs
#   PAYLOAD      the app bundle's payload (pixi binary, pixi.sha256, pixi.toml)
# and may define hooks: _setup_start / _setup_done (first-run "Setting up…" dialog) and
# _alert MSG (an error dialog).
#
# Nothing here touches your plan folders; uninstalling removes only APP_SUPPORT and the app.
#
# License: BSD 3-Clause
set -euo pipefail

ENV_DIR="$APP_SUPPORT/env"
PIXI="$APP_SUPPORT/pixi"
LOG="$APP_SUPPORT/launch.log"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
fail() {
  log "FAILED: $1"
  command -v _setup_done >/dev/null 2>&1 && _setup_done
  command -v _alert >/dev/null 2>&1 && _alert "$1 Details are in $LOG"
  exit 1
}

# Copy the bundled pixi into APP_SUPPORT (first run, or a newer app bundling another pixi).
ensure_pixi() {
  [ -x "$PIXI" ] && cmp -s "$PAYLOAD/pixi" "$PIXI" && return 0
  log "installing bundled pixi"
  cp "$PAYLOAD/pixi" "$PIXI" && chmod +x "$PIXI"
  if [ -f "$PAYLOAD/pixi.sha256" ]; then
    want="$(awk '{print $1}' "$PAYLOAD/pixi.sha256")"
    got="$(shasum -a 256 "$PIXI" | awk '{print $1}')"
    [ "$want" = "$got" ] || { rm -f "$PIXI"; fail "The bundled pixi failed its checksum."; }
  fi
}

# Install the environment on first run; reinstall if a newer app ships a different manifest.
ensure_env() {
  mkdir -p "$ENV_DIR"
  if ! cmp -s "$PAYLOAD/pixi.toml" "$ENV_DIR/pixi.toml"; then
    [ -f "$ENV_DIR/pixi.toml" ] && log "app manifest changed: reinstalling"
    cp "$PAYLOAD/pixi.toml" "$ENV_DIR/pixi.toml"
    rm -rf "$ENV_DIR/pixi.lock" "$ENV_DIR/.pixi"
  fi
  [ -x "$ENV_DIR/.pixi/envs/default/bin/python" ] && return 0
  log "pixi install (first run)"
  command -v _setup_start >/dev/null 2>&1 && _setup_start
  "$PIXI" install --manifest-path "$ENV_DIR/pixi.toml" >>"$LOG" 2>&1 \
    || fail "Setting up Financial Planner failed (is the internet connected?)."
  command -v _setup_done >/dev/null 2>&1 && _setup_done
  return 0
}

run_app() {
  local bin="$ENV_DIR/.pixi/envs/default/bin"
  log "starting the desktop app"
  exec env FP_APP_SUPPORT="$APP_SUPPORT" FP_PIXI="$PIXI" FP_MANIFEST="$ENV_DIR/pixi.toml" \
    PATH="$bin:$PATH" "$bin/python" -m financial_planner.desktop
}

bootstrap_and_launch() {
  mkdir -p "$APP_SUPPORT"
  ensure_pixi
  ensure_env
  run_app
}
