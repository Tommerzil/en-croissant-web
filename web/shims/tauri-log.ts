export async function attachConsole(): Promise<() => void> {
    return () => {};
}
export async function trace(m: string): Promise<void> {
    console.debug(m);
}
export async function debug(m: string): Promise<void> {
    console.debug(m);
}
export async function info(m: string): Promise<void> {
    console.info(m);
}
export async function warn(m: string): Promise<void> {
    console.warn(m);
}
export async function error(m: string): Promise<void> {
    console.error(m);
}
