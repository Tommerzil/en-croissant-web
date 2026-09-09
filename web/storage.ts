const DEBOUNCE_MS = 300;

class ServerStorage implements Storage {
    private cache = new Map<string, string>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private pending = new Map<string, string | null>(); // null = delete

    get length(): number {
        return this.cache.size;
    }

    key(index: number): string | null {
        return Array.from(this.cache.keys())[index] ?? null;
    }

    getItem(key: string): string | null {
        return this.cache.has(key) ? (this.cache.get(key) as string) : null;
    }

    setItem(key: string, value: string): void {
        const v = String(value);
        this.cache.set(key, v);
        this.schedule(key, v);
    }

    removeItem(key: string): void {
        this.cache.delete(key);
        this.schedule(key, null);
    }

    clear(): void {
        for (const k of Array.from(this.cache.keys())) this.removeItem(k);
    }

    /** Called once at boot with the server's full key set. */
    load(entries: Record<string, string>): void {
        this.cache = new Map(Object.entries(entries));
    }

    /** Fill in defaults for keys the server has never seen. */
    seed(defaults: Record<string, string>): void {
        for (const [k, v] of Object.entries(defaults)) {
            if (!this.cache.has(k)) this.setItem(k, v);
        }
    }

    private schedule(key: string, value: string | null): void {
        this.pending.set(key, value);
        const t = this.timers.get(key);
        if (t) clearTimeout(t);
        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                void this.push(key);
            }, DEBOUNCE_MS),
        );
    }

    private async push(key: string): Promise<void> {
        if (!this.pending.has(key)) return;
        const value = this.pending.get(key) as string | null;
        this.pending.delete(key);
        const url = `/api/kv/${encodeURIComponent(key)}`;
        try {
            // `fetch` only rejects on network failure, so a 413 or 500 has to be
            // turned into a throw or the write would be dropped silently.
            const res =
                value === null
                    ? await fetch(url, { method: "DELETE" })
                    : await fetch(url, {
                          method: "PUT",
                          body: value,
                          headers: { "content-type": "text/plain" },
                      });
            if (!res.ok) throw new Error(`settings write failed: ${res.status}`);
        } catch (e) {
            console.warn("settings write failed, will retry on next change", key, e);
            // Re-queue only if this write is still the current one. A newer value may
            // have been queued (or already stored) while this request was in flight;
            // re-queueing then would push stale data over it.
            const superseded =
                this.pending.has(key) ||
                (value === null ? this.cache.has(key) : this.cache.get(key) !== value);
            if (!superseded) this.pending.set(key, value);
        }
    }

    /** Synchronous best-effort flush for pagehide. */
    flush(): void {
        // Snapshot: entries are removed from `pending` as they are accepted.
        for (const [key, value] of Array.from(this.pending)) {
            const url = `/api/kv/${encodeURIComponent(key)}`;
            // sendBeacon cannot DELETE; write an empty marker the server treats as absent next load.
            // It returns false past the browser's beacon queue cap — leave those entries pending
            // with their timers intact so the normal fetch path still gets a chance at them.
            if (!navigator.sendBeacon(url, value === null ? "" : value)) continue;
            this.pending.delete(key);
            const t = this.timers.get(key);
            if (t) clearTimeout(t);
            this.timers.delete(key);
        }
    }
}

export const serverStorage = new ServerStorage();

export async function preloadStorage(): Promise<void> {
    const res = await fetch("/api/kv");
    if (!res.ok) throw new Error(`settings preload failed: ${res.status}`);
    const entries = (await res.json()) as Record<string, string>;
    // An empty string is the beacon's stand-in for "deleted".
    for (const k of Object.keys(entries)) if (entries[k] === "") delete entries[k];
    serverStorage.load(entries);
    if (typeof window !== "undefined") {
        window.addEventListener("pagehide", () => serverStorage.flush());
    }
}

export function seedDefaults(defaults: Record<string, string>): void {
    serverStorage.seed(defaults);
}

/**
 * Make every `localStorage` / `sessionStorage` access in the app hit the server store.
 * Upstream reads both directly in several modules (directories, tab contents, keybinds,
 * practice decks, i18n); routing them here is what makes state follow between devices.
 */
export function installGlobalStorage(): void {
    for (const name of ["localStorage", "sessionStorage"] as const) {
        Object.defineProperty(window, name, {
            value: serverStorage,
            configurable: true,
            writable: false,
        });
        if ((window as any)[name] !== serverStorage) {
            throw new Error(`browser refused to override window.${name}`);
        }
    }
}

export function flushNow(): void {
    serverStorage.flush();
}
