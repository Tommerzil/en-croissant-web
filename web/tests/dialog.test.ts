import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
});

describe("dialog shim", () => {
    it("open() resolves the picked virtual path", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (String(url).startsWith("/api/fs/list")) {
                    return new Response(
                        JSON.stringify([
                            { name: "a.db3", isDirectory: false, isFile: true, isSymlink: false },
                            { name: "sub", isDirectory: true, isFile: false, isSymlink: false },
                        ]),
                        { status: 200 },
                    );
                }
                return new Response(null, { status: 204 });
            }),
        );
        (HTMLDialogElement.prototype as any).showModal ??= function () {
            this.open = true;
        };
        (HTMLDialogElement.prototype as any).close ??= function () {
            this.open = false;
        };

        const { open } = await import("../shims/tauri-dialog");
        const promise = open({
            multiple: false,
            defaultPath: "/db",
            filters: [{ name: "db", extensions: ["db3"] }],
        });
        await new Promise((r) => setTimeout(r, 0));
        const row = document.querySelector<HTMLButtonElement>('[data-entry="a.db3"]');
        expect(row).not.toBeNull();
        row!.click();
        await expect(promise).resolves.toBe("/db/a.db3");
    });

    it("save() returns startDir/defaultName typed by the user", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("[]", { status: 200 })),
        );
        (HTMLDialogElement.prototype as any).showModal ??= function () {
            this.open = true;
        };
        (HTMLDialogElement.prototype as any).close ??= function () {
            this.open = false;
        };
        const { save } = await import("../shims/tauri-dialog");
        const promise = save({ defaultPath: "/documents/export.pgn" });
        await new Promise((r) => setTimeout(r, 0));
        const input = document.querySelector<HTMLInputElement>('[data-role="filename"]')!;
        expect(input.value).toBe("export.pgn");
        input.value = "mine.pgn";
        document.querySelector<HTMLButtonElement>('[data-role="confirm"]')!.click();
        await expect(promise).resolves.toBe("/documents/mine.pgn");
    });

    it("open({directory:true}) lists no files and resolves the current directory", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (String(url).startsWith("/api/fs/list")) {
                    return new Response(
                        JSON.stringify([
                            { name: "a.db3", isDirectory: false, isFile: true, isSymlink: false },
                            { name: "sub", isDirectory: true, isFile: false, isSymlink: false },
                        ]),
                        { status: 200 },
                    );
                }
                return new Response(
                    JSON.stringify({
                        exists: true,
                        isDirectory: true,
                        isFile: false,
                        size: 0,
                        modifiedMs: 0,
                    }),
                    { status: 200 },
                );
            }),
        );
        (HTMLDialogElement.prototype as any).showModal ??= function () {
            this.open = true;
        };
        (HTMLDialogElement.prototype as any).close ??= function () {
            this.open = false;
        };

        const { open } = await import("../shims/tauri-dialog");
        const promise = open({ multiple: false, directory: true, defaultPath: "/db" });
        await new Promise((r) => setTimeout(r, 0));

        expect(document.querySelector('[data-entry="a.db3"]')).toBeNull();
        expect(document.querySelector('[data-entry="sub"]')).not.toBeNull();
        expect(document.querySelector<HTMLElement>('[data-role="filename"]')!.hidden).toBe(true);
        expect(document.querySelector<HTMLElement>('[data-role="upload-label"]')!.hidden).toBe(
            true,
        );

        document.querySelector<HTMLButtonElement>('[data-role="confirm"]')!.click();
        await expect(promise).resolves.toBe("/db");
    });

    it("save() proposes a name using the first filter extension", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (String(url).startsWith("/api/fs/list")) {
                    return new Response("[]", { status: 200 });
                }
                return new Response(
                    JSON.stringify({
                        exists: true,
                        isDirectory: true,
                        isFile: false,
                        size: 0,
                        modifiedMs: 0,
                    }),
                    { status: 200 },
                );
            }),
        );
        (HTMLDialogElement.prototype as any).showModal ??= function () {
            this.open = true;
        };
        (HTMLDialogElement.prototype as any).close ??= function () {
            this.open = false;
        };

        const { save } = await import("../shims/tauri-dialog");
        const promise = save({
            defaultPath: "/documents",
            filters: [{ name: "png", extensions: ["png"] }],
        });
        await new Promise((r) => setTimeout(r, 0));

        const input = document.querySelector<HTMLInputElement>('[data-role="filename"]')!;
        expect(input.value).toBe("untitled.png");

        document.querySelector<HTMLButtonElement>('[data-role="confirm"]')!.click();
        await expect(promise).resolves.toBe("/documents/untitled.png");
    });

    it("ask maps to confirm", async () => {
        vi.stubGlobal(
            "confirm",
            vi.fn(() => true),
        );
        const { ask } = await import("../shims/tauri-dialog");
        expect(await ask("Sure?")).toBe(true);
    });
});
