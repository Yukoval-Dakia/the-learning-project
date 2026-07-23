import type { MemoryClient } from '@/server/memory/client';
import { vi } from 'vitest';

// YUK-557 (F7) — a MemoryClient test double: every method a no-op default, with a
// spread override for the one or two methods a given test actually drives. Only a
// type-only import of MemoryClient (no runtime dependency on the client module) and
// `vi` at runtime, so it is safe in BOTH the unit and db vitest partitions.
//
// Distinct from the file-local mem0LikeMock in client.test.ts: Mem0Like is the
// INNER mem0 surface (add/search/delete/history/get) that createMemoryClient wraps;
// MemoryClient is the OUTER project surface (addEventMemory/search/hardDelete/
// history/restoreVerbatim). Different types — this one stays a shared helper, that
// one stays file-local (V8).
export function memoryClientMock(overrides: Partial<MemoryClient> = {}): MemoryClient {
  return {
    addEventMemory: vi.fn(async () => ({ results: [] })),
    addVerbatimOnce: vi.fn(async () => ({ results: [] })),
    search: vi.fn(async () => ({ results: [] })),
    hardDelete: vi.fn(async () => {}),
    history: vi.fn(async () => []),
    restoreVerbatim: vi.fn(async () => ({ results: [] })),
    ...overrides,
  };
}
