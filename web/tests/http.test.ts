import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch as httpFetch } from "../shims/tauri-http";

afterEach(() => vi.unstubAllGlobals());

describe("http shim", () => {
    it("proxies allowlisted GETs", async () => {
        const f = vi.fn(async () => new Response("{}", { status: 200 }));
        vi.stubGlobal("fetch", f);
        await httpFetch("https://api.chess.com/pub/player/examplechessuser/games/archives", {
            method: "GET",
        });
        expect((f.mock.calls[0] as any)[0]).toBe(
            "/api/proxy?url=" +
                encodeURIComponent("https://api.chess.com/pub/player/examplechessuser/games/archives"),
        );
    });
    it("proxies chessdb cloud evaluation GETs", async () => {
        const f = vi.fn(async () => new Response("{}", { status: 200 }));
        vi.stubGlobal("fetch", f);
        const url =
            "https://www.chessdb.cn/cdb.php?action=queryall&board=rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR+w+KQkq+-+0+1&json=1";
        await httpFetch(url);
        expect((f.mock.calls[0] as any)[0]).toBe("/api/proxy?url=" + encodeURIComponent(url));
    });
    // Every Lichess URL src/utils/lichess/api.tsx fetches. These hostnames are
    // `.org`; the allowlist previously said `.ovh`, so all of these fell through
    // to a native fetch and failed CORS.
    it.each([
        "https://lichess.org/api/account",
        "https://lichess.org/api/cloud-eval?fen=x&multiPv=1",
        "https://explorer.lichess.org/masters?fen=x&moves=12",
        "https://explorer.lichess.org/lichess?fen=x&speeds=blitz",
        "https://explorer.lichess.org/player?fen=x&player=y&color=white",
        "https://tablebase.lichess.org/standard?fen=x",
    ])("proxies the Lichess GET %s", async (url) => {
        const f = vi.fn(async () => new Response("{}", { status: 200 }));
        vi.stubGlobal("fetch", f);
        await httpFetch(url);
        expect((f.mock.calls[0] as any)[0]).toBe("/api/proxy?url=" + encodeURIComponent(url));
    });
    it("passes other hosts and methods straight through", async () => {
        const f = vi.fn(async () => new Response("{}", { status: 200 }));
        vi.stubGlobal("fetch", f);
        await httpFetch("https://example.com/x");
        await httpFetch("https://lichess.org/api/account", { method: "POST" });
        // The allowlist is exact: the bare apex is not the same host as www.
        await httpFetch("https://chessdb.cn/cdb.php");
        // The legacy `.ovh` Lichess aliases are not what the app calls, so they
        // are not proxied either -- a regression to them would show up here as
        // a native fetch rather than silently going out and failing CORS.
        await httpFetch("https://explorer.lichess.ovh/masters?fen=x");
        await httpFetch("https://tablebase.lichess.ovh/standard?fen=x");
        expect((f.mock.calls[0] as any)[0]).toBe("https://example.com/x");
        expect((f.mock.calls[1] as any)[0]).toBe("https://lichess.org/api/account");
        expect((f.mock.calls[2] as any)[0]).toBe("https://chessdb.cn/cdb.php");
        expect((f.mock.calls[3] as any)[0]).toBe("https://explorer.lichess.ovh/masters?fen=x");
        expect((f.mock.calls[4] as any)[0]).toBe("https://tablebase.lichess.ovh/standard?fen=x");
    });
});
