import { afterEach, describe, expect, it, vi } from "vitest";
import { convertFileSrc, invoke } from "../shims/tauri-core";

afterEach(() => vi.unstubAllGlobals());

describe("invoke", () => {
    it("posts camelCase args and returns json", async () => {
        const fetchMock = vi.fn(
            async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const out = await invoke<{ ok: number }>("get_games", {
            file: "/db/a.db3",
            query: { limit: 1 },
        });
        expect(out).toEqual({ ok: 1 });
        const [url, init] = fetchMock.mock.calls[0] as any;
        expect(url).toBe("/api/cmd/get_games");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body)).toEqual({ file: "/db/a.db3", query: { limit: 1 } });
    });

    it("throws the raw server string (not an Error) on 500", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify("No opening found"), { status: 500 })),
        );
        await expect(invoke("x")).rejects.toBe("No opening found");
    });

    it("sends {} when no args", async () => {
        const fetchMock = vi.fn(async () => new Response("null", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        await invoke("clear_games");
        expect((fetchMock.mock.calls[0] as any)[1].body).toBe("{}");
    });

    it("converts a network failure into a thrown string, not an Error", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        );
        await expect(invoke("x")).rejects.toBeTypeOf("string");
        await expect(invoke("x")).rejects.not.toBeInstanceOf(Error);
        await expect(invoke("x")).rejects.toMatch(/Failed to fetch/);
    });

    it("throws a string for a plain-text axum rejection (415)", async () => {
        const body = "Expected request with `Content-Type: application/json`";
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { status: 415 })),
        );
        await expect(invoke("x")).rejects.toBe(body);
    });
});

describe("convertFileSrc", () => {
    it("keeps resource urls and turns data paths into fs reads", () => {
        expect(convertFileSrc("/resources/sound/a.mp3")).toBe("/resources/sound/a.mp3");
        expect(convertFileSrc("/db/board.png")).toBe("/api/fs/read?path=%2Fdb%2Fboard.png");
    });
});
