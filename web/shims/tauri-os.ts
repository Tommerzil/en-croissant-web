export type Platform =
    | "linux"
    | "macos"
    | "windows"
    | "ios"
    | "android"
    | "freebsd"
    | "dragonfly"
    | "netbsd"
    | "openbsd"
    | "solaris";
/** "freebsd" on purpose: upstream's sound module routes "linux" through a local sound server
 *  that cannot exist on web, and every other platform() check only tests for macos/windows. */
export function platform(): Platform {
    return "freebsd";
}
export function type(): string {
    return "linux";
}
export function arch(): string {
    return "x86_64";
}
export function version(): string {
    return "web";
}
export function family(): string {
    return "unix";
}
export function locale(): Promise<string | null> {
    return Promise.resolve(navigator.language ?? null);
}
