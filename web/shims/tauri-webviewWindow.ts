import { getCurrentWindow } from "./tauri-window";
export function getCurrentWebviewWindow() {
    return getCurrentWindow();
}
export class WebviewWindow {
    static getCurrent() {
        return getCurrentWindow();
    }
    static getByLabel(_label: string) {
        return Promise.resolve(getCurrentWindow());
    }
}
