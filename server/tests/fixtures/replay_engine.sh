#!/bin/sh
# A UCI engine that actually plays a game, unlike stub_engine.sh which answers "e2e4"
# to everything and so ends any engine-versus-engine game illegally on ply 2.
#
# It replays one fixed line, indexed by how many moves the incoming
# `position fen <fen> moves ...` command lists, so it plays whichever colour it is
# given and the two copies in an engine-versus-engine game stay in step. The line is
# thirty plies of quiet development -- no captures, no castling, no repetition -- so a
# game running it neither ends nor draws inside any test's window.
LINE="e2e4 e7e5 g1f3 b8c6 b1c3 g8f6 d2d3 d7d6 c1e3 c8e6 f1e2 f8e7 h2h3 h7h6 a2a3 a7a6 b2b3 b7b6 g2g3 g7g6 d1d2 d8d7 a1d1 a8d8 h1g1 h8g8 e1f1 e8f8 f1g2 f8g7"

played=0
while IFS= read -r line; do
  case "$line" in
    uci)
      echo "id name Replay"
      echo "id author test"
      echo "option name MultiPV type spin default 1 min 1 max 8"
      echo "option name Threads type spin default 1 min 1 max 8"
      echo "option name Hash type spin default 16 min 1 max 1024"
      echo "uciok"
      ;;
    isready) echo "readyok" ;;
    position*)
      rest="${line#*moves }"
      played=0
      if [ "$rest" != "$line" ]; then
        for _m in $rest; do played=$((played + 1)); done
      fi
      ;;
    go*)
      # Pace the game so a test watching a window sees several moves rather than the
      # whole line at once.
      sleep 0.1
      i=0
      best=""
      for m in $LINE; do
        i=$((i + 1))
        if [ "$i" -eq "$((played + 1))" ]; then
          best="$m"
          break
        fi
      done
      # Past the end of the line, resign the position rather than hang the caller.
      [ -n "$best" ] || best="0000"
      echo "info depth 1 seldepth 1 multipv 1 score cp 12 nodes 100 nps 1000 time 1 pv $best"
      echo "bestmove $best"
      ;;
    stop) echo "bestmove 0000" ;;
    quit) exit 0 ;;
  esac
done
