/**
 * Cross-chapter deck selection for puzzle sets.
 *
 * A puzzle set is a multi-game PGN; each chapter has its own deck under the
 * `deck-${file}-${game}` storage key that Board.tsx already reads. These helpers only
 * decide WHICH chapter and card comes next; grading and persistence stay per chapter.
 * Kept free of React so it can be unit-tested.
 */
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
