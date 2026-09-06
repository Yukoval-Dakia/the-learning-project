import { type ColdStartBridgeRunTaskFn, runColdStartBridge } from './cold-start-bridge';

export type KnowledgeNamer = (args: {
  questionText: string;
  knowledgeHint: string | null;
  subjectId: string;
  knownSubjects: ReadonlyArray<{ id: string; display_name: string; aliases?: string[] }>;
}) => Promise<{ kc_name: string }>;

export function createKnowledgeNamer(params: {
  db: Parameters<typeof runColdStartBridge>[0]['db'];
  runTaskFn?: ColdStartBridgeRunTaskFn;
  ctx?: unknown;
}): KnowledgeNamer {
  return async ({ questionText, knowledgeHint, subjectId, knownSubjects }) => {
    const bridge = await runColdStartBridge({
      db: params.db,
      questionMd: questionText,
      existingReferenceMd: '(reference answer not needed for tagging)',
      knowledgeHint,
      knownSubjects: knownSubjects.filter((subject) => subject.id === subjectId),
      runTaskFn: params.runTaskFn,
      ctx: params.ctx ?? { db: params.db },
    });
    return { kc_name: bridge.kc_name };
  };
}
