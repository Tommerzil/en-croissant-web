class Noop {
    static async new(_opts?: unknown): Promise<Noop> {
        return new Noop();
    }
    async setAsAppMenu(): Promise<void> {}
    async setAsWindowMenu(): Promise<void> {}
    async popup(): Promise<void> {}
    async append(): Promise<void> {}
}
export class Menu extends Noop {}
export class Submenu extends Noop {}
export class MenuItem extends Noop {}
export class PredefinedMenuItem extends Noop {}
export class CheckMenuItem extends Noop {}
