export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, init);
    if (!res.ok) {
        const text = await res.text();
        let msg: unknown = text;
        try {
            msg = JSON.parse(text);
        } catch {
            // plain text error
        }
        throw msg;
    }
    return (await res.json()) as T;
}

export async function apiText(path: string, init?: RequestInit): Promise<string> {
    const res = await fetch(path, init);
    if (!res.ok) throw await res.text();
    return res.text();
}

export function fsUrl(
    op: "list" | "stat" | "read" | "download" | "write" | "mkdir" | "",
    path: string,
): string {
    const base = op === "" ? "/api/fs" : `/api/fs/${op}`;
    return `${base}?path=${encodeURIComponent(path)}`;
}
