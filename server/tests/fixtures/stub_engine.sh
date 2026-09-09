#!/bin/sh
# Minimal UCI engine: answers the handshake and returns one line for any "go".
while IFS= read -r line; do
  case "$line" in
    uci)      echo "id name Stub"; echo "id author test"; echo "option name MultiPV type spin default 1 min 1 max 8"; echo "option name Threads type spin default 1 min 1 max 8"; echo "option name Hash type spin default 16 min 1 max 1024"; echo "uciok" ;;
    isready)  echo "readyok" ;;
    go*)      echo "info depth 1 seldepth 1 multipv 1 score cp 12 nodes 100 nps 1000 time 1 pv e2e4 e7e5"; echo "bestmove e2e4 ponder e7e5" ;;
    stop)     echo "bestmove e2e4" ;;
    quit)     exit 0 ;;
  esac
done
