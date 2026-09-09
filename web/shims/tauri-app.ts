declare const __APP_VERSION__: string;
export async function getVersion(): Promise<string> {
    return `${__APP_VERSION__}-web`;
}
export async function getTauriVersion(): Promise<string> {
    return "web";
}
export async function getName(): Promise<string> {
    return "En Croissant";
}
