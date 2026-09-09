// Same surface as "jotai/utils" (vanilla + react utils) with storage defaulting to the server.
export * from "jotai/vanilla/utils";
export * from "jotai/react/utils";

import {
    atomWithStorage as baseAtomWithStorage,
    createJSONStorage as baseCreateJSONStorage,
} from "jotai/vanilla/utils";
import type { SyncStorage } from "jotai/vanilla/utils/atomWithStorage";
import { serverStorage } from "../storage";

export function createJSONStorage<Value>(_getStringStorage?: unknown): SyncStorage<Value> {
    // Every browser-storage getter (localStorage or sessionStorage) is redirected to the server.
    return baseCreateJSONStorage<Value>(() => serverStorage) as SyncStorage<Value>;
}

export function atomWithStorage<Value>(
    key: string,
    initialValue: Value,
    storage?: Parameters<typeof baseAtomWithStorage<Value>>[2],
    options?: Parameters<typeof baseAtomWithStorage<Value>>[3],
) {
    return baseAtomWithStorage<Value>(
        key,
        initialValue,
        (storage ?? createJSONStorage<Value>()) as Parameters<typeof baseAtomWithStorage<Value>>[2],
        { getOnInit: true, ...(options ?? {}) },
    );
}
