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
import { formatNumber } from "@/utils/format";
import { useStore } from "zustand";
import { commands } from "@/bindings";
import Comment from "@/components/common/Comment";
import ConfirmModal from "@/components/common/ConfirmModal";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  buildFromTree,
  formatReviewInterval,
  getNextReviewTimes,
  type Position,
  syncDeck,
  updateCardPerformance,
} from "@/components/files/opening";
// PUZZLE: cross-chapter card selection (Task 1).
import {
  type ChapterCard,
  flattenDecks,
  fullOrder,
  nextDueCard,
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
} from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { getTabFile, getTabGameNumber } from "@/utils/tabs";
import { findFen, getNodeAtPath } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

// PUZZLE: chapters parsed at once by the loader. parsePGN is one lexPgn HTTP round trip
// per chapter in the web build; one after another, ~900 chapters took a minute or two on
// every mount.
const CHAPTER_LOAD_WORKERS = 8;

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
  const headers = useStore(store, (s) => s.headers);
  const goToMove = useStore(store, (s) => s.goToMove);
  const setPracticePath = useStore(store, (s) => s.setPracticePath);
  const currentFen = useStore(store, (s) => s.currentNode().fen);
  const currentComment = useStore(store, (s) => s.currentNode().comment);

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
            const orientation = tree.headers.orientation || "white";
            const start = tree.headers.start || [];
            const deckAtom = deckAtomFamily({ file: tabFile.path, game: i });
            const existing = jotai.get(deckAtom);
            if (existing.positions.length === 0) {
              const fresh = buildFromTree(tree.root, orientation, start);
              if (fresh.length > 0) jotai.set(deckAtom, { positions: fresh, logs: [] });
            } else {
              const { positions, added, removed } = syncDeck(
                existing.positions,
                tree.root,
                orientation,
                start,
              );
              if (added > 0 || removed > 0) jotai.set(deckAtom, { ...existing, positions });
            }
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

  const [syncMessage, setSyncMessage] = useState<{
    added: number;
    removed: number;
  } | null>(null);
  const deckPositionsRef = useRef(deck.positions);
  deckPositionsRef.current = deck.positions;
  const lastSyncedTreeRef = useRef<string | null>(null);

  useEffect(() => {
    const treeFingerprint = JSON.stringify(root);
    if (lastSyncedTreeRef.current === treeFingerprint) return;

    const orientation = headers.orientation || "white";
    const start = headers.start || [];

    if (deckPositionsRef.current.length === 0) {
      const newDeck = buildFromTree(root, orientation, start);
      if (newDeck.length > 0) {
        setDeck({ positions: newDeck, logs: [] });
      }
    } else {
      // Sync existing deck with tree changes
      const { positions, added, removed } = syncDeck(
        deckPositionsRef.current,
        root,
        orientation,
        start,
      );
      if (added > 0 || removed > 0) {
        setDeck((prev) => ({ ...prev, positions }));
        setSyncMessage({ added, removed });
        setTimeout(() => setSyncMessage(null), 5000);
      }
    }
    lastSyncedTreeRef.current = treeFingerprint;
  }, [root, headers, setDeck]);

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

  // PUZZLE: after a correct move the board is advanced onto the solution node, so
  // currentNode().comment already works. After a WRONG move Board.tsx never plays it
  // (:202-213), so the board stays on the card node, which has no comment - the comment
  // lives on the card's answer child. Look that child up by SAN from the card node
  // (found via practiceState.currentFen) so both answer panels can show it, falling back
  // to currentNode().comment so nothing regresses when there is no pending answer.
  const answerComment = useMemo(() => {
    if (!practiceState.currentFen || !practiceState.answer) return currentComment;
    const cardPath = findFen(practiceState.currentFen, root);
    const cardNode = getNodeAtPath(root, cardPath);
    const answerChild = cardNode.children.find((c) => c.san === practiceState.answer);
    return answerChild?.comment ?? currentComment;
  }, [root, practiceState.currentFen, practiceState.answer, currentComment]);

  // PUZZLE: declared before switchChapter, whose failure path clears it.
  const pendingRef = useRef<ChapterCard | null>(null);

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
        setState(tree);
        setCurrentTab((prev) => {
          if (prev.gameOrigin.kind !== "file" && prev.gameOrigin.kind !== "temp_file") return prev;
          return { ...prev, gameOrigin: { ...prev.gameOrigin, gameNumber: chapter } };
        });
      } catch (e) {
        console.error(`PuzzlePracticePanel: chapter ${chapter + 1} could not be opened`, e);
        pendingRef.current = null;
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
      setPracticeState,
      setPracticePath,
      setShowComments,
      setEvalOpen,
    ],
  );

  const currentChapter = getTabGameNumber(currentTab);

  const presentCard = useCallback(
    (fen: string) => {
      const path = findFen(fen, root);
      goToMove(path);
      setPracticePath(path);
      // PUZZLE: pieces stay visible; this is a tactic, not blind recall.
      setShowComments(false);
      setEvalOpen(false);
      setCardStartTime(Date.now());
      setPracticeState({ phase: "waiting", currentFen: fen });
    },
    [
      root,
      goToMove,
      setPracticePath,
      setShowComments,
      setEvalOpen,
      setCardStartTime,
      setPracticeState,
    ],
  );

  // PUZZLE: a card in another chapter is presented only once that chapter's tree has
  // replaced `root`, which happens asynchronously after switchChapter.
  useEffect(() => {
    // PUZZLE: only a drill still waiting for this card may present it. A Stop or Reset
    // while the chapter loads puts the phase back to idle, and the late load must not
    // restart the drill. Stop and Reset also clear the ref; this catches any path that
    // forgets to.
    if (practiceState.phase !== "waiting") return;
    const pending = pendingRef.current;
    if (!pending || pending.chapter !== currentChapter) return;
    if (findFen(pending.fen, root).length === 0 && root.fen !== pending.fen) return;
    pendingRef.current = null;
    presentCard(pending.fen);
  }, [root, currentChapter, presentCard, practiceState.phase]);

  // PUZZLE: picks the next card across every chapter, then switches the tab to that
  // chapter when it is not the open one.
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

      if (!target) {
        // PUZZLE: no card left, so no chapter load may present one later.
        pendingRef.current = null;
        setPracticeState({ phase: "idle" });
        setPracticePath(null);
        setShowComments(true);
        setEvalOpen(true);
        return;
      }

      if (target.chapter === currentChapter) {
        presentCard(target.fen);
      } else {
        pendingRef.current = target;
        // PUZZLE: leave "correct" now, or the auto-advance effect re-arms its 300ms timer
        // (and the rating hotkeys stay live) for as long as the chapter takes to load.
        setPracticeState({ phase: "waiting", currentFen: target.fen });
        void switchChapter(target.chapter);
      }
    },
    [
      readAllDecks,
      sessionStats.mode,
      sessionStats.remainingPositions,
      currentChapter,
      presentCard,
      switchChapter,
      setPracticeState,
      setPracticePath,
      setShowComments,
      setEvalOpen,
    ],
  );

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
    if (practiceState.phase === "correct") {
      // PUZZLE: a puzzle with a comment never auto-advances, in either mode: the comment
      // explains what happened in the game and would flash past in 300ms. Anki mode shows
      // the grade buttons (grading advances); full mode shows the correct panel with a
      // "Next puzzle" button. Without a comment nothing changes.
      if (answerComment) return;
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
    practiceState.phase,
    practiceState.positionIndex,
    sessionStats.mode,
    newPractice,
    setSessionStats,
    practiceAutoDifficulty,
    deck.positions,
    setDeck,
    answerComment,
    advanceFullCorrect,
  ]);

  // PUZZLE: the full-practice correct panel's "Next puzzle" button and Space key.
  function nextPuzzle() {
    if (practiceState.phase !== "correct" || sessionStats.mode !== "full") return;
    advanceFullCorrect();
  }

  function handleQualityRating(grade: 1 | 2 | 3 | 4) {
    // PUZZLE: full practice never grades. Its correct panel now stays up for a puzzle
    // with a comment, so the rating keys must not grade (or re-present) the card there.
    if (sessionStats.mode === "full") return;
    if (practiceState.phase !== "correct" || practiceState.positionIndex === undefined) return;

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

  function skipCard() {
    if (sessionStats.mode === "full" && sessionStats.remainingPositions.length > 0) {
      const remainingPositions = sessionStats.remainingPositions.slice(1);
      setSessionStats((prev) => ({ ...prev, remainingPositions }));
      newPractice({ remainingPositions });
    } else {
      newPractice();
    }
  }

  // PUZZLE: the rating keys are off in full practice, which never grades.
  const ratingKeysEnabled = practiceState.phase === "correct" && sessionStats.mode !== "full";
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
  useHotkeys("space", () => skipCard(), {
    enabled: practiceState.phase === "incorrect",
  });
  // PUZZLE: Space is "Next puzzle" on the full-practice correct panel.
  useHotkeys("space", () => nextPuzzle(), {
    enabled: practiceState.phase === "correct" && sessionStats.mode === "full" && !!answerComment,
  });

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

        <Tabs.Panel value="train" style={{ overflow: "hidden" }}>
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
            {syncMessage && (
              <Alert
                title={t("Board.Practice.DeckSynced")}
                withCloseButton
                onClose={() => setSyncMessage(null)}
              >
                {syncMessage.added > 0 &&
                  t("Board.Practice.SyncAdded", {
                    count: syncMessage.added ?? 0,
                    number: formatNumber(syncMessage.added ?? 0),
                  })}
                {syncMessage.added > 0 && syncMessage.removed > 0 && " · "}
                {syncMessage.removed > 0 &&
                  t("Board.Practice.SyncRemoved", {
                    count: syncMessage.removed ?? 0,
                    number: formatNumber(syncMessage.removed ?? 0),
                  })}
              </Alert>
            )}
            {stats.total > 0 && (
              <>
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
                    {practiceState.currentFen && currentFen !== practiceState.currentFen ? (
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
                            goToMove(findFen(practiceState.currentFen!, root));
                          }}
                        >
                          {t("Board.Practice.GoBackToPosition")}
                        </Button>
                      </Stack>
                    ) : (
                      <Group gap="xs" justify="center">
                        <Text ta="center" fz="sm" c="dimmed">
                          {t("Board.Practice.MakeYourMove")}
                        </Text>
                        <Button
                          variant="light"
                          size="compact-xs"
                          color="red"
                          onClick={() => {
                            // PUZZLE: drop a card whose chapter is still loading, or the
                            // load would restart the drill after Stop.
                            pendingRef.current = null;
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
                          }}
                        >
                          {t("Common.Stop")}
                        </Button>
                      </Group>
                    )}
                  </Paper>
                )}

                {practiceState.phase === "correct" && sessionStats.mode !== "full" && (
                  <>
                    {/* PUZZLE: the solution node's comment, above the rating buttons. */}
                    {answerComment && (
                      <Paper p="xs" withBorder>
                        <Comment comment={answerComment} />
                      </Paper>
                    )}
                    <QualityRatingPanel
                      onRate={handleQualityRating}
                      card={
                        practiceState.positionIndex !== undefined
                          ? deck.positions[practiceState.positionIndex].card
                          : undefined
                      }
                      timeTaken={practiceState.timeTaken}
                    />
                  </>
                )}

                {/* PUZZLE: full practice shows a correct panel only for a puzzle with a
                    comment, which never auto-advances; "Next puzzle" or Space moves on. */}
                {practiceState.phase === "correct" &&
                  sessionStats.mode === "full" &&
                  !!answerComment && (
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
                        <Paper p="xs" withBorder w="100%">
                          <Comment comment={answerComment} />
                        </Paper>
                        <Button variant="light" size="sm" onClick={nextPuzzle}>
                          {/* PUZZLE: literal string; see the i18n note in the plan's
                              constraints. */}
                          Next puzzle
                        </Button>
                      </Stack>
                    </Paper>
                  )}

                {practiceState.phase === "incorrect" && (
                  <Paper p="sm" withBorder>
                    <Stack gap="xs" align="center">
                      <Group gap="xs">
                        <ThemeIcon size="md" color="red" variant="light" radius="xl">
                          <IconX size={16} />
                        </ThemeIcon>
                        <Text fw={500} c="red">
                          {t("Common.Incorrect")}
                        </Text>
                      </Group>
                      <Text fz="sm" c="dimmed">
                        {t("Board.Practice.CorrectMoveWas", {
                          move: practiceState.answer,
                        })}
                      </Text>
                      {/* PUZZLE: the solution node's comment explains what happened. A
                          wrong move is never played (Board.tsx), so the board stays on
                          the card node; answerComment reads it from the answer child. */}
                      {answerComment && (
                        <Paper p="xs" withBorder w="100%">
                          <Comment comment={answerComment} />
                        </Paper>
                      )}
                      <Button variant="light" size="sm" onClick={skipCard}>
                        {t("Board.Practice.NextPosition")}
                      </Button>
                    </Stack>
                  </Paper>
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
