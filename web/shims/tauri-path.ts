export enum BaseDirectory {
    Audio = 1,
    Cache,
    Config,
    Data,
    LocalData,
    Document,
    Download,
    Picture,
    Public,
    Video,
    Resource,
    Temp,
    AppConfig,
    AppData,
    AppLocalData,
    AppCache,
    AppLog,
    Desktop,
    Executable,
    Font,
    Home,
    Runtime,
    Template,
}

export function normalize(path: string): string {
    const out: string[] = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return `/${out.join("/")}`; // everything is rooted at "/"
}

export async function resolve(...parts: string[]): Promise<string> {
    return normalize(parts.join("/"));
}
export const join = resolve;

export async function basename(path: string, ext?: string): Promise<string> {
    const base = normalize(path).split("/").pop() ?? "";
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

export async function dirname(path: string): Promise<string> {
    const n = normalize(path);
    const i = n.lastIndexOf("/");
    return i <= 0 ? "/" : n.slice(0, i);
}

export function sep(): string {
    return "/";
}

export async function appDataDir(): Promise<string> {
    return "/";
}
export async function appConfigDir(): Promise<string> {
    return "/config";
}
export async function appLocalDataDir(): Promise<string> {
    return "/";
}
export async function appCacheDir(): Promise<string> {
    return "/cache";
}
export async function appLogDir(): Promise<string> {
    return "/logs";
}
export async function documentDir(): Promise<string> {
    return "/documents";
}
export async function homeDir(): Promise<string> {
    return "/";
}
export async function tempDir(): Promise<string> {
    return "/tmp";
}
export async function downloadDir(): Promise<string> {
    return "/downloads";
}
export async function resourceDir(): Promise<string> {
    return "/resources";
}

export async function resolveResource(resourcePath: string): Promise<string> {
    return `/resources/${resourcePath.replace(/^\/+/, "")}`;
}
