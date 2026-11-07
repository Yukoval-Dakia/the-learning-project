/**
 * YUK-1869 S5 probe — resolved provider / model / reasoning for every composed task.
 *
 * No DB, no env, no provider call: the pure config chain with code defaults only.
 * Prints one tab-separated line per task in sorted-kind order, plus a count line.
 * The identical file runs at base and head; output must be byte-identical.
 */
import { taskCatalog } from '@/capabilities/task-catalog';
import {
  selectPairModel,
  selectPairProvider,
  selectReasoningRequest,
} from '@/core/config/model-overrides';
import { CONFIG_REGISTRY } from '@/core/config/registry';
import { canonicalHash } from '@/core/migration/canonical';

const globalReasoning = CONFIG_REGISTRY['lane.global.reasoning'].codeDefault as {
  readonly level: string;
};

const kinds = Object.keys(taskCatalog).sort();
const lines: string[] = [`count=${kinds.length}`];
for (const kind of kinds) {
  const def = taskCatalog[kind as keyof typeof taskCatalog];
  const provider = selectPairProvider({
    defaults: { provider: def.defaultProvider },
  }).value as string;
  const model = selectPairModel({ defaults: { model: def.defaultModel } }).value as string;
  const reasoning = selectReasoningRequest({
    taskKind: kind,
    global: { level: globalReasoning.level },
  });
  const reasoningText =
    reasoning.kind === 'request'
      ? `${reasoning.request.level}@${reasoning.request.source}:${reasoning.request.sourceKey}`
      : reasoning.kind;
  lines.push([kind, provider, model, reasoningText, canonicalHash(def.prompt)].join('\t'));
}
process.stdout.write(`${lines.join('\n')}\n`);
