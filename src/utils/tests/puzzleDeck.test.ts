import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { type Position, positionSchema } from "@/components/files/opening";
import {
    buildPuzzleCard,
    flattenDecks,
    fullOrder,
    nextDueCard,
    puzzleMoveDecision,
    reconcilePuzzleDeck,
    sumStats,
} from "@/components/files/puzzleDeck";
import type { TreeNode } from "@/utils/treeReducer";

function pos(fen: string, due: Date, reps = 0): Position {
    const card = createEmptyCard(new Date(0));
    card.due = due;
    card.reps = reps;
    return { fen, answer: "e4", card };
}

const T0 = new Date("2026-09-11T10:00:00Z");
const earlier = new Date("2026-09-11T09:00:00Z");
const later = new Date("2026-09-12T10:00:00Z");

describe("puzzleDeck", () => {
    it("flattens decks keeping chapter and index", () => {
        const cards = flattenDecks([[pos("a", T0)], [pos("b", T0), pos("c", T0)]]);
        expect(cards.map((c) => [c.chapter, c.index, c.fen])).toEqual([
            [0, 0, "a"],
            [1, 0, "b"],
            [1, 1, "c"],
        ]);
    });

    it("serves unseen cards in file order when nothing has been seen", () => {
        const cards = flattenDecks([[pos("a", T0)], [pos("b", earlier), pos("c", earlier)]]);
        expect(nextDueCard(cards, T0)?.fen).toBe("a");
    });

    it("serves a relearn card due now before an unseen card due earlier", () => {
        const cards = flattenDecks([[pos("unseen", earlier, 0)], [pos("missed", T0, 1)]]);
        expect(nextDueCard(cards, T0)?.fen).toBe("missed");
    });

    it("picks the earliest due relearn card, equal dues resolved by the lower chapter", () => {
        const mid = new Date("2026-09-11T09:30:00Z");
        const withMid = flattenDecks([[pos("mid", mid, 1)], [pos("early", earlier, 1)]]);
        expect(nextDueCard(withMid, T0)?.fen).toBe("early");

        const cards = flattenDecks([
            [pos("late", T0, 2)],
            [pos("tieChapter1", earlier, 1)],
            [pos("unseen", new Date(0), 0), pos("tieChapter2", earlier, 3)],
        ]);
        // Reversed so the chapter-2 card is met first: the tie-break, not input order, decides.
        expect(nextDueCard(cards.slice().reverse(), T0)?.fen).toBe("tieChapter1");
    });

    it("serves unseen cards in file order regardless of their due values", () => {
        const cards = flattenDecks([
            [pos("a", T0, 0), pos("b", earlier, 0)],
            [pos("c", new Date(0), 0)],
        ]);
        expect(nextDueCard(cards, T0)?.fen).toBe("a");
        expect(nextDueCard(cards.slice(1), T0)?.fen).toBe("b");
    });

    it("handles no chapters at all", () => {
        expect(flattenDecks([])).toEqual([]);
        expect(nextDueCard([])).toBeNull();
        const s = sumStats([]);
        expect(s.total).toBe(0);
        expect(s.nextDue).toBeNull();
    });

    it("returns null when nothing is due", () => {
        const cards = flattenDecks([[pos("a", later)], [pos("b", later)]]);
        expect(nextDueCard(cards, T0)).toBeNull();
    });

    it("treats a stored string due date like a Date", () => {
        const p = pos("a", earlier);
        (p.card as unknown as { due: string }).due = earlier.toISOString();
        expect(nextDueCard(flattenDecks([[p]]), T0)?.fen).toBe("a");
    });

    it("orders full practice by chapter then index", () => {
        const cards = flattenDecks([[pos("a", T0), pos("b", T0)], [pos("c", T0)]]);
        expect(fullOrder(cards.slice().reverse()).map((c) => c.fen)).toEqual(["a", "b", "c"]);
    });

    it("sums stats across chapters", () => {
        // getStats compares against the real clock, so "not yet due" must stay in the future.
        const future = new Date("2999-01-01T00:00:00Z");
        const s = sumStats([[pos("a", future, 3)], [pos("b", earlier, 0), pos("c", earlier, 2)]]);
        expect(s.total).toBe(3);
        expect(s.unseen).toBe(1);
        expect(s.practiced).toBe(1);
        expect(s.due).toBe(1);
        expect(s.nextDue?.toISOString()).toBe(future.toISOString());
    });
});

/** A chapter tree: `sans` is the mainline from the root; `root` side to move by halfMoves. */
function chapter(sans: string[], rootHalfMoves = 0): TreeNode {
    const make = (fen: string, san: string | null, halfMoves: number): TreeNode =>
        ({ fen, san, halfMoves, children: [] }) as unknown as TreeNode;
    const root = make("fen0", null, rootHalfMoves);
    let node = root;
    sans.forEach((san, i) => {
        const child = make(`fen${i + 1}`, san, rootHalfMoves + i + 1);
        node.children.push(child);
        node = child;
    });
    return root;
}

describe("buildPuzzleCard", () => {
    it("makes one card at the player's first move holding the whole line", () => {
        // White's lead-in Qe2, then Black (the player) solves Ne5, White Nxe5, Black Qe6.
        const card = buildPuzzleCard(chapter(["Qe2", "Ne5", "Nxe5", "Qe6"]), "black");
        expect(card?.fen).toBe("fen1");
        expect(card?.answer).toBe("Ne5");
        expect(card?.line).toEqual(["Ne5", "Nxe5", "Qe6"]);
    });

    it("ignores variations", () => {
        const root = chapter(["Qe2", "Ne5"]);
        const sideline = {
            fen: "side",
            san: "Kh7",
            halfMoves: 2,
            children: [],
        } as unknown as TreeNode;
        root.children[0].children.push(sideline);
        expect(buildPuzzleCard(root, "black")?.line).toEqual(["Ne5"]);
    });

    it("returns null when the player never moves", () => {
        expect(buildPuzzleCard(chapter(["Qe2"]), "black")).toBeNull();
        expect(buildPuzzleCard(chapter([]), "white")).toBeNull();
    });
});

describe("reconcilePuzzleDeck", () => {
    const fresh = (): Position => ({
        fen: "fen1",
        answer: "Ne5",
        line: ["Ne5", "Nxe5", "Qe6"],
        card: createEmptyCard(T0),
    });

    it("replaces per-move cards, keeping the first move card's scheduling and logs", () => {
        const first = { ...pos("fen1", later, 4), answer: "Ne5" };
        const second = { ...pos("fen3", later, 1), answer: "Qe6" };
        const logs = [{ fen: "fen1" }] as unknown as { fen: string }[];
        const next = reconcilePuzzleDeck({ positions: [first, second], logs } as never, fresh());
        expect(next?.positions).toHaveLength(1);
        expect(next?.positions[0].card.reps).toBe(4);
        expect(next?.positions[0].line).toEqual(["Ne5", "Nxe5", "Qe6"]);
        expect(next?.logs).toBe(logs);
    });

    it("starts over when no stored card matches the chapter", () => {
        const next = reconcilePuzzleDeck(
            { positions: [pos("other", later, 3)], logs: [] } as never,
            fresh(),
        );
        expect(next?.positions[0].card.reps).toBe(0);
    });

    it("is idempotent", () => {
        const once = reconcilePuzzleDeck({ positions: [], logs: [] }, fresh());
        expect(once).not.toBeNull();
        expect(reconcilePuzzleDeck(once!, fresh())).toBeNull();
    });

    it("clears a deck whose chapter no longer has a puzzle", () => {
        expect(reconcilePuzzleDeck({ positions: [pos("a", T0)], logs: [] }, null)).toEqual({
            positions: [],
            logs: [],
        });
        expect(reconcilePuzzleDeck({ positions: [], logs: [] }, null)).toBeNull();
    });

    it("keeps the line through the stored-deck schema", () => {
        expect(positionSchema.parse(fresh()).line).toEqual(["Ne5", "Nxe5", "Qe6"]);
    });
});

describe("puzzleMoveDecision", () => {
    const line = ["Ne5", "Nxe5", "Qe6"];

    it("accepts the next move of the line and misses anything else while solving", () => {
        expect(puzzleMoveDecision(line, 0, "solving", "Ne5")).toBe("accept");
        expect(puzzleMoveDecision(line, 2, "solving", "Qe6")).toBe("accept");
        expect(puzzleMoveDecision(line, 0, "solving", "Kh7")).toBe("miss");
    });

    it("ignores moves while a card loads and while the opponent replies", () => {
        expect(puzzleMoveDecision(line, 0, "loading", "Ne5")).toBe("ignore");
        expect(puzzleMoveDecision(line, 1, "replying", "Nxe5")).toBe("ignore");
    });

    it("lets anything be played when no puzzle is running or once it is over", () => {
        expect(puzzleMoveDecision(line, 0, "idle", "Kh7")).toBe("free");
        expect(puzzleMoveDecision(line, 3, "solved", "Kh7")).toBe("free");
        expect(puzzleMoveDecision(line, 1, "revealed", "Kh7")).toBe("free");
    });
});
