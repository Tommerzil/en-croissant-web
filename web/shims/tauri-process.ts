export async function exit(_code?: number): Promise<void> {
    window.close();
}
export async function relaunch(): Promise<void> {
    window.location.reload();
}
