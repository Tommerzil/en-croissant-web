import { apiJson, fsUrl } from "../api";
import { BaseDirectory, normalize } from "./tauri-path";

export { BaseDirectory };

export interface DirEntry {
    name: string;
    isDirectory: boolean;
    isFile: boolean;
    isSymlink: boolean;
}

interface Opts {
    baseDir?: BaseDirectory;
    recursive?: boolean;
    append?: boolean;
    create?: boolean;
}

// baseDir is ignored: every base directory is a subtree of the same virtual root.
const p = (path: string | URL) => normalize(String(path));

async function check(res: Response): Promise<Response> {
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res;
}

export async function exists(path: string | URL, _opts?: Opts): Promise<boolean> {
    const st = await apiJson<{ exists: boolean }>(fsUrl("stat", p(path)));
    return st.exists;
}

export async function stat(path: string | URL, _opts?: Opts) {
    const st = await apiJson<{
        exists: boolean;
        isDirectory: boolean;
        isFile: boolean;
        size: number;
        modifiedMs: number;
    }>(fsUrl("stat", p(path)));
    if (!st.exists) throw new Error(`not found: ${p(path)}`);
    return {
        isDirectory: st.isDirectory,
        isFile: st.isFile,
        isSymlink: false,
        size: st.size,
        mtime: new Date(st.modifiedMs),
    };
}

export async function mkdir(path: string | URL, _opts?: Opts): Promise<void> {
    await check(await fetch(fsUrl("mkdir", p(path)), { method: "POST" }));
}

export async function readDir(path: string | URL, _opts?: Opts): Promise<DirEntry[]> {
    return apiJson<DirEntry[]>(fsUrl("list", p(path)));
}

export async function readTextFile(path: string | URL, _opts?: Opts): Promise<string> {
    return (await check(await fetch(fsUrl("read", p(path))))).text();
}

export async function readFile(path: string | URL, _opts?: Opts): Promise<Uint8Array> {
    return new Uint8Array(await (await check(await fetch(fsUrl("read", p(path))))).arrayBuffer());
}

export async function writeTextFile(
    path: string | URL,
    contents: string,
    opts?: Opts,
): Promise<void> {
    // append is a server-side flag so the month-by-month chess.com import stays linear.
    const url = fsUrl("write", p(path)) + (opts?.append ? "&append=1" : "");
    await check(
        await fetch(url, {
            method: "PUT",
            body: contents,
            headers: { "content-type": "text/plain" },
        }),
    );
}

// Uint8Array<ArrayBuffer> and not the default Uint8Array<ArrayBufferLike>: a
// SharedArrayBuffer-backed view is not a valid fetch body.
export async function writeFile(
    path: string | URL,
    data: Uint8Array<ArrayBuffer>,
    _opts?: Opts,
): Promise<void> {
    await check(
        await fetch(fsUrl("write", p(path)), {
            method: "PUT",
            body: data,
            headers: { "content-type": "application/octet-stream" },
        }),
    );
}

export async function remove(path: string | URL, _opts?: Opts): Promise<void> {
    await check(await fetch(fsUrl("", p(path)), { method: "DELETE" }));
}

export async function rename(from: string | URL, to: string | URL, _opts?: unknown): Promise<void> {
    await check(
        await fetch("/api/fs/rename", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ from: p(from), to: p(to) }),
        }),
    );
}

export async function copyFile(
    from: string | URL,
    to: string | URL,
    _opts?: unknown,
): Promise<void> {
    await check(
        await fetch("/api/fs/copy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ from: p(from), to: p(to) }),
        }),
    );
}
