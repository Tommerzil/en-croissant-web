import { describe, expect, it } from "vitest";
import {
    appDataDir,
    basename,
    dirname,
    documentDir,
    join,
    resolve,
    resolveResource,
    sep,
} from "../shims/tauri-path";

describe("path shim", () => {
    it("roots are virtual", async () => {
        expect(await appDataDir()).toBe("/");
        expect(await documentDir()).toBe("/documents");
        expect(await resolveResource("sound/standard/move.mp3")).toBe(
            "/resources/sound/standard/move.mp3",
        );
        expect(sep()).toBe("/");
    });
    it("resolve and join normalise", async () => {
        expect(await resolve("/", "db")).toBe("/db");
        expect(await resolve("/db/", "a.db3")).toBe("/db/a.db3");
        expect(await join("/documents", "x", "..", "y.pgn")).toBe("/documents/y.pgn");
        expect(await resolve("engines", "stockfish")).toBe("/engines/stockfish");
    });
    it("basename and dirname", async () => {
        expect(await basename("/db/a.db3")).toBe("a.db3");
        expect(await basename("/db/a.db3", ".db3")).toBe("a");
        expect(await dirname("/db/a.db3")).toBe("/db");
    });
});
