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

/** Earliest due card at or before `now`; ties resolve by chapter then index. */
export function nextDueCard(cards: ChapterCard[], now: Date = new Date()): ChapterCard | null {
    let best: ChapterCard | null = null;
    for (const c of cards) {
        if (c.due > now) continue;
        if (
            best === null ||
            c.due < best.due ||
            (c.due.getTime() === best.due.getTime() &&
                (c.chapter < best.chapter || (c.chapter === best.chapter && c.index < best.index)))
        ) {
            best = c;
        }
    }
    return best;
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
