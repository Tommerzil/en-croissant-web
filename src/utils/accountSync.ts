import { basename, resolve } from "@tauri-apps/api/path";
import { error, info } from "@tauri-apps/plugin-log";
import { getDefaultStore } from "jotai";
import type { DatabaseInfo } from "@/bindings";
import { commands, events } from "@/bindings";
import {
    type DatabaseConversionState,
    databaseConversionStateAtom,
    sessionsAtom,
    storedDatabasesDirAtom,
} from "@/state/atoms";
import { downloadChessCom, getChessComAccount } from "@/utils/chess.com/api";
import { getDatabases, query_games } from "@/utils/db";
import { getDatabasesDir } from "@/utils/directories";
import { downloadLichess, getLichessAccount } from "@/utils/lichess/api";
import type { Session } from "@/utils/session";
import { unwrap } from "@/utils/unwrap";

export type AccountType = "lichess" | "chesscom";

/** An account is synced automatically at most this often. */
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Whether an automatic sync is due for an account last synced at `syncedAt`. */
export function isSyncDue(syncedAt: number | undefined, now: number): boolean {
    if (syncedAt === undefined) return true;
    // A stored time in the future means a clock was wrong; sync rather than wait it out.
    if (syncedAt > now) return true;
    return now - syncedAt >= SYNC_INTERVAL_MS;
}

export function sessionAccount(session: Session): { type: AccountType; username: string } | null {
    if (session.lichess?.account) return { type: "lichess", username: session.lichess.username };
    if (session.chessCom?.stats) return { type: "chesscom", username: session.chessCom.username };
    return null;
}

export function sessionTotalGames(session: Session): number {
    if (session.lichess?.account) {
        const perfs = session.lichess.account.perfs;
        return (
            (perfs?.ultraBullet?.games ?? 0) +
            (perfs?.bullet?.games ?? 0) +
            (perfs?.blitz?.games ?? 0) +
            (perfs?.rapid?.games ?? 0) +
            (perfs?.classical?.games ?? 0) +
            (perfs?.correspondence?.games ?? 0)
        );
    }
    let total = 0;
    for (const stat of Object.values(session.chessCom?.stats ?? {})) {
        if (stat.record) total += stat.record.win + stat.record.loss + stat.record.draw;
    }
    return total;
}

/** Fetches fresh account stats; null when the site did not answer. */
export async function refreshSession(session: Session): Promise<Session | null> {
    if (session.lichess?.account) {
        const account = await getLichessAccount({
            token: session.lichess.accessToken,
            username: session.lichess.username,
        });
        if (!account) return null;
        return {
            ...session,
            lichess: { ...session.lichess, account },
            updatedAt: Date.now(),
        };
    }
    if (session.chessCom) {
        const stats = await getChessComAccount(session.chessCom.username);
        if (!stats) return null;
        return {
            ...session,
            chessCom: { username: session.chessCom.username, stats },
            updatedAt: Date.now(),
        };
    }
    return null;
}

export function sameAccount(a: Session, b: Session): boolean {
    if (a.lichess && b.lichess) return a.lichess.account.id === b.lichess.account.id;
    if (a.chessCom && b.chessCom) return a.chessCom.username === b.chessCom.username;
    return false;
}

async function getLastGameDate(database: DatabaseInfo): Promise<number | null> {
    const games = await query_games(database.file, {
        options: {
            page: 1,
            pageSize: 1,
            sort: "date",
            direction: "desc",
            skipCount: false,
        },
    });
    if (games.count! > 0 && games.data[0].date && games.data[0].time) {
        const [year, month, day] = games.data[0].date.split(".").map(Number);
        const [hour, minute, second] = games.data[0].time.split(":").map(Number);
        return Date.UTC(year, month - 1, day, hour, minute, second);
    }
    return null;
}

export function accountDatabaseName(type: AccountType, username: string): string {
    return `${username}_${type}.db3`;
}

/**
 * Downloads the games played since the last one in the account's database and
 * converts them into it. Progress is reported through `progressEvent` under the id
 * `${type}_${username}`, which is what the account card listens to.
 */
export async function syncAccountGames({
    type,
    username,
    token,
    total,
    database,
    databaseDir,
    setProgress,
}: {
    type: AccountType;
    username: string;
    token?: string;
    total: number;
    database: DatabaseInfo | null;
    databaseDir: string;
    setProgress?: (progress: number) => void;
}): Promise<void> {
    const store = getDefaultStore();
    const setConversionState = (
        update: (prev: DatabaseConversionState) => DatabaseConversionState,
    ) => store.set(databaseConversionStateAtom, update(store.get(databaseConversionStateAtom)));

    const downloadedGames = database?.type === "success" ? database.game_count : 0;
    const lastGameDate = database ? await getLastGameDate(database) : null;
    if (type === "lichess") {
        await downloadLichess(
            username,
            lastGameDate,
            total - downloadedGames,
            setProgress ?? (() => {}),
            token,
        );
    } else {
        await downloadChessCom(username, lastGameDate);
    }

    const pgnPath = await resolve(databaseDir, `${username}_${type}.pgn`);
    const dbPath = await resolve(databaseDir, accountDatabaseName(type, username));
    const dbTitle = username + (type === "lichess" ? " Lichess" : " Chess.com");
    try {
        info(`converting ${pgnPath} ${lastGameDate}`);
        const sourceFileName = await basename(pgnPath);
        setConversionState((prev) => ({
            ...prev,
            inProgress: true,
            targetDatabasePath: dbPath,
            targetDatabaseTitle: dbTitle,
            sourceFileName,
        }));
        unwrap(
            await commands.convertPgn(
                [pgnPath],
                dbPath,
                lastGameDate ? lastGameDate / 1000 : null,
                dbTitle,
                null,
            ),
        );
        events.progressEvent.emit({
            id: `${type}_${username}`,
            progress: 100,
            finished: true,
        });
        await commands.deleteEmptyGames(dbPath);
    } catch (e) {
        console.error(e);
    } finally {
        setConversionState((prev) => ({
            ...prev,
            inProgress: false,
            totalGames: 0,
            elapsedSeconds: 0,
            targetDatabasePath: null,
            targetDatabaseTitle: null,
            sourceFileName: null,
        }));
    }
}

let autoSyncRunning = false;

/**
 * Runs at app start: for every linked account whose last automatic sync is older
 * than SYNC_INTERVAL_MS, refreshes its stats and pulls in its new games, one
 * account at a time. The download button on the account card ignores the interval.
 */
export async function autoSyncAccounts(store: ReturnType<typeof getDefaultStore>): Promise<void> {
    if (autoSyncRunning) return;
    autoSyncRunning = true;
    try {
        const due = store
            .get(sessionsAtom)
            .filter((s) => sessionAccount(s) !== null && isSyncDue(s.syncedAt, Date.now()));
        if (due.length === 0) return;
        const databaseDir = store.get(storedDatabasesDirAtom) || (await getDatabasesDir());

        for (const stale of due) {
            const account = sessionAccount(stale)!;
            const label = `${account.type} account ${account.username}`;
            try {
                const session = (await refreshSession(stale)) ?? stale;
                if (session !== stale) {
                    store.set(sessionsAtom, (prev) =>
                        prev.map((s) => (sameAccount(s, session) ? session : s)),
                    );
                }
                const databases = await getDatabases();
                const database =
                    databases.find(
                        (db) => db.filename === accountDatabaseName(account.type, account.username),
                    ) ?? null;
                info(`auto-sync: ${label}`);
                await syncAccountGames({
                    type: account.type,
                    username: account.username,
                    token: session.lichess?.accessToken,
                    total: sessionTotalGames(session),
                    database,
                    databaseDir,
                });
                const syncedAt = Date.now();
                store.set(sessionsAtom, (prev) =>
                    prev.map((s) => (sameAccount(s, session) ? { ...s, syncedAt } : s)),
                );
            } catch (e) {
                // Left unsynced on purpose so the next app start tries again.
                error(`auto-sync failed for ${label}: ${e}`);
            }
        }
    } finally {
        autoSyncRunning = false;
    }
}
