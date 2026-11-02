import type { KnowledgeTagEmbedder, NameKcFn } from '@/kernel/records/knowledge-tag';
import {
  EMBED_MODEL,
  type EmbedProviderAttemptOptions,
  embedText,
  isDirectProviderAttemptInvariantError,
} from '@/server/ai/embed';
import { getDefaultSubjectRegistry } from '@/subjects/profile';
import { type ColdStartBridgeRunTaskFn, runColdStartBridge } from './cold-start-bridge';

export function createKnowledgeNamer(params: {
  db: Parameters<typeof runColdStartBridge>[0]['db'];
  runTaskFn?: ColdStartBridgeRunTaskFn;
  ctx?: unknown;
}): NameKcFn {
  return async ({ questionText, knowledgeHint, subjectId }) => {
    const bridge = await runColdStartBridge({
      db: params.db,
      questionMd: questionText,
      existingReferenceMd: '(reference answer not needed for tagging)',
      knowledgeHint,
      // Preserve the single-subject vocabulary even for custom roots not in a caller's list.
      knownSubjects: [
        {
          id: subjectId,
          display_name: getDefaultSubjectRegistry().get(subjectId)?.displayName ?? subjectId,
        },
      ],
      runTaskFn: params.runTaskFn,
      ctx: params.ctx ?? { db: params.db },
    });
    // Forward the run provenance (YUK-1604) so tagKnowledge can audit the naming call.
    return {
      kc_name: bridge.kc_name,
      ...(bridge.task_run_id !== undefined ? { task_run_id: bridge.task_run_id } : {}),
      ...(bridge.cost_usd !== undefined ? { cost_usd: bridge.cost_usd } : {}),
    };
  };
}

export function createKnowledgeTagEmbedder(
  providerAttempt?: EmbedProviderAttemptOptions,
): KnowledgeTagEmbedder {
  return {
    provider: 'dashscope',
    model: EMBED_MODEL,
    embed: (text) => embedText(text, providerAttempt),
  };
}

// Provider-attempt lifecycle failures abort the caller; any other tagging throw is a
// best-effort miss the caller logs and routes to review.
export function rethrowKnowledgeTagInvariant(error: unknown): void {
  if (isDirectProviderAttemptInvariantError(error)) throw error;
}
