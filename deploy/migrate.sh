#!/usr/bin/env bash
# Copy the desktop En Croissant game databases to the server data dir.
# Usage: deploy/migrate.sh user@host /opt/chess/data
set -euo pipefail
HOST="${1:?ssh host}"
REMOTE_DATA="${2:?remote data dir}"
SRC="${HOME}/.local/share/org.encroissant.app/db"
[ -d "$SRC" ] || { echo "no desktop data at $SRC"; exit 1; }
ssh "$HOST" "mkdir -p '$REMOTE_DATA/db'"
# db/ only: engines/engines.json holds desktop-absolute paths and must not travel.
rsync -av --progress \
  --include='*.db3' --include='*.pgn' --include='*.ecsi' --include='*.info' --exclude='*' \
  "$SRC/" "$HOST:$REMOTE_DATA/db/"
ssh "$HOST" "ls -la '$REMOTE_DATA/db'"
