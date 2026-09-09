#!/bin/sh
set -eu
: "${CHESS_DATA_DIR:=/data}"
mkdir -p "$CHESS_DATA_DIR/db" "$CHESS_DATA_DIR/engines" "$CHESS_DATA_DIR/documents"

# Seed the packaged Stockfish only when it is genuinely absent, and never overwrite a binary
# (or symlink) the user put there.
#
# Deciding on the seeded file itself rather than on `ls -A` matters: dotfiles and a `lost+found`
# make a dedicated filesystem look non-empty, which would silently skip the seed forever.
#
# The copy is staged under a fixed temporary name in the same directory and moved into place, so
# the final name only ever appears complete: an interrupted 78 MB copy (out of disk, container
# killed on first boot) can no longer leave a truncated `stockfish` behind. The name is fixed
# rather than PID-derived so a leftover from an interrupted boot is reused instead of piling up.
dst="$CHESS_DATA_DIR/engines/stockfish"
if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
  tmp="$CHESS_DATA_DIR/engines/.stockfish.seed.tmp"
  rm -f "$tmp"
  cp /opt/stockfish/stockfish "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$dst"
  echo "seeded $dst"
fi

exec /usr/local/bin/chess-server
