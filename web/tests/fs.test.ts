import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BaseDirectory,
    exists,
    mkdir,
    readDir,
    readTextFile,
    remove,
    writeTextFile,
} from "../shims/tauri-fs";

afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string, init?: RequestInit) => Response) {
    const f = vi.fn(async (url: string, init?: RequestInit) => handler(String(url), init));
    vi.stubGlobal("fetch", f);
    return f;
}

describe("fs shim", () => {
    it("readTextFile with baseDir option maps to /api/fs/read", async () => {
        const f = stub(() => new Response("[]", { status: 200 }));
        expect(await readTextFile("engines/engines.json", { baseDir: BaseDirectory.AppData })).toBe(
            "[]",
        );
        expect((f.mock.calls[0] as any)[0]).toBe("/api/fs/read?path=%2Fengines%2Fengines.json");
    });
    it("readTextFile rejects on 404", async () => {
        stub(() => new Response("not found", { status: 404 }));
        await expect(readTextFile("/nope")).rejects.toBeTruthy();
    });
    it("writeTextFile PUTs the body, with append as a query flag", async () => {
        const f = stub(() => new Response(null, { status: 204 }));
        await writeTextFile("/documents/a.pgn", "1. e4 *");
        const [url, init] = f.mock.calls[0] as any;
        expect(url).toBe("/api/fs/write?path=%2Fdocuments%2Fa.pgn");
        expect(init.method).toBe("PUT");
        expect(init.body).toBe("1. e4 *");
        await writeTextFile("/documents/a.pgn", "more", { append: true });
        expect((f.mock.calls[1] as any)[0]).toBe(
            "/api/fs/write?path=%2Fdocuments%2Fa.pgn&append=1",
        );
    });
    it("exists uses stat", async () => {
        stub(
            () =>
                new Response(JSON.stringify({ exists: true, isDirectory: true, isFile: false }), {
                    status: 200,
                }),
        );
        expect(await exists("/db")).toBe(true);
    });
    it("readDir returns DirEntry shape", async () => {
        stub(
            () =>
                new Response(
                    JSON.stringify([
                        { name: "a.db3", isDirectory: false, isFile: true, isSymlink: false },
                    ]),
                    { status: 200 },
                ),
        );
        const entries = await readDir("/db");
        expect(entries[0].name).toBe("a.db3");
        expect(entries[0].isFile).toBe(true);
    });
    it("mkdir and remove hit the right endpoints", async () => {
        const f = stub(() => new Response(null, { status: 204 }));
        await mkdir("/documents/new", { recursive: true });
        await remove("/documents/new", { recursive: true });
        expect((f.mock.calls[0] as any)[0]).toBe("/api/fs/mkdir?path=%2Fdocuments%2Fnew");
        expect((f.mock.calls[1] as any)[1].method).toBe("DELETE");
    });
});
