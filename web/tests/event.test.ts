import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
    static instances: FakeSocket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    constructor(public url: string) {
        FakeSocket.instances.push(this);
    }
    open() {
        this.readyState = 1;
        this.onopen?.();
    }
    push(obj: unknown) {
        this.onmessage?.({ data: JSON.stringify(obj) });
    }
    close() {
        this.readyState = 3;
        this.onclose?.();
    }
    send() {}
}

describe("event shim", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeSocket.instances = [];
        vi.stubGlobal("WebSocket", FakeSocket);
    });
    afterEach(async () => {
        const m = await import("../shims/tauri-event");
        m.__test_reset();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("connects to <scheme>://<host>/ws/events and dispatches by name", async () => {
        const { listen } = await import("../shims/tauri-event");
        const seen: unknown[] = [];
        const unlisten = await listen<{ n: number }>("best-moves-payload", (e) => seen.push(e));
        const sock = FakeSocket.instances[0];
        // jsdom's default location is http://localhost:3000, so the shim picks ws:.
        expect(sock.url).toBe("ws://localhost:3000/ws/events");
        sock.open();
        sock.push({ event: "best-moves-payload", id: 4, payload: { n: 1 } });
        sock.push({ event: "other", id: 5, payload: {} });
        expect(seen).toEqual([{ event: "best-moves-payload", id: 4, payload: { n: 1 } }]);
        unlisten();
        sock.push({ event: "best-moves-payload", id: 6, payload: { n: 2 } });
        expect(seen).toHaveLength(1);
    });

    it("once fires a single time", async () => {
        const { once } = await import("../shims/tauri-event");
        const cb = vi.fn();
        await once("progress-event", cb);
        const sock = FakeSocket.instances[0];
        sock.open();
        sock.push({ event: "progress-event", id: 1, payload: 1 });
        sock.push({ event: "progress-event", id: 2, payload: 2 });
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it("reconnects with backoff after close", async () => {
        const { listen } = await import("../shims/tauri-event");
        await listen("x", () => {});
        FakeSocket.instances[0].open();
        FakeSocket.instances[0].close();
        expect(FakeSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(600);
        expect(FakeSocket.instances).toHaveLength(2);
    });

    it("local emit reaches local listeners", async () => {
        const { listen, emit } = await import("../shims/tauri-event");
        const cb = vi.fn();
        await listen("local", cb);
        await emit("local", 42);
        expect(cb.mock.calls[0][0].payload).toBe(42);
    });
});
