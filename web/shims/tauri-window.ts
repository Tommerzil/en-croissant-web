import { listen, once, type EventCallback, type UnlistenFn } from "./tauri-event";

/** A window object whose every method is a resolved no-op, except event listening. */
function makeWindow() {
    const base = {
        label: "main",
        listen: <T>(event: string, cb: EventCallback<T>): Promise<UnlistenFn> => listen(event, cb),
        once: <T>(event: string, cb: EventCallback<T>): Promise<UnlistenFn> => once(event, cb),
        onCloseRequested:
            async (_cb: unknown): Promise<UnlistenFn> =>
            () => {},
        onDragDropEvent:
            async (_cb: unknown): Promise<UnlistenFn> =>
            () => {},
        onResized:
            async (_cb: unknown): Promise<UnlistenFn> =>
            () => {},
        onMoved:
            async (_cb: unknown): Promise<UnlistenFn> =>
            () => {},
        onFocusChanged:
            async (_cb: unknown): Promise<UnlistenFn> =>
            () => {},
        onThemeChanged:
            async (_cb: unknown): Promise<UnlistenFn> =>
            () => {},
        isMaximized: async () => false,
        isFullscreen: async () => false,
        setTitle: async (t: string) => {
            document.title = t;
        },
    };
    return new Proxy(base as Record<string, unknown>, {
        get(target, prop: string) {
            if (prop in target) return target[prop];
            return async () => undefined;
        },
    });
}

const current = makeWindow();
export function getCurrentWindow() {
    return current;
}
export function getAllWindows() {
    return Promise.resolve([current]);
}
export class Window {
    static getCurrent() {
        return current;
    }
}
