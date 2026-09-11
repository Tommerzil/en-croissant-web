import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import type { Position } from "@/components/files/opening";
import { flattenDecks, fullOrder, nextDueCard, sumStats } from "@/components/files/puzzleDeck";

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

    it("picks the earliest due card, ties broken by chapter then index", () => {
        const cards = flattenDecks([[pos("a", T0)], [pos("b", earlier), pos("c", earlier)]]);
        expect(nextDueCard(cards, T0)?.fen).toBe("b");
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
        const s = sumStats([[pos("a", later, 3)], [pos("b", earlier, 0), pos("c", earlier, 2)]]);
        expect(s.total).toBe(3);
        expect(s.unseen).toBe(1);
        expect(s.practiced).toBe(1);
        expect(s.due).toBe(1);
        expect(s.nextDue?.toISOString()).toBe(later.toISOString());
    });
});
