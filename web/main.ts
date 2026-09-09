import { installGlobalStorage, preloadStorage, seedDefaults } from "./storage";

async function boot() {
    await preloadStorage();
    // telemetry-enabled defaults to true upstream and would report to PostHog from a self-hosted page.
    seedDefaults({ "telemetry-enabled": "false" });
    // Must happen before the app module is evaluated: jotai atoms read storage at import time.
    installGlobalStorage();
    await import("../src/index.tsx");
}

boot().catch((e) => {
    document.body.innerHTML = `<pre style="padding:2rem;font-family:monospace">Failed to start: ${String(e)}</pre>`;
});
