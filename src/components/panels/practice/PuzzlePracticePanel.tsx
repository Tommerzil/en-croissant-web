import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import {
  IconArrowBack,
  IconArrowRight,
  IconBook,
  IconCheck,
  IconFlame,
  IconInfoCircle,
  IconTarget,
  IconX,
} from "@tabler/icons-react";
import dayjs from "dayjs";
import { getDefaultStore, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { formatDate } from "ts-fsrs";
import { useStore } from "zustand";
import { commands } from "@/bindings";
import Comment from "@/components/common/Comment";
import ConfirmModal from "@/components/common/ConfirmModal";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  formatReviewInterval,
  getNextReviewTimes,
  type Position,
  updateCardPerformance,
} from "@/components/files/opening";
// PUZZLE: cross-chapter card selection, one card per puzzle, and move decisions.
import {
  buildPuzzleCard,
  type ChapterCard,
  flattenDecks,
  fullOrder,
  nextDueCard,
  type PuzzleStatus,
  puzzleMoveDecision,
  reconcilePuzzleDeck,
  sumStats,
} from "@/components/files/puzzleDeck";
import {
  currentEvalOpenAtom,
  currentInvisibleAtom,
  currentPracticeTabAtom,
  currentShowCommentsAtom,
  currentTabAtom,
  deckAtomFamily,
  type PracticeData,
  type PracticeSessionStats,
  practiceCardStartTimeAtom,
  practiceSessionStatsAtom,
  practiceStateAtom,
  practiceAutoDifficultyAtom,
  puzzleMoveHandlerAtom,
} from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { getTabFile, getTabGameNumber } from "@/utils/tabs";
import { findFen, getNodeAtPath } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

// PUZZLE: chapters parsed at once by the loader. parsePGN is one lexPgn HTTP round trip
// per chapter in the web build; one after another, ~900 chapters took a minute or two on
// every mount.
const CHAPTER_LOAD_WORKERS = 8;

// PUZZLE: pause before the opponent's reply, and between moves of a revealed solution.
const REPLY_DELAY_MS = 400;

/**
 * Practice panel for puzzle sets: a copy of PracticePanel that drills every chapter of
 * a multi-game file as one deck.
 *
 * Deliberately a copy, not a shared component. Touching PracticePanel would put every
 * upstream merge in conflict; a new file never does. The differences are listed in the
 * design spec and are all marked below with "PUZZLE:" comments.
 */
function PuzzlePracticePanel() {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const goToMove = useStore(store, (s) => s.goToMove);
  const setPracticePath = useStore(store, (s) => s.setPracticePath);
  const currentFen = useStore(store, (s) => s.currentNode().fen);

  // PUZZLE: writable, because presenting a card in another chapter moves the tab's
  // game number (Board.tsx validates against the deck of that game number).
  const [currentTab, setCurrentTab] = useAtom(currentTabAtom);
  const tabFile = getTabFile(currentTab);
  const [resetModal, toggleResetModal] = useToggle();

  const [deck, setDeck] = useAtom(
    deckAtomFamily({
      file: tabFile?.path || "",
      game: getTabGameNumber(currentTab),
    }),
  );

  // PUZZLE: every chapter gets its own deck under the key Board.tsx already reads
  // (`deck-${file}-${game}`). Built or synced once per mount; the existing effect
  // below keeps the open chapter in sync afterwards.
  const numChapters = tabFile?.numGames ?? 1;
  const [chaptersLoaded, setChaptersLoaded] = useState(false);
  // PUZZLE: set when the file or some of its chapters could not be read, so the panel
  // shows why instead of sitting on "Loading..." forever.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decksVersion, setDecksVersion] = useState(0);
  const setState = useStore(store, (s) => s.setState);

  const readAllDecks = useCallback((): Position[][] => {
    if (!tabFile) return [];
    const jotai = getDefaultStore();
    const out: Position[][] = [];
    for (let i = 0; i < numChapters; i++) {
      out.push(jotai.get(deckAtomFamily({ file: tabFile.path, game: i })).positions);
    }
    return out;
  }, [tabFile, numChapters]);

  // PUZZLE: deckAtomFamily's atomWithStorage has no `getOnInit`, so it reads localStorage
  // only once mounted. Board.tsx mounts the open chapter's atom only; without this
  // subscription every other chapter would read back empty and the loader below would
  // overwrite its saved progress with a fresh deck.
  useEffect(() => {
    if (!tabFile) return;
    const jotai = getDefaultStore();
    const unsubs = Array.from({ length: numChapters }, (_, i) =>
      jotai.sub(deckAtomFamily({ file: tabFile.path, game: i }), () => {}),
    );
    return () => unsubs.forEach((u) => u());
  }, [tabFile, numChapters]);

  useEffect(() => {
    if (!tabFile || chaptersLoaded) return;
    // PUZZLE: a file with no games has no chapters to read, and readGames(path, 0, -1)
    // panics in the desktop backend (src-tauri/src/pgn.rs). Skip the loader; the panel
    // then shows the existing "no puzzle positions" message.
    if (numChapters === 0) {
      setChaptersLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      // PUZZLE: a failed read ends the load with a message rather than an unhandled
      // rejection that leaves the panel on "Loading..." with no way out.
      let pgns: string[];
      try {
        pgns = unwrap(await commands.readGames(tabFile.path, 0, numChapters - 1));
      } catch (e) {
        console.error("PuzzlePracticePanel: could not read the puzzle file", e);
        if (!cancelled) {
          // i18n: literal string; see the i18n note in the plan's constraints.
          setLoadError(
            `Could not read the puzzle file: ${e instanceof Error ? e.message : String(e)}`,
          );
          setChaptersLoaded(true);
        }
        return;
      }
      const jotai = getDefaultStore();
      // PUZZLE: one unreadable chapter is skipped; the chapters after it still load.
      let skipped = 0;
      // PUZZLE: a bounded pool of workers, each taking the next chapter index from this
      // shared counter. Every `cancelled` check matters: after unmount the deck atoms are
      // unsubscribed and read back empty, so a late write would overwrite saved progress,
      // and a remount would otherwise run a second loader alongside this one.
      let nextChapter = 0;
      const worker = async () => {
        while (true) {
          if (cancelled) return;
          const i = nextChapter++;
          if (i >= pgns.length) return;
          try {
            const tree = await parsePGN(pgns[i]);
            if (cancelled) return;
            // PUZZLE: no await between reading the existing deck and writing it. That
            // ordering is what keeps a concurrent write to the same deck from being lost.
            // PUZZLE: one card per chapter holding the whole solution line. Stored decks
            // from before (one card per move) are replaced; see reconcilePuzzleDeck.
            const orientation = tree.headers.orientation || "white";
            const deckAtom = deckAtomFamily({ file: tabFile.path, game: i });
            const next = reconcilePuzzleDeck(
              jotai.get(deckAtom),
              buildPuzzleCard(tree.root, orientation),
            );
            if (next) jotai.set(deckAtom, next);
          } catch (e) {
            console.error(`PuzzlePracticePanel: chapter ${i + 1} could not be read`, e);
            skipped++;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CHAPTER_LOAD_WORKERS, pgns.length) }, () => worker()),
      );
      if (!cancelled) {
        if (skipped > 0) {
          // i18n: literal string; see the i18n note in the plan's constraints.
          setLoadError(`${skipped} of ${pgns.length} chapters could not be read and were skipped.`);
        }
        setChaptersLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // chaptersLoaded is a dependency on purpose: the guard above reads it, and a reset
    // clears it (and bumps decksVersion) to force a reload without looping.
  }, [tabFile, numChapters, decksVersion, chaptersLoaded]);

  // PUZZLE: no tree-sync effect. It exists in PracticePanel so a repertoire being edited
  // gains cards; a puzzle set is never edited in the app, and its cards come only from the
  // loader above. Kept, it would turn moves explored after a puzzle into cards.

  // PUZZLE: stats over the whole file. `deck` and `chaptersLoaded` are dependencies so
  // grading the open chapter and the initial load both refresh it.
  const stats = useMemo(() => sumStats(readAllDecks()), [readAllDecks, deck, chaptersLoaded]);

  const setInvisible = useSetAtom(currentInvisibleAtom);
  const setShowComments = useSetAtom(currentShowCommentsAtom);
  const setEvalOpen = useSetAtom(currentEvalOpenAtom);
  const [practiceState, setPracticeState] = useAtom(practiceStateAtom);
  const [sessionStats, setSessionStats] = useAtom(practiceSessionStatsAtom);
  const setCardStartTime = useSetAtom(practiceCardStartTimeAtom);
  const practiceAutoDifficulty = useAtomValue(practiceAutoDifficultyAtom);

  // PUZZLE: a puzzle is solved move by move against its whole line. Board.tsx hands every
  // practice move to `decide` below, between renders, so what it reads lives in refs;
  // `puzzle` mirrors those refs for rendering.
  const statusRef = useRef<PuzzleStatus>("idle");
  const stepRef = useRef(0);
  const missedRef = useRef(false);
  const lineRef = useRef<string[]>([]);
  const cardRef = useRef<{ fen: string; path: number[]; startTime: number } | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [puzzle, setPuzzle] = useState<{
    status: PuzzleStatus;
    missed: boolean;
    step: number;
    path: number[];
  }>({ status: "idle", missed: false, step: 0, path: [] });

  const syncPuzzle = useCallback((status: PuzzleStatus) => {
    statusRef.current = status;
    setPuzzle({
      status,
      missed: missedRef.current,
      step: stepRef.current,
      path: cardRef.current?.path ?? [],
    });
  }, []);

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    timersRef.current.push(setTimeout(fn, ms));
  }, []);

  // PUZZLE: the node reached after `k` moves of the line. The line is the chapter's
  // mainline, so each step is child 0.
  const pathAfter = useCallback(
    (k: number) => [...(cardRef.current?.path ?? []), ...Array<number>(k).fill(0)],
    [],
  );

  // PUZZLE: comments of every mainline node from the card to the end of the line, shown
  // once the puzzle is over. A merged chain has one per part.
  const puzzleComments = useMemo(() => {
    if (puzzle.status !== "solved" && puzzle.status !== "revealed") return [];
    const out: string[] = [];
    let node = getNodeAtPath(root, puzzle.path);
    for (let k = 0; node && k < lineRef.current.length; k++) {
      node = node.children[0];
      if (node?.comment) out.push(node.comment);
    }
    return out;
  }, [root, puzzle.status, puzzle.path]);

  const expectedFen =
    puzzle.status === "idle"
      ? undefined
      : getNodeAtPath(root, [...puzzle.path, ...Array<number>(puzzle.step).fill(0)])?.fen;

  // PUZZLE: a finished puzzle is graded once. Only a clean solve reaches the rating
  // buttons, the auto-advance and the full-mode correct panel.
  const solvedClean =
    practiceState.phase === "correct" && puzzle.status === "solved" && !puzzle.missed;
  const puzzleFailed =
    practiceState.phase === "correct" &&
    (puzzle.status === "revealed" || (puzzle.status === "solved" && puzzle.missed));

  // PUZZLE: declared before switchChapter, whose failure path clears it. `loaded` is set
  // when the chapter's tree is replaced, so a reload of the open chapter cannot present
  // the card on the tree it is about to replace.
  const pendingRef = useRef<(ChapterCard & { loaded: boolean }) | null>(null);

  // PUZZLE: same mechanism as the info panel's game pager, without the dirty check
  // (a puzzle chapter is never edited during a drill).
  const switchChapter = useCallback(
    async (chapter: number) => {
      if (!tabFile) return;
      // PUZZLE: a failed read or parse ends the drill with a message. Unhandled, it left
      // the phase "waiting" on a position that is not on the board; that panel has no
      // Stop, and "Go back" went to the old chapter's root, so the user was stuck.
      try {
        const data = unwrap(await commands.readGames(tabFile.path, chapter, chapter));
        if (data[0] === undefined) throw new Error("the file has no such chapter");
        const tree = await parsePGN(data[0]);
        if (pendingRef.current?.chapter === chapter) pendingRef.current.loaded = true;
        setState(tree);
        setCurrentTab((prev) => {
          if (prev.gameOrigin.kind !== "file" && prev.gameOrigin.kind !== "temp_file") return prev;
          return { ...prev, gameOrigin: { ...prev.gameOrigin, gameNumber: chapter } };
        });
      } catch (e) {
        console.error(`PuzzlePracticePanel: chapter ${chapter + 1} could not be opened`, e);
        pendingRef.current = null;
        clearTimers();
        syncPuzzle("idle");
        setPracticeState({ phase: "idle" });
        setPracticePath(null);
        setShowComments(true);
        setEvalOpen(true);
        // i18n: literal string; see the i18n note in the plan's constraints.
        setLoadError(
          `Could not open chapter ${chapter + 1}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [
      tabFile,
      setState,
      setCurrentTab,
      clearTimers,
      syncPuzzle,
      setPracticeState,
      setPracticePath,
      setShowComments,
      setEvalOpen,
    ],
  );

  const currentChapter = getTabGameNumber(currentTab);

  const presentCard = useCallback(
    (target: ChapterCard) => {
      const path = findFen(target.fen, root);
      const card = readAllDecks()[target.chapter]?.[target.index];
      clearTimers();
      goToMove(path);
      setPracticePath(path);
      // PUZZLE: pieces stay visible; this is a tactic, not blind recall.
      setShowComments(false);
      setEvalOpen(false);
      const startTime = Date.now();
      setCardStartTime(startTime);
      lineRef.current = card?.line ?? (card ? [card.answer] : []);
      stepRef.current = 0;
      missedRef.current = false;
      cardRef.current = { fen: target.fen, path, startTime };
      syncPuzzle("solving");
      setPracticeState({ phase: "waiting", currentFen: target.fen });
    },
    [
      root,
      readAllDecks,
      clearTimers,
      goToMove,
      setPracticePath,
      setShowComments,
      setEvalOpen,
      setCardStartTime,
      syncPuzzle,
      setPracticeState,
    ],
  );

  // PUZZLE: a card is presented only once its chapter has been read into `root`, which
  // happens asynchronously after switchChapter.
  useEffect(() => {
    // PUZZLE: only a drill still waiting for this card may present it. A Stop or Reset
    // while the chapter loads puts the phase back to idle, and the late load must not
    // restart the drill. Stop and Reset also clear the ref; this catches any path that
    // forgets to.
    if (practiceState.phase !== "waiting") return;
    const pending = pendingRef.current;
    if (!pending || !pending.loaded || pending.chapter !== currentChapter) return;
    if (findFen(pending.fen, root).length === 0 && root.fen !== pending.fen) return;
    pendingRef.current = null;
    presentCard(pending);
  }, [root, currentChapter, presentCard, practiceState.phase]);

  // PUZZLE: picks the next card across every chapter, then reloads that chapter from the
  // file, even when it is the open one, so moves explored after the last puzzle are gone.
  const newPractice = useCallback(
    (stats?: Partial<PracticeSessionStats>) => {
      const all = flattenDecks(readAllDecks());
      if (all.length === 0) return;

      const currentMode = stats?.mode ?? sessionStats.mode;
      const remaining = stats?.remainingPositions ?? sessionStats.remainingPositions;

      let target: ChapterCard | null = null;
      if (currentMode === "full") {
        target = remaining.length > 0 ? (fullOrder(all)[remaining[0]] ?? null) : null;
      } else {
        target = nextDueCard(all);
      }

      clearTimers();
      if (!target) {
        // PUZZLE: no card left, so no chapter load may present one later.
        pendingRef.current = null;
        syncPuzzle("idle");
        setPracticeState({ phase: "idle" });
        setPracticePath(null);
        setShowComments(true);
        setEvalOpen(true);
        return;
      }

      pendingRef.current = { ...target, loaded: false };
      syncPuzzle("loading");
      // PUZZLE: leave "correct" now, or the auto-advance effect re-arms its 300ms timer
      // (and the rating hotkeys stay live) for as long as the chapter takes to load.
      setPracticeState({ phase: "waiting", currentFen: target.fen });
      void switchChapter(target.chapter);
    },
    [
      readAllDecks,
      sessionStats.mode,
      sessionStats.remainingPositions,
      clearTimers,
      syncPuzzle,
      switchChapter,
      setPracticeState,
      setPracticePath,
      setShowComments,
      setEvalOpen,
    ],
  );

  // PUZZLE: ends the puzzle. The panel sets the practice state itself, because Board.tsx
  // no longer does for puzzle files. A miss or a revealed solution grades the card
  // "again" here, once; full practice never grades, as before.
  const finishPuzzle = useCallback(
    (outcome: "solved" | "revealed") => {
      const card = cardRef.current;
      if (!card) return;
      clearTimers();
      syncPuzzle(outcome);
      // PUZZLE: free the practice path, so the player can step through the solution and
      // explore past the card.
      setPracticePath(null);
      setShowComments(true);
      setEvalOpen(true);
      setPracticeState({
        phase: "correct",
        currentFen: card.fen,
        answer: lineRef.current[0],
        positionIndex: 0,
        timeTaken: Date.now() - card.startTime,
      });
      const failed = outcome === "revealed" || missedRef.current;
      if (failed && sessionStats.mode !== "full" && tabFile) {
        const stored = getDefaultStore().get(
          deckAtomFamily({ file: tabFile.path, game: currentChapter }),
        ).positions[0];
        if (stored) updateCardPerformance(setDeck, 0, stored.card, 1);
      }
    },
    [
      clearTimers,
      syncPuzzle,
      setPracticePath,
      setShowComments,
      setEvalOpen,
      setPracticeState,
      sessionStats.mode,
      tabFile,
      currentChapter,
      setDeck,
    ],
  );

  // PUZZLE: Board.tsx's view of the puzzle. Reassigned every render so it always calls
  // the current callbacks; the handler registered below only forwards to it.
  const decideRef = useRef<(san: string) => "accept" | "reject" | "free">(() => "free");
  decideRef.current = (san) => {
    const decision = puzzleMoveDecision(lineRef.current, stepRef.current, statusRef.current, san);
    if (decision === "free") return "free";
    if (decision === "ignore") return "reject";
    // PUZZLE: a move made away from the puzzle's position (after navigating) is neither
    // right nor wrong; "Go back to position" returns the player.
    const expected = getNodeAtPath(store.getState().root, pathAfter(stepRef.current));
    if (store.getState().currentNode().fen !== expected?.fen) return "reject";
    if (decision === "miss") {
      missedRef.current = true;
      syncPuzzle("solving");
      return "reject";
    }
    const played = stepRef.current + 1;
    stepRef.current = played;
    if (played >= lineRef.current.length) {
      // PUZZLE: after Board.tsx has played the final move.
      after(0, () => finishPuzzle("solved"));
      return "accept";
    }
    syncPuzzle("replying");
    after(REPLY_DELAY_MS, () => {
      // PUZZLE: the reply is already in the tree; moving onto it plays it without marking
      // the file changed, and lands on the right node even if the player navigated.
      stepRef.current = played + 1;
      goToMove(pathAfter(played + 1));
      syncPuzzle("solving");
    });
    return "accept";
  };

  const setPuzzleHandler = useSetAtom(puzzleMoveHandlerAtom);
  useEffect(() => {
    setPuzzleHandler({ decide: (san) => decideRef.current(san) });
    return () => {
      setPuzzleHandler(null);
      clearTimers();
      statusRef.current = "idle";
    };
  }, [setPuzzleHandler, clearTimers]);

  // PUZZLE: plays the rest of the line at the reply pace and ends the puzzle as revealed.
  const showSolution = useCallback(() => {
    if (statusRef.current !== "solving" && statusRef.current !== "replying") return;
    clearTimers();
    const from = stepRef.current;
    const total = lineRef.current.length;
    goToMove(pathAfter(from));
    syncPuzzle("replying");
    for (let k = from + 1; k <= total; k++) {
      after((k - from) * REPLY_DELAY_MS, () => {
        stepRef.current = k;
        goToMove(pathAfter(k));
        if (k === total) finishPuzzle("revealed");
      });
    }
  }, [clearTimers, goToMove, pathAfter, syncPuzzle, after, finishPuzzle]);

  // PUZZLE: Stop from any puzzle panel. The open chapter is reloaded from the file, which
  // drops moves explored after the puzzle.
  const stopPractice = useCallback(() => {
    pendingRef.current = null;
    clearTimers();
    syncPuzzle("idle");
    setPracticeState({ phase: "idle" });
    setPracticePath(null);
    setInvisible(false);
    setShowComments(true);
    setEvalOpen(true);
    setSessionStats({
      mode: "anki",
      remainingPositions: [],
      correct: 0,
      incorrect: 0,
      streak: 0,
      bestStreak: 0,
    });
    void switchChapter(currentChapter);
  }, [
    clearTimers,
    syncPuzzle,
    setPracticeState,
    setPracticePath,
    setInvisible,
    setShowComments,
    setEvalOpen,
    setSessionStats,
    switchChapter,
    currentChapter,
  ]);

  // PUZZLE: one full-practice step after a correct answer. The auto-advance timer below
  // and the "Next puzzle" button both make exactly this update.
  const advanceFullCorrect = useCallback(() => {
    const remainingPositions = sessionStats.remainingPositions.slice(1);
    setSessionStats((prev) => ({
      ...prev,
      remainingPositions,
      correct: prev.correct + 1,
      streak: prev.streak + 1,
      bestStreak: Math.max(prev.bestStreak, prev.streak + 1),
    }));
    newPractice({ remainingPositions, mode: "full" });
  }, [sessionStats.remainingPositions, setSessionStats, newPractice]);

  useEffect(() => {
    if (solvedClean) {
      // PUZZLE: a puzzle with a comment never auto-advances, in either mode: the comment
      // explains what happened in the game and would flash past in 300ms. Anki mode shows
      // the grade buttons (grading advances); full mode shows the correct panel with a
      // "Next puzzle" button. Without a comment nothing changes.
      if (puzzleComments.length > 0) return;
      if (sessionStats.mode === "full") {
        const timer = setTimeout(advanceFullCorrect, 300);
        return () => clearTimeout(timer);
      } else if (practiceAutoDifficulty !== "none" && practiceState.positionIndex !== undefined) {
        const positionIndex = practiceState.positionIndex;
        const timer = setTimeout(() => {
          const card = deck.positions[positionIndex].card;
          const grade = Number(practiceAutoDifficulty) as 1 | 2 | 3 | 4;

          updateCardPerformance(setDeck, positionIndex, card, grade);
          setSessionStats((prev) => ({
            ...prev,
            correct: prev.correct + 1,
            streak: prev.streak + 1,
            bestStreak: Math.max(prev.bestStreak, prev.streak + 1),
          }));
          newPractice();
        }, 300);
        return () => clearTimeout(timer);
      }
    }
  }, [
    solvedClean,
    practiceState.positionIndex,
    sessionStats.mode,
    newPractice,
    setSessionStats,
    practiceAutoDifficulty,
    deck.positions,
    setDeck,
    puzzleComments.length,
    advanceFullCorrect,
  ]);

  // PUZZLE: the full-practice correct panel's "Next puzzle" button and Space key.
  function nextPuzzle() {
    if (!solvedClean || sessionStats.mode !== "full") return;
    advanceFullCorrect();
  }

  // PUZZLE: "Next puzzle" after a miss or a revealed solution. The card was already
  // graded when the puzzle ended; this only counts it and moves on.
  function nextAfterFailure() {
    if (!puzzleFailed) return;
    if (sessionStats.mode === "full") {
      const remainingPositions = sessionStats.remainingPositions.slice(1);
      setSessionStats((prev) => ({
        ...prev,
        remainingPositions,
        incorrect: prev.incorrect + 1,
        streak: 0,
      }));
      newPractice({ remainingPositions, mode: "full" });
    } else {
      setSessionStats((prev) => ({ ...prev, incorrect: prev.incorrect + 1, streak: 0 }));
      newPractice();
    }
  }

  function handleQualityRating(grade: 1 | 2 | 3 | 4) {
    // PUZZLE: full practice never grades, and only a clean solve is rated.
    if (sessionStats.mode === "full") return;
    if (!solvedClean || practiceState.positionIndex === undefined) return;

    const { positionIndex } = practiceState;
    const card = deck.positions[positionIndex].card;

    updateCardPerformance(setDeck, positionIndex, card, grade);
    setSessionStats((prev) => ({
      ...prev,
      correct: prev.correct + 1,
      streak: prev.streak + 1,
      bestStreak: Math.max(prev.bestStreak, prev.streak + 1),
    }));
    newPractice();
  }

  function startPractice() {
    const stats: Partial<PracticeSessionStats> = {
      mode: "anki",
      remainingPositions: [],
      correct: 0,
      incorrect: 0,
      streak: 0,
      bestStreak: 0,
    };
    setSessionStats((prev) => ({ ...prev, ...stats }));
    newPractice(stats);
  }

  function startFullPractice() {
    // PUZZLE: indices into the whole file's card order, not the open chapter's deck.
    const indices = fullOrder(flattenDecks(readAllDecks())).map((_, i) => i);
    const stats: Partial<PracticeSessionStats> = {
      mode: "full",
      remainingPositions: indices,
      correct: 0,
      incorrect: 0,
      streak: 0,
      bestStreak: 0,
    };
    setSessionStats((prev) => ({ ...prev, ...stats }));
    newPractice(stats);
  }

  // PUZZLE: the rating keys are off in full practice, which never grades.
  const ratingKeysEnabled = solvedClean && sessionStats.mode !== "full";
  useHotkeys("1", () => handleQualityRating(1), {
    enabled: ratingKeysEnabled,
  });
  useHotkeys("2", () => handleQualityRating(2), {
    enabled: ratingKeysEnabled,
  });
  useHotkeys("3", () => handleQualityRating(3), {
    enabled: ratingKeysEnabled,
  });
  useHotkeys("4", () => handleQualityRating(4), {
    enabled: ratingKeysEnabled,
  });
  useHotkeys("space", () => nextAfterFailure(), {
    enabled: puzzleFailed,
  });
  // PUZZLE: Space is "Next puzzle" on the full-practice correct panel.
  useHotkeys("space", () => nextPuzzle(), {
    enabled: solvedClean && sessionStats.mode === "full" && puzzleComments.length > 0,
  });

  const commentsBox = puzzleComments.length > 0 && (
    <Paper p="xs" withBorder w="100%">
      <Stack gap="xs">
        {puzzleComments.map((comment, i) => (
          <Comment key={i} comment={comment} />
        ))}
      </Stack>
    </Paper>
  );

  const [positionsOpen, setPositionsOpen] = useToggle();
  const [logsOpen, setLogsOpen] = useToggle();
  const [tab, setTab] = useAtom(currentPracticeTabAtom);
  // PUZZLE: there is no Build tab, and Board.tsx only validates moves while the
  // practice sub-tab is "train".
  useEffect(() => {
    if (tab !== "train") setTab("train");
  }, [tab, setTab]);

  return (
    <>
      <Tabs
        h="100%"
        orientation="vertical"
        placement="right"
        value={tab}
        onChange={(v) => setTab(v!)}
        style={{
          display: "flex",
        }}
      >
        {/* PUZZLE: no Build tab; a puzzle set is authored outside the app. */}
        <Tabs.List>
          <Tabs.Tab value="train">{t("Board.Practice.Train")}</Tabs.Tab>
        </Tabs.List>

        {/* PUZZLE: scrolls, because a chain's comments push "Next puzzle" below the fold. */}
        <Tabs.Panel value="train" style={{ overflow: "auto" }}>
          <Stack p="sm" gap="md">
            {/* PUZZLE: why the file, or some of its chapters, did not load. */}
            {loadError && (
              <Alert color="red" icon={<IconInfoCircle />}>
                <Text fz="sm">{loadError}</Text>
              </Alert>
            )}
            {stats.total === 0 && (
              <Alert icon={<IconInfoCircle />}>
                {/* PUZZLE: literal string; see the i18n note in the plan's constraints. */}
                <Text fz="sm">
                  {chaptersLoaded
                    ? "This file has no puzzle positions."
                    : "Loading puzzles from every chapter..."}
                </Text>
              </Alert>
            )}
            {stats.total > 0 && (
              <>
                {/* PUZZLE: the prompt and its buttons come first; on a phone the
                    stats would otherwise push them below the fold. */}
                {practiceState.phase === "idle" && (
                  <Stack gap="sm">
                    {stats.due === 0 && stats.unseen === 0 ? (
                      <Paper p="sm" withBorder>
                        <Stack gap="xs" align="center">
                          <ThemeIcon size="xl" radius="xl" color="green" variant="light">
                            <IconCheck size={24} />
                          </ThemeIcon>
                          <Text ta="center" fw={500}>
                            {t("Board.Practice.PracticedAll1")}
                          </Text>
                          <Text ta="center" fz="sm" c="dimmed">
                            {t("Board.Practice.PracticedAll2")}{" "}
                            {dayjs(stats.nextDue).format("MMM D, HH:mm")}
                          </Text>
                        </Stack>
                      </Paper>
                    ) : (
                      <Button
                        size="md"
                        variant="light"
                        fullWidth
                        onClick={startPractice}
                        leftSection={<IconTarget size={20} />}
                        justify="space-between"
                        rightSection={
                          <Badge size="sm" variant="white" color="blue">
                            {stats.due + stats.unseen}
                          </Badge>
                        }
                      >
                        {t("Board.Practice.StartPractice")}
                      </Button>
                    )}
                    {/* PUZZLE: disabled until every chapter has loaded, because the
                        session's indices are computed over the whole file's card order
                        and would shift under it mid-session. The badge counts the whole
                        file, not the open chapter. */}
                    <Button
                      size="md"
                      variant="light"
                      color="gray"
                      fullWidth
                      disabled={!chaptersLoaded}
                      onClick={startFullPractice}
                      leftSection={<IconBook size={20} />}
                      justify="space-between"
                      rightSection={
                        <Badge size="sm" variant="white" color="gray">
                          {stats.total}
                        </Badge>
                      }
                    >
                      {/* PUZZLE: literal string; see the i18n note in the plan's constraints. */}
                      Practice all puzzles
                    </Button>
                  </Stack>
                )}

                {practiceState.phase === "waiting" && (
                  <Paper p="sm" withBorder>
                    {puzzle.status === "solving" &&
                    expectedFen !== undefined &&
                    currentFen !== expectedFen ? (
                      <Stack gap="xs" align="center">
                        <Text ta="center" fz="sm" c="dimmed">
                          {t("Board.Practice.NotOnPosition")}
                        </Text>
                        <Button
                          variant="light"
                          size="xs"
                          leftSection={<IconArrowBack size={14} />}
                          // PUZZLE: no setInvisible(true); pieces stay visible.
                          onClick={() => {
                            goToMove([...puzzle.path, ...Array<number>(puzzle.step).fill(0)]);
                          }}
                        >
                          {t("Board.Practice.GoBackToPosition")}
                        </Button>
                      </Stack>
                    ) : (
                      <Stack gap="xs" align="center">
                        {/* PUZZLE: literal strings; see the i18n note in the plan's constraints.
                            A miss says so without naming the right move. */}
                        <Text ta="center" fz="sm" c={puzzle.missed ? "red" : "dimmed"}>
                          {puzzle.status === "loading"
                            ? t("Common.Loading")
                            : puzzle.missed
                              ? "Not that one, try again"
                              : t("Board.Practice.MakeYourMove")}
                        </Text>
                        <Group gap="xs" justify="center">
                          <Button
                            variant="light"
                            size="compact-xs"
                            disabled={puzzle.status === "loading"}
                            onClick={showSolution}
                          >
                            Show solution
                          </Button>
                          <Button
                            variant="light"
                            size="compact-xs"
                            color="red"
                            onClick={stopPractice}
                          >
                            {t("Common.Stop")}
                          </Button>
                        </Group>
                      </Stack>
                    )}
                  </Paper>
                )}

                {solvedClean && sessionStats.mode !== "full" && (
                  <>
                    {/* PUZZLE: every comment on the line, above the rating buttons. */}
                    {commentsBox}
                    <QualityRatingPanel
                      onRate={handleQualityRating}
                      card={deck.positions[0]?.card}
                      timeTaken={practiceState.timeTaken}
                    />
                  </>
                )}

                {/* PUZZLE: full practice shows a correct panel only for a puzzle with a
                    comment, which never auto-advances; "Next puzzle" or Space moves on. */}
                {solvedClean && sessionStats.mode === "full" && puzzleComments.length > 0 && (
                  <Paper p="sm" withBorder>
                    <Stack gap="xs" align="center">
                      <Group gap="xs">
                        <ThemeIcon size="md" color="green" variant="light" radius="xl">
                          <IconCheck size={16} />
                        </ThemeIcon>
                        <Text fw={500} c="green">
                          {t("Board.Practice.Correct")}
                        </Text>
                        {practiceState.timeTaken !== undefined && (
                          <Text fz="xs" c="dimmed">
                            ({(practiceState.timeTaken / 1000).toFixed(1)}s)
                          </Text>
                        )}
                      </Group>
                      {commentsBox}
                      <Button variant="light" size="sm" onClick={nextPuzzle}>
                        {/* PUZZLE: literal string; see the i18n note in the plan's
                            constraints. */}
                        Next puzzle
                      </Button>
                    </Stack>
                  </Paper>
                )}

                {/* PUZZLE: a miss or a revealed solution. Graded once when it ended; the
                    board stays free to explore until the next puzzle reloads the chapter. */}
                {puzzleFailed && (
                  <Paper p="sm" withBorder>
                    <Stack gap="xs" align="center">
                      <Group gap="xs">
                        <ThemeIcon size="md" color="red" variant="light" radius="xl">
                          <IconX size={16} />
                        </ThemeIcon>
                        <Text fw={500} c="red">
                          {/* PUZZLE: literal strings; see the i18n note in the plan's
                              constraints. */}
                          {puzzle.status === "revealed" ? "Solution shown" : "Missed"}
                        </Text>
                      </Group>
                      {commentsBox}
                      <Group gap="xs" justify="center">
                        <Button variant="light" size="sm" onClick={nextAfterFailure}>
                          Next puzzle
                        </Button>
                        <Button variant="subtle" size="sm" color="red" onClick={stopPractice}>
                          {t("Common.Stop")}
                        </Button>
                      </Group>
                    </Stack>
                  </Paper>
                )}

                <Stack gap={4}>
                  <Group justify="space-between">
                    <Text fz="xs" fw={500}>
                      {t("Board.Practice.Progress")}
                    </Text>
                    <Text fz="xs" c="dimmed">
                      {Math.round((stats.practiced / stats.total) * 100)}%
                    </Text>
                  </Group>
                  <Progress.Root size="sm">
                    <Tooltip label={`${t("Board.Practice.Practiced")}: ${stats.practiced}`}>
                      <Progress.Section
                        value={(stats.practiced / stats.total) * 100}
                        color="blue"
                      />
                    </Tooltip>
                    <Tooltip label={`${t("Board.Practice.Due")}: ${stats.due}`}>
                      <Progress.Section value={(stats.due / stats.total) * 100} color="yellow" />
                    </Tooltip>
                    <Tooltip label={`${t("Board.Practice.Unseen")}: ${stats.unseen}`}>
                      <Progress.Section value={(stats.unseen / stats.total) * 100} color="gray" />
                    </Tooltip>
                  </Progress.Root>
                </Stack>

                <SimpleGrid cols={3} spacing="xs">
                  <Paper p="xs" withBorder radius="sm">
                    <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                      {t("Board.Practice.Practiced")}
                    </Text>
                    <Text fz="lg" fw={700} c="blue">
                      {stats.practiced}
                    </Text>
                  </Paper>
                  <Paper p="xs" withBorder radius="sm">
                    <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                      {t("Board.Practice.Due")}
                    </Text>
                    <Text fz="lg" fw={700} c="yellow">
                      {stats.due}
                    </Text>
                  </Paper>
                  <Paper p="xs" withBorder radius="sm">
                    <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                      {t("Board.Practice.Unseen")}
                    </Text>
                    <Text fz="lg" fw={700} c="dimmed">
                      {stats.unseen}
                    </Text>
                  </Paper>
                </SimpleGrid>

                {(practiceState.phase !== "idle" ||
                  sessionStats.correct > 0 ||
                  sessionStats.incorrect > 0) && (
                  <SimpleGrid cols={3} spacing="xs">
                    <Paper p="xs" withBorder radius="sm">
                      <Group gap={4} wrap="nowrap">
                        <ThemeIcon size="xs" color="green" variant="transparent">
                          <IconCheck size={12} />
                        </ThemeIcon>
                        <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                          {t("Board.Practice.SessionCorrect")}
                        </Text>
                      </Group>
                      <Text fz="lg" fw={700} c="green">
                        {sessionStats.correct}
                      </Text>
                    </Paper>
                    <Paper p="xs" withBorder radius="sm">
                      <Group gap={4} wrap="nowrap">
                        <ThemeIcon size="xs" color="red" variant="transparent">
                          <IconX size={12} />
                        </ThemeIcon>
                        <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                          {t("Board.Practice.SessionIncorrect")}
                        </Text>
                      </Group>
                      <Text fz="lg" fw={700} c="red">
                        {sessionStats.incorrect}
                      </Text>
                    </Paper>
                    <Paper p="xs" withBorder radius="sm">
                      <Group gap={4} wrap="nowrap">
                        {sessionStats.correct + sessionStats.incorrect > 0 ? (
                          <ThemeIcon size="xs" color="teal" variant="transparent">
                            <IconTarget size={12} />
                          </ThemeIcon>
                        ) : (
                          <ThemeIcon size="xs" color="orange" variant="transparent">
                            <IconFlame size={12} />
                          </ThemeIcon>
                        )}
                        <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                          {sessionStats.correct + sessionStats.incorrect > 0
                            ? t("Board.Practice.Accuracy")
                            : t("Board.Practice.Streak")}
                        </Text>
                      </Group>
                      <Text
                        fz="lg"
                        fw={700}
                        c={sessionStats.correct + sessionStats.incorrect > 0 ? "teal" : "orange"}
                      >
                        {sessionStats.correct + sessionStats.incorrect > 0
                          ? `${Math.round(
                              (sessionStats.correct /
                                (sessionStats.correct + sessionStats.incorrect)) *
                                100,
                            )}%`
                          : sessionStats.streak}
                      </Text>
                    </Paper>
                  </SimpleGrid>
                )}

                <Divider />

                <Group gap="xs">
                  <Button variant="subtle" size="xs" onClick={() => setPositionsOpen(true)}>
                    {t("Board.Practice.ShowAll")}
                  </Button>
                  <Button variant="subtle" size="xs" onClick={() => setLogsOpen(true)}>
                    {t("Board.Practice.ShowLogs")}
                  </Button>
                  <Button variant="subtle" size="xs" color="red" onClick={() => toggleResetModal()}>
                    {t("Common.Reset")}
                  </Button>
                </Group>
              </>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>

      <ConfirmModal
        title={t("Board.Practice.Reset.Title")}
        description={t("Board.Practice.Reset.Description", {
          name: tabFile?.name,
        })}
        opened={resetModal}
        onClose={toggleResetModal}
        onConfirm={() => {
          // PUZZLE: reset every chapter, then reload so the decks are rebuilt.
          const jotai = getDefaultStore();
          for (let i = 0; i < numChapters; i++) {
            if (tabFile)
              jotai.set(deckAtomFamily({ file: tabFile.path, game: i }), {
                positions: [],
                logs: [],
              });
          }
          // PUZZLE: a card pending on a chapter load belongs to a deck just emptied.
          pendingRef.current = null;
          clearTimers();
          syncPuzzle("idle");
          setLoadError(null);
          setChaptersLoaded(false);
          setDecksVersion((v) => v + 1);
          setPracticeState({ phase: "idle" });
          setPracticePath(null);
          setInvisible(false);
          setShowComments(true);
          setEvalOpen(true);
          setSessionStats({
            mode: "anki",
            remainingPositions: [],
            correct: 0,
            incorrect: 0,
            streak: 0,
            bestStreak: 0,
          });
          // PUZZLE: drop moves explored after the last puzzle.
          void switchChapter(currentChapter);
          toggleResetModal();
        }}
        confirmLabel={t("Common.Reset")}
      />
      {positionsOpen && (
        <PositionsModal open={positionsOpen} setOpen={setPositionsOpen} deck={deck} />
      )}
      <LogsModal open={logsOpen} setOpen={setLogsOpen} logs={deck.logs} />
    </>
  );
}

function QualityRatingPanel({
  onRate,
  card,
  timeTaken,
}: {
  onRate: (grade: 1 | 2 | 3 | 4) => void;
  card?: import("ts-fsrs").Card;
  timeTaken?: number;
}) {
  const { t } = useTranslation();
  const reviewTimes = card ? getNextReviewTimes(card) : null;

  return (
    <Paper p="sm" withBorder>
      <Stack gap="sm" align="center">
        <Group gap="xs">
          <ThemeIcon size="md" color="green" variant="light" radius="xl">
            <IconCheck size={16} />
          </ThemeIcon>
          <Text fw={500} c="green">
            {t("Board.Practice.Correct")}
          </Text>
          {timeTaken !== undefined && (
            <Text fz="xs" c="dimmed">
              ({(timeTaken / 1000).toFixed(1)}s)
            </Text>
          )}
        </Group>
        <Text fz="sm" c="dimmed">
          {t("Board.Practice.HowDifficult")}
        </Text>
        <SimpleGrid cols={4} spacing="xs" style={{ width: "100%" }}>
          <Tooltip label={t("Board.Practice.AgainHint")}>
            <Button
              color="red"
              variant="light"
              size="compact-md"
              onClick={() => onRate(1)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Again")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes ? formatReviewInterval(reviewTimes[1]) : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
          <Tooltip label={t("Board.Practice.HardHint")}>
            <Button
              color="orange"
              variant="light"
              size="compact-md"
              onClick={() => onRate(2)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Hard")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes ? formatReviewInterval(reviewTimes[2]) : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
          <Tooltip label={t("Board.Practice.GoodHint")}>
            <Button
              color="blue"
              variant="light"
              size="compact-md"
              onClick={() => onRate(3)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Good")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes ? formatReviewInterval(reviewTimes[3]) : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
          <Tooltip label={t("Board.Practice.EasyHint")}>
            <Button
              color="green"
              variant="light"
              size="compact-md"
              onClick={() => onRate(4)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Easy")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes ? formatReviewInterval(reviewTimes[4]) : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
        </SimpleGrid>
        <Text fz={10} c="dimmed">
          {t("Board.Practice.KeyboardHint")}
        </Text>
      </Stack>
    </Paper>
  );
}

function PositionsModal({
  open,
  setOpen,
  deck,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  deck: PracticeData;
}) {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const goToMove = useStore(store, (s) => s.goToMove);
  return (
    <Modal
      opened={open}
      onClose={() => setOpen(false)}
      size="xl"
      title={<b>{t("Board.Practice.Positions")}</b>}
    >
      {deck.positions.length === 0 && <Text>{t("Board.Practice.NoPositionsYet")}</Text>}
      <SimpleGrid cols={2}>
        {deck.positions.map((c) => {
          const position = findFen(c.fen, root);
          const node = getNodeAtPath(root, position);
          return (
            <Card key={c.fen}>
              <Text>
                {Math.floor(node.halfMoves / 2) + 1}
                {node.halfMoves % 2 === 0 ? ". " : "... "}
                {c.answer}
              </Text>
              <Divider my="xs" />
              <Group justify="space-between">
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Board.Practice.Status")}
                  </Text>
                  <Badge
                    color={c.card.reps === 0 ? "gray" : c.card.due < new Date() ? "yellow" : "blue"}
                  >
                    {c.card.reps === 0
                      ? t("Board.Practice.Unseen")
                      : c.card.due < new Date()
                        ? t("Board.Practice.Due")
                        : t("Board.Practice.Practiced")}
                  </Badge>
                </Stack>
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Board.Practice.Due")}
                  </Text>
                  <Text>{formatDate(c.card.due)}</Text>
                </Stack>
                <ActionIcon
                  variant="subtle"
                  onClick={() => {
                    goToMove(position);
                    setOpen(false);
                  }}
                >
                  <IconArrowRight />
                </ActionIcon>
              </Group>
            </Card>
          );
        })}
      </SimpleGrid>
    </Modal>
  );
}

function LogsModal({
  open,
  setOpen,
  logs,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  logs: PracticeData["logs"];
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const goToMove = useStore(store, (s) => s.goToMove);
  return (
    <Modal
      opened={open}
      onClose={() => setOpen(false)}
      size="xl"
      title={<b>{t("Board.Practice.Logs")}</b>}
    >
      <SimpleGrid cols={2}>
        {logs.length === 0 && <Text>{t("Board.Practice.NoLogsYet")}</Text>}
        {logs.map((log) => {
          const position = findFen(log.fen, root);
          const node = getNodeAtPath(root, position);

          return (
            <Card key={log.fen}>
              <Text>
                {Math.floor(node.halfMoves / 2) + 1}
                {node.halfMoves % 2 === 0 ? ". " : "... "}
                {node.san}
              </Text>

              <Divider my="xs" />
              <Group justify="space-between">
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Board.Practice.Rating")}
                  </Text>
                  <Badge
                    color={
                      log.rating === 1
                        ? "red"
                        : log.rating === 2
                          ? "orange"
                          : log.rating === 3
                            ? "blue"
                            : "green"
                    }
                  >
                    {log.rating === 1
                      ? t("Board.Practice.Again")
                      : log.rating === 2
                        ? t("Board.Practice.Hard")
                        : log.rating === 3
                          ? t("Board.Practice.Good")
                          : t("Board.Practice.Easy")}
                  </Badge>
                </Stack>
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Common.Date")}
                  </Text>
                  <Text>{formatDate(log.due)}</Text>
                </Stack>
                <ActionIcon
                  variant="subtle"
                  onClick={() => {
                    goToMove(position);
                    setOpen(false);
                  }}
                >
                  <IconArrowRight />
                </ActionIcon>
              </Group>
            </Card>
          );
        })}
      </SimpleGrid>
    </Modal>
  );
}

export default PuzzlePracticePanel;
