import { basename, dirname, normalize } from "./shims/tauri-path";
import { readDir, writeFile } from "./shims/tauri-fs";

export interface PickOptions {
    mode: "open" | "save";
    multiple?: boolean;
    directory?: boolean;
    startDir?: string;
    extensions?: string[];
    defaultName?: string;
}

const STYLE = `
dialog.ec-picker { border: 1px solid #555; border-radius: 8px; padding: 0; width: min(560px, 92vw); font: 14px system-ui, sans-serif; color: inherit; background: Canvas; }
dialog.ec-picker::backdrop { background: rgba(0,0,0,.5); }
.ec-picker header { display:flex; gap:.5rem; align-items:center; padding:.6rem .8rem; border-bottom:1px solid #444; }
.ec-picker header code { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ec-picker ul { list-style:none; margin:0; padding:0; max-height:50vh; overflow:auto; }
.ec-picker li button { width:100%; text-align:left; padding:.45rem .8rem; background:none; border:0; color:inherit; cursor:pointer; }
.ec-picker li button:hover { background: rgba(127,127,127,.2); }
.ec-picker footer { display:flex; gap:.5rem; padding:.6rem .8rem; border-top:1px solid #444; align-items:center; }
.ec-picker footer input { flex:1; }
`;

function ensureStyle() {
    if (!document.getElementById("ec-picker-style")) {
        const s = document.createElement("style");
        s.id = "ec-picker-style";
        s.textContent = STYLE;
        document.head.appendChild(s);
    }
}

export function pickPath(opts: PickOptions): Promise<string | string[] | null> {
    ensureStyle();
    return new Promise((resolvePromise) => {
        let cwd = normalize(opts.startDir ?? "/");
        const selected = new Set<string>();
        const dlg = document.createElement("dialog");
        dlg.className = "ec-picker";
        dlg.innerHTML = `
          <header><button type="button" data-role="up">↑</button><code data-role="cwd"></code></header>
          <ul data-role="list"></ul>
          <footer>
            <input data-role="filename" placeholder="filename" ${opts.mode === "open" && !opts.directory ? "hidden" : ""}>
            <label ${opts.mode === "save" ? "hidden" : ""}><input type="file" data-role="upload" hidden ${opts.multiple ? "multiple" : ""}><button type="button" data-role="upload-btn">Upload…</button></label>
            <button type="button" data-role="cancel">Cancel</button>
            <button type="button" data-role="confirm">OK</button>
          </footer>`;
        document.body.appendChild(dlg);

        const $ = <T extends HTMLElement>(role: string) =>
            dlg.querySelector<T>(`[data-role="${role}"]`)!;
        const filename = $<HTMLInputElement>("filename");
        if (opts.defaultName) filename.value = opts.defaultName;

        const finish = (value: string | string[] | null) => {
            dlg.close();
            dlg.remove();
            resolvePromise(value);
        };

        const matches = (name: string) =>
            !opts.extensions?.length ||
            opts.extensions.some((e) => name.toLowerCase().endsWith(`.${e.toLowerCase()}`));

        async function render() {
            $("cwd").textContent = cwd;
            const list = $<HTMLUListElement>("list");
            list.innerHTML = "";
            let entries: Awaited<ReturnType<typeof readDir>> = [];
            try {
                entries = await readDir(cwd);
            } catch {
                entries = [];
            }
            for (const e of entries.filter((e) => e.isDirectory || matches(e.name))) {
                const li = document.createElement("li");
                const b = document.createElement("button");
                b.type = "button";
                b.dataset.entry = e.name;
                b.textContent = (e.isDirectory ? "📁 " : "📄 ") + e.name;
                // Directories always navigate; in directory mode the OK button selects the
                // current directory (or the ticked ones when multiple).
                b.onclick = () => {
                    const full = normalize(`${cwd}/${e.name}`);
                    if (e.isDirectory) {
                        cwd = full;
                        void render();
                    } else if (opts.mode === "save") {
                        filename.value = e.name;
                    } else if (opts.multiple) {
                        selected.has(full) ? selected.delete(full) : selected.add(full);
                        b.style.fontWeight = selected.has(full) ? "bold" : "";
                    } else {
                        finish(full);
                    }
                };
                if (e.isDirectory && opts.directory && opts.multiple) {
                    const tick = document.createElement("input");
                    tick.type = "checkbox";
                    tick.dataset.dir = e.name;
                    tick.checked = selected.has(normalize(`${cwd}/${e.name}`));
                    tick.onclick = (ev) => {
                        ev.stopPropagation();
                        const full = normalize(`${cwd}/${e.name}`);
                        tick.checked ? selected.add(full) : selected.delete(full);
                    };
                    li.appendChild(tick);
                }
                li.appendChild(b);
                list.appendChild(li);
            }
        }

        $("up").onclick = () => {
            cwd = cwd === "/" ? "/" : normalize(cwd.slice(0, cwd.lastIndexOf("/")) || "/");
            void render();
        };
        $("cancel").onclick = () => finish(null);
        $("confirm").onclick = () => {
            if (opts.mode === "save") {
                const name = filename.value.trim();
                finish(name ? normalize(`${cwd}/${name}`) : null);
            } else if (opts.directory && opts.multiple) {
                finish(selected.size ? Array.from(selected) : [cwd]);
            } else if (opts.directory) {
                finish(cwd);
            } else if (opts.multiple) {
                finish(Array.from(selected));
            } else {
                finish(null);
            }
        };
        $("upload-btn").onclick = () => $<HTMLInputElement>("upload").click();
        $<HTMLInputElement>("upload").onchange = async (ev) => {
            const files = Array.from((ev.target as HTMLInputElement).files ?? []);
            const written: string[] = [];
            for (const f of files) {
                const target = normalize(`${cwd}/${f.name}`);
                await writeFile(target, new Uint8Array(await f.arrayBuffer()));
                written.push(target);
            }
            if (written.length) finish(opts.multiple ? written : written[0]);
        };

        dlg.addEventListener("cancel", () => finish(null));
        dlg.showModal();
        void render();
    });
}

export { basename, dirname };
