import { apiJson } from "../api";

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
        return await apiJson<T>(`/api/cmd/${cmd}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(args),
        });
    } catch (e) {
        // The generated bindings rethrow anything that is an `Error` instead of
        // turning it into an in-app `{status:"error"}` result, so a failed fetch
        // (offline, server down) or a malformed body would escape as an uncaught
        // exception. Non-2xx responses already arrive here as plain values and
        // pass through untouched.
        if (e instanceof Error) throw `request failed: ${String(e)}`;
        throw e;
    }
}

/** No surviving command streams through a Channel; kept so generated bindings type-check. */
export class Channel<T = unknown> {
    onmessage: (response: T) => void = () => {};
}

export function convertFileSrc(filePath: string, _protocol = "asset"): string {
    if (filePath.startsWith("/resources/")) return filePath;
    return `/api/fs/read?path=${encodeURIComponent(filePath)}`;
}

export function isTauri(): boolean {
    return false;
}
