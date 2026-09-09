#!/bin/sh
set -eu
: "${CHESS_DATA_DIR:=/data}"
mkdir -p "$CHESS_DATA_DIR/db" "$CHESS_DATA_DIR/engines" "$CHESS_DATA_DIR/documents"
# Seed the packaged Stockfish only into an empty engines directory; never overwrite user binaries.
if [ -z "$(ls -A "$CHESS_DATA_DIR/engines" 2>/dev/null)" ]; then
  cp /opt/stockfish/stockfish "$CHESS_DATA_DIR/engines/stockfish"
  chmod 755 "$CHESS_DATA_DIR/engines/stockfish"
  echo "seeded $CHESS_DATA_DIR/engines/stockfish"
fi
exec /usr/local/bin/chess-server
