// Must stay in step with ALLOWED_HOSTS in server/src/proxy.rs: a host missing
// here falls through to a native fetch instead of the proxy. The Lichess
// opening explorer and tablebase are `.org` (src/utils/lichess/api.tsx, and
// Lichess's own OpenAPI spec); the legacy `.ovh` aliases are not used.
const PROXIED_HOSTS = new Set([
    "api.chess.com",
    "www.chess.com",
    "lichess.org",
    "explorer.lichess.org",
    "tablebase.lichess.org",
    "www.chessdb.cn",
]);

export async function fetch(
    input: string | URL | Request,
    init?: RequestInit & { connectTimeout?: number },
): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    try {
        const u = new URL(url);
        if (u.protocol === "https:" && PROXIED_HOSTS.has(u.host) && method === "GET") {
            const { connectTimeout: _ct, ...rest } = init ?? {};
            return globalThis.fetch(`/api/proxy?url=${encodeURIComponent(url)}`, {
                ...rest,
                method: "GET",
            });
        }
    } catch {
        // relative URL: fall through to native fetch
    }
    const { connectTimeout: _ct, ...rest } = init ?? {};
    return globalThis.fetch(input, rest);
}
