#!/bin/bash
# Headless 9Router: runs the web server directly, no interactive menu.
# Same environment the CLI (cli/cli.js) gives the server it spawns.
#
#   PORT / SERVER_PORT   port to listen on (default 20128)
#   BIND_HOST            interface to bind (default 0.0.0.0)
#   INITIAL_PASSWORD     dashboard password (needed for remote login on fresh installs)

NINEROUTER_HOME="${NINEROUTER_HOME:-/opt/9router}"
APP_DIR="$NINEROUTER_HOME/app"

if [ ! -f "$APP_DIR/custom-server.js" ] && [ ! -f "$APP_DIR/server.js" ]; then
    echo "[9router-server] app build not found in $APP_DIR" >&2
    exit 1
fi
SERVER_JS="$APP_DIR/custom-server.js"
[ -f "$SERVER_JS" ] || SERVER_JS="$APP_DIR/server.js"

# Same warm-up cli.js does: installs better-sqlite3 into ~/.9router/runtime if possible
# (non-fatal: node:sqlite / sql.js are used as fallback).
node -e 'try{require(process.argv[1]+"/hooks/sqliteRuntime").ensureSqliteRuntime({silent:true})}catch(e){}' "$NINEROUTER_HOME" 2>/dev/null

NODE_PATH_VALUE=$(node -e 'try{process.stdout.write(require(process.argv[1]+"/hooks/sqliteRuntime").buildEnvWithRuntime(process.env).NODE_PATH||"")}catch(e){}' "$NINEROUTER_HOME" 2>/dev/null)

cd "$APP_DIR" || exit 1
# HOSTNAME is overridden on purpose: Docker sets it to the container id.
exec env \
    PORT="${SERVER_PORT:-${PORT:-20128}}" \
    HOSTNAME="${BIND_HOST:-0.0.0.0}" \
    NODE_PATH="$NODE_PATH_VALUE" \
    node --dns-result-order=ipv4first --max-old-space-size="${NODE_MAX_HEAP_MB:-2048}" "$SERVER_JS"
