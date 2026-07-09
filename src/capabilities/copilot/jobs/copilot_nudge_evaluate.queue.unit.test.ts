import { capabilities } from '@/capabilities';
import { describe, expect, it } from 'vitest';
// Relative import (not the @/server/boss/* alias) so the partition audit's pure-module exception
// applies — queue-names.ts is dependency-free (see DB_TAINTED_DIR_EXCEPTIONS, audit-test-partition.ts).
import { COPILOT_NUDGE_EVALUATE_QUEUE } from '../../../server/boss/queue-names';

// YUK-577 (should#8) — cross-package queue-name drift guard.
//
// This is the first producer(ingestion)→consumer(copilot) three-package queue. All repo
// `boss.send` calls are bare literals with no send-target validation, so a copilot-side rename
// would send jobs to a worker-less queue that silently expire. Two defenses:
//   1. Both producer (ingestion post-commit send) and consumer (copilot manifest handler) import
//      the SAME exported constant COPILOT_NUDGE_EVALUATE_QUEUE — structural single-source.
//   2. This test asserts that constant resolves to a REGISTERED capability job handler name, so a
//      future refactor that drops/renames the handler while leaving the send fails loud in CI.

describe('YUK-577 nudge queue-name drift guard', () => {
  it('COPILOT_NUDGE_EVALUATE_QUEUE is a registered capability job handler', () => {
    const handlerNames = new Set(
      capabilities.flatMap((c) => c.jobs?.handlers ?? []).map((h) => h.name),
    );
    expect(handlerNames.has(COPILOT_NUDGE_EVALUATE_QUEUE)).toBe(true);
  });

  it('is registered on the fast queue tier (pure-DB, not the LLM-billing agent tier)', () => {
    const decl = capabilities
      .flatMap((c) => c.jobs?.handlers ?? [])
      .find((h) => h.name === COPILOT_NUDGE_EVALUATE_QUEUE);
    expect(decl?.queue).toBe('fast');
  });
});
