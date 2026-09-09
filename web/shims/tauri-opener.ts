export async function openPath(path: string, _openWith?: string): Promise<void> {
    window.open(`/api/fs/download?path=${encodeURIComponent(path)}`, "_blank");
}
export async function openUrl(url: string | URL, _openWith?: string): Promise<void> {
    window.open(String(url), "_blank", "noopener");
}
export async function revealItemInDir(path: string): Promise<void> {
    return openPath(path);
}
