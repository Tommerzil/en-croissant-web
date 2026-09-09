import { pickPath } from "../picker";
import { stat } from "./tauri-fs";
import { basename, dirname, normalize } from "./tauri-path";

interface Filter {
    name: string;
    extensions: string[];
}
interface OpenOptions {
    title?: string;
    filters?: Filter[];
    defaultPath?: string;
    multiple?: boolean;
    directory?: boolean;
    recursive?: boolean;
}
interface SaveOptions {
    title?: string;
    filters?: Filter[];
    defaultPath?: string;
}

/** Split a defaultPath into (directory, filename) by asking the server what it is. */
async function splitDefault(
    path: string | undefined,
    fallbackDir: string,
    mode: "open" | "save",
): Promise<{ dir: string; name: string }> {
    if (!path) return { dir: fallbackDir, name: "" };
    const p = normalize(path);
    try {
        const st = await stat(p);
        if (st.isDirectory) return { dir: p, name: "" };
        return { dir: await dirname(p), name: await basename(p) };
    } catch {
        // The path does not exist yet (stat rejects), so guess from the caller's intent:
        // "open" always browses a directory, and a save target without an extension is one
        // too. Anything else is a file to be created inside its parent.
        const name = await basename(p);
        if (mode === "open" || !name.includes(".")) return { dir: p, name: "" };
        return { dir: await dirname(p), name };
    }
}

export async function open(opts: OpenOptions = {}): Promise<string | string[] | null> {
    const exts = opts.filters?.flatMap((f) => f.extensions) ?? [];
    const { dir } = await splitDefault(opts.defaultPath, "/", "open");
    return pickPath({
        mode: "open",
        multiple: !!opts.multiple,
        directory: !!opts.directory,
        startDir: dir,
        extensions: exts,
    });
}

export async function save(opts: SaveOptions = {}): Promise<string | null> {
    const exts = opts.filters?.flatMap((f) => f.extensions) ?? [];
    const { dir, name } = await splitDefault(opts.defaultPath, "/documents", "save");
    const out = await pickPath({
        mode: "save",
        startDir: dir,
        extensions: exts,
        // No name from defaultPath: propose one using the caller's own first filter extension
        // rather than a hard-coded ".pgn" (BoardControls exports a PNG into a directory).
        defaultName: name || (exts[0] ? `untitled.${exts[0]}` : "untitled"),
    });
    return typeof out === "string" ? out : null;
}

export async function ask(message: string, _opts?: unknown): Promise<boolean> {
    return window.confirm(message);
}

export async function confirm(message: string, _opts?: unknown): Promise<boolean> {
    return window.confirm(message);
}

export async function message(text: string, _opts?: unknown): Promise<void> {
    window.alert(text);
}
