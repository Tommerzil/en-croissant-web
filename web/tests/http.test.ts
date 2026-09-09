import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch as httpFetch } from "../shims/tauri-http";

afterEach(() => vi.unstubAllGlobals());

describe("http shim", () => {
    it("proxies allowlisted GETs", async () => {
        const f = vi.fn(async () => new Response("{}", { status: 200 }));
        vi.stubGlobal("fetch", f);
        await httpFetch("https://api.chess.com/pub/player/tommerzil00/games/archives", {
            method: "GET",
        });
        expect((f.mock.calls[0] as any)[0]).toBe(
            "/api/proxy?url=" +
                encodeURIComponent("https://api.chess.com/pub/player/tommerzil00/games/archives"),
        );
    });
    it("passes other hosts and methods straight through", async () => {
        const f = vi.fn(async () => new Response("{}", { status: 200 }));
        vi.stubGlobal("fetch", f);
        await httpFetch("https://example.com/x");
        await httpFetch("https://lichess.org/api/account", { method: "POST" });
        expect((f.mock.calls[0] as any)[0]).toBe("https://example.com/x");
        expect((f.mock.calls[1] as any)[0]).toBe("https://lichess.org/api/account");
    });
});
