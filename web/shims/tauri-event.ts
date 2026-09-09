export type UnlistenFn = () => void;
export interface Event<T> {
    event: string;
    id: number;
    payload: T;
}
export type EventCallback<T> = (event: Event<T>) => void;

export const TauriEvent = {
    WINDOW_RESIZED: "tauri://resize",
    WINDOW_MOVED: "tauri://move",
    WINDOW_CLOSE_REQUESTED: "tauri://close-requested",
    WINDOW_DESTROYED: "tauri://destroyed",
    WINDOW_FOCUS: "tauri://focus",
    WINDOW_BLUR: "tauri://blur",
    WINDOW_SCALE_FACTOR_CHANGED: "tauri://scale-change",
    WINDOW_THEME_CHANGED: "tauri://theme-changed",
    WINDOW_CREATED: "tauri://window-created",
    WEBVIEW_CREATED: "tauri://webview-created",
    DRAG_ENTER: "tauri://drag-enter",
    DRAG_OVER: "tauri://drag-over",
    DRAG_DROP: "tauri://drag-drop",
    DRAG_LEAVE: "tauri://drag-leave",
} as const;

const handlers = new Map<string, Set<EventCallback<any>>>();
let socket: WebSocket | null = null;
let backoffMs = 500;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let listenersRegistered = false;
let localId = 1;

function dispatch(ev: Event<unknown>) {
    const set = handlers.get(ev.event);
    if (!set) return;
    for (const cb of Array.from(set)) cb(ev);
}

/**
 * A half-open socket (a sleeping laptop, a NAT or proxy idle-drop on the tailnet)
 * never fires `close`, so the backoff below never runs and engine events stop
 * arriving with no visible sign. Waking and coming back online are the moments
 * we know connectivity changed, so re-check the socket then and reconnect at
 * once rather than waiting out a backoff that may never have been scheduled.
 */
function wake() {
    if (socket && socket.readyState <= 1) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    backoffMs = 500;
    connect();
}

function onVisibilityChange() {
    if (document.visibilityState === "visible") wake();
}

function registerLivenessListeners() {
    if (listenersRegistered || typeof window === "undefined") return;
    listenersRegistered = true;
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", onVisibilityChange);
}

function connect() {
    registerLivenessListeners();
    if (socket && socket.readyState <= 1) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/events`);
    socket = ws;
    ws.onopen = () => {
        // Only the current socket may touch shared state (see onclose).
        if (socket !== ws) return;
        backoffMs = 500;
    };
    ws.onmessage = (e) => {
        try {
            dispatch(JSON.parse(String(e.data)) as Event<unknown>);
        } catch (err) {
            console.warn("bad event frame", err);
        }
    };
    ws.onclose = () => {
        // A server-initiated close leaves this socket in CLOSING (readyState 2) while JS keeps
        // running, so a listen() in that window already opened its successor. Without this guard
        // the stale close would null out the live socket and schedule a second one, and both
        // would dispatch every frame from then on.
        if (socket !== ws) return;
        socket = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10_000);
    };
    ws.onerror = () => ws.close();
}

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    connect();
    return () => {
        handlers.get(event)?.delete(handler);
    };
}

export async function once<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
    let unlisten: UnlistenFn = () => {};
    unlisten = await listen<T>(event, (e) => {
        unlisten();
        handler(e);
    });
    return unlisten;
}

/** Frontend-to-frontend emit; the server never receives these. */
export async function emit(event: string, payload?: unknown): Promise<void> {
    dispatch({ event, id: localId++, payload });
}

export async function emitTo(_target: unknown, event: string, payload?: unknown): Promise<void> {
    return emit(event, payload);
}

/** Tests only. */
export function __test_reset() {
    handlers.clear();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket = null;
    backoffMs = 500;
    if (listenersRegistered && typeof window !== "undefined") {
        window.removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    listenersRegistered = false;
}
