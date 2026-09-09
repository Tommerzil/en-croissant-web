import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("serverStorage", () => {
    let calls: { url: string; method: string; body?: string }[];

    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        calls = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
            if (String(url) === "/api/kv" && !init?.method) {
                return new Response(JSON.stringify({ "piece-set": "\"alpha\"" }), { status: 200 });
            }
            return new Response(null, { status: 204 });
        }));
        vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("preloads keys and reads synchronously", async () => {
        const { preloadStorage, serverStorage } = await import("../storage");
        await preloadStorage();
        expect(serverStorage.getItem("piece-set")).toBe("\"alpha\"");
        expect(serverStorage.getItem("missing")).toBeNull();
        expect(serverStorage.length).toBe(1);
    });

    it("debounces writes per key and PUTs the raw string", async () => {
        const { preloadStorage, serverStorage } = await import("../storage");
        await preloadStorage();
        serverStorage.setItem("tabs", "[1]");
        serverStorage.setItem("tabs", "[1,2]");
        expect(serverStorage.getItem("tabs")).toBe("[1,2]");
        expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(350);
        const puts = calls.filter((c) => c.method === "PUT");
        expect(puts).toHaveLength(1);
        expect(puts[0].url).toBe("/api/kv/tabs");
        expect(puts[0].body).toBe("[1,2]");
    });

    it("removeItem deletes on the server", async () => {
        const { preloadStorage, serverStorage } = await import("../storage");
        await preloadStorage();
        serverStorage.removeItem("piece-set");
        expect(serverStorage.getItem("piece-set")).toBeNull();
        await vi.advanceTimersByTimeAsync(350);
        expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/kv/piece-set")).toBe(true);
    });

    it("seedDefaults only fills absent keys", async () => {
        const { preloadStorage, seedDefaults, serverStorage } = await import("../storage");
        await preloadStorage();
        seedDefaults({ "piece-set": "\"beta\"", "native-bar": "true" });
        expect(serverStorage.getItem("piece-set")).toBe("\"alpha\"");
        expect(serverStorage.getItem("native-bar")).toBe("true");
    });

    it("installGlobalStorage makes window storage the server store", async () => {
        const { preloadStorage, installGlobalStorage, serverStorage } = await import("../storage");
        await preloadStorage();
        installGlobalStorage();
        expect(window.localStorage).toBe(serverStorage);
        expect(window.sessionStorage).toBe(serverStorage);
        window.sessionStorage.setItem("tab-content", "{}");
        expect(serverStorage.getItem("tab-content")).toBe("{}");
    });

    it("flushNow sends pending writes with sendBeacon", async () => {
        const { preloadStorage, serverStorage, flushNow } = await import("../storage");
        await preloadStorage();
        serverStorage.setItem("x", "1");
        flushNow();
        expect((navigator.sendBeacon as any).mock.calls[0][0]).toBe("/api/kv/x");
    });
});

describe("jotai/utils shim", () => {
    it("atomWithStorage reads from serverStorage synchronously", async () => {
        vi.resetModules();
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ "font-size": "120" }), { status: 200 })));
        const { preloadStorage } = await import("../storage");
        await preloadStorage();
        const { atomWithStorage } = await import("../shims/jotai-utils");
        const { createStore } = await import("jotai/vanilla");
        const a = atomWithStorage<number>("font-size", 100);
        expect(createStore().get(a)).toBe(120);
        vi.unstubAllGlobals();
    });
});
