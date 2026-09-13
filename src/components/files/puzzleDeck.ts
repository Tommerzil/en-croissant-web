/**
 * Cross-chapter deck selection for puzzle sets.
 *
 * A puzzle set is a multi-game PGN; each chapter has its own deck under the
 * `deck-${file}-${game}` storage key that Board.tsx already reads. These helpers only
 * decide WHICH chapter and card comes next; grading and persistence stay per chapter.
 * Kept free of React so it can be unit-tested.
 */
import { createEmptyCard } from "ts-fsrs";
import type { PracticeData } from "@/state/atoms";
import type { TreeNode } from "@/utils/treeReducer";
import { getStats, type Position } from "./opening";

export type ChapterCard = {
    chapter: number;
    index: number;
    fen: string;
    due: Date;
    reps: number;
};

/** Stored cards come back from JSON with `due` as a string; normalise once here. */
function dueOf(p: Position): Date {
    return new Date(p.card.due);
}

export function flattenDecks(decks: Position[][]): ChapterCard[] {
    const out: ChapterCard[] = [];
    decks.forEach((positions, chapter) => {
        positions.forEach((p, index) => {
            out.push({ chapter, index, fen: p.fen, due: dueOf(p), reps: p.card.reps });
        });
    });
    return out;
}

function fileOrderBefore(a: ChapterCard, b: ChapterCard): boolean {
    return a.chapter < b.chapter || (a.chapter === b.chapter && a.index < b.index);
}

/**
 * The next card to present, among cards due at or before `now`.
 *
 * Seen cards (`reps > 0`) come first: the earliest due wins, ties resolve by chapter then
 * index. Only when no seen card is due is an unseen card served, the first in file order
 * (lowest chapter, then lowest index). An unseen card's `due` is its creation time, which
 * is always in the past, so ordering unseen cards by `due` would put every one of them
 * ahead of a missed puzzle and a miss would not come back for weeks.
 */
export function nextDueCard(cards: ChapterCard[], now: Date = new Date()): ChapterCard | null {
    let seen: ChapterCard | null = null;
    let unseen: ChapterCard | null = null;
    for (const c of cards) {
        if (c.due > now) continue;
        if (c.reps > 0) {
            if (
                seen === null ||
                c.due < seen.due ||
                (c.due.getTime() === seen.due.getTime() && fileOrderBefore(c, seen))
            ) {
                seen = c;
            }
        } else if (unseen === null || fileOrderBefore(c, unseen)) {
            unseen = c;
        }
    }
    return seen ?? unseen;
}

/** Every card once, in file order. */
export function fullOrder(cards: ChapterCard[]): ChapterCard[] {
    return cards.slice().sort((a, b) => a.chapter - b.chapter || a.index - b.index);
}

export function sumStats(decks: Position[][]): ReturnType<typeof getStats> {
    const total = { unseen: 0, due: 0, practiced: 0, nextDue: null as Date | null, total: 0 };
    for (const positions of decks) {
        const s = getStats(positions);
        total.unseen += s.unseen;
        total.due += s.due;
        total.practiced += s.practiced;
        total.total += s.total;
        if (s.nextDue && (!total.nextDue || s.nextDue < total.nextDue)) {
            total.nextDue = s.nextDue;
        }
    }
    return total;
}

/**
 * The single card of a puzzle chapter: the first mainline node where the player is to
 * move, with every mainline move from there to the end, opponent replies included.
 * Variations are ignored, so moves explored after a puzzle can never become cards.
 * Returns null when the player never moves.
 */
export function buildPuzzleCard(root: TreeNode, color: "white" | "black"): Position | null {
    const line: string[] = [];
    let cardNode: TreeNode | null = null;
    let node = root;
    while (node.children.length > 0) {
        const next = node.children[0];
        const playerToMove = (node.halfMoves % 2 === 0) === (color === "white");
        if (!cardNode && playerToMove) cardNode = node;
        if (cardNode) {
            if (!next.san) return null;
            line.push(next.san);
        }
        node = next;
    }
    if (!cardNode || line.length === 0) return null;
    return { fen: cardNode.fen, answer: line[0], line, card: createEmptyCard() };
}

function sameLine(a: string[] | undefined, b: string[] | undefined): boolean {
    return !!a && !!b && a.length === b.length && a.every((san, i) => san === b[i]);
}

/**
 * The deck a puzzle chapter should hold, or null when the stored one is already right.
 * A stored deck is right when it is exactly the fresh card (same position and line).
 * Anything else - several per-move cards, a card without a line, a deck left behind by
 * a regenerated file - is replaced by the fresh card, keeping the scheduling state and
 * logs of a stored card at the same position when there is one.
 */
export function reconcilePuzzleDeck(
    stored: PracticeData,
    fresh: Position | null,
): PracticeData | null {
    if (!fresh) {
        return stored.positions.length === 0 ? null : { positions: [], logs: [] };
    }
    const [only] = stored.positions;
    if (
        stored.positions.length === 1 &&
        only.fen === fresh.fen &&
        sameLine(only.line, fresh.line)
    ) {
        return null;
    }
    const keep = stored.positions.find((p) => p.fen === fresh.fen);
    if (!keep) return { positions: [fresh], logs: [] };
    return { positions: [{ ...keep, answer: fresh.answer, line: fresh.line }], logs: stored.logs };
}

export type PuzzleStatus = "idle" | "loading" | "solving" | "replying" | "solved" | "revealed";

/**
 * What a move played on a puzzle file's board means. "accept": the next move of the line.
 * "miss": a wrong move while solving. "ignore": a card is loading or the opponent's reply
 * is on its way; not a miss. "free": no puzzle is running or it is over, anything goes
 * (the next puzzle reloads its chapter from the file).
 */
export function puzzleMoveDecision(
    line: string[],
    step: number,
    status: PuzzleStatus,
    san: string,
): "accept" | "miss" | "ignore" | "free" {
    if (status === "idle" || status === "solved" || status === "revealed") return "free";
    if (status !== "solving") return "ignore";
    return line[step] === san ? "accept" : "miss";
}
