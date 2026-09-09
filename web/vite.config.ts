/// <reference types="vitest/config" />
import { resolve } from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import pkg from "../package.json" with { type: "json" };

const root = resolve(import.meta.dirname);
const src = resolve(import.meta.dirname, "../src");
const shim = (name: string) => resolve(import.meta.dirname, `shims/${name}.ts`);

export default defineConfig({
    root,
    publicDir: resolve(import.meta.dirname, "../public"),
    plugins: [
        tanstackRouter({
            target: "react",
            routesDirectory: resolve(src, "routes"),
            generatedRouteTree: resolve(src, "routeTree.gen.ts"),
        }),
        react(),
        babel({ presets: [reactCompilerPreset()] }),
    ],
    server: {
        port: 1430,
        strictPort: true,
        proxy: {
            "/api": "http://127.0.0.1:8090",
            "/resources": "http://127.0.0.1:8090",
            "/ws": { target: "ws://127.0.0.1:8090", ws: true },
        },
    },
    build: {
        outDir: resolve(import.meta.dirname, "../dist-web"),
        emptyOutDir: true,
        target: "es2022",
        sourcemap: false,
    },
    resolve: {
        alias: [
            { find: "@", replacement: src },
            { find: "@tauri-apps/api/core", replacement: shim("tauri-core") },
            { find: "@tauri-apps/api/event", replacement: shim("tauri-event") },
            { find: "@tauri-apps/api/path", replacement: shim("tauri-path") },
            { find: "@tauri-apps/api/app", replacement: shim("tauri-app") },
            { find: "@tauri-apps/api/window", replacement: shim("tauri-window") },
            { find: "@tauri-apps/api/webviewWindow", replacement: shim("tauri-webviewWindow") },
            { find: "@tauri-apps/api/menu", replacement: shim("tauri-menu") },
            { find: "@tauri-apps/plugin-fs", replacement: shim("tauri-fs") },
            { find: "@tauri-apps/plugin-dialog", replacement: shim("tauri-dialog") },
            { find: "@tauri-apps/plugin-http", replacement: shim("tauri-http") },
            { find: "@tauri-apps/plugin-os", replacement: shim("tauri-os") },
            { find: "@tauri-apps/plugin-log", replacement: shim("tauri-log") },
            { find: "@tauri-apps/plugin-process", replacement: shim("tauri-process") },
            { find: "@tauri-apps/plugin-updater", replacement: shim("tauri-updater") },
            { find: "@tauri-apps/plugin-cli", replacement: shim("tauri-cli") },
            { find: "@tauri-apps/plugin-opener", replacement: shim("tauri-opener") },
            { find: /^jotai\/utils$/, replacement: shim("jotai-utils") },
        ],
    },
    define: {
        "import.meta.env.VITE_PLATFORM": JSON.stringify("linux"),
        "import.meta.env.VITE_WEB": JSON.stringify("1"),
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    test: {
        environment: "jsdom",
        include: ["tests/**/*.test.ts"],
    },
});
