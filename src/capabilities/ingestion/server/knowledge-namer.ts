import type { NameKcFn } from '@/capabilities/knowledge/public';
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
    return { kc_name: bridge.kc_name };
  };
}
