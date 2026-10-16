import { describe, expect, it } from "vitest";
import { isSyncDue, SYNC_INTERVAL_MS } from "@/utils/accountSync";

const now = Date.UTC(2026, 9, 17, 12, 0, 0);

describe("isSyncDue", () => {
    it("is due when the account was never synced", () => {
        expect(isSyncDue(undefined, now)).toBe(true);
    });

    it("is not due within the interval", () => {
        expect(isSyncDue(now - SYNC_INTERVAL_MS + 1, now)).toBe(false);
        expect(isSyncDue(now, now)).toBe(false);
    });

    it("is due once the interval has passed", () => {
        expect(isSyncDue(now - SYNC_INTERVAL_MS, now)).toBe(true);
        expect(isSyncDue(now - 3 * SYNC_INTERVAL_MS, now)).toBe(true);
    });

    it("is due when the stored time is in the future (clock skew)", () => {
        expect(isSyncDue(now + 60_000, now)).toBe(true);
    });
});
