import type { R2Client } from '@/server/r2';

export function memR2(): R2Client & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async put(key, body) {
      store.set(key, body);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
}
