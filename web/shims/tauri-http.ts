const PROXIED_HOSTS = new Set([
    "api.chess.com",
    "www.chess.com",
    "lichess.org",
    "explorer.lichess.ovh",
    "tablebase.lichess.ovh",
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
