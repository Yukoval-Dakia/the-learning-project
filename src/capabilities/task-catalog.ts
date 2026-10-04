// YUK-1062 — static capability composition, without application public barrels.
import { composeTaskCatalog } from '@/ai/task-catalog';
import { agencyTaskSpecs } from '@/capabilities/agency/task-public';
import { copilotTaskSpecs } from '@/capabilities/copilot/task-public';
import { ingestionTaskSpecs } from '@/capabilities/ingestion/task-public';
import { knowledgeTaskSpecs } from '@/capabilities/knowledge/task-public';
import { notesTaskSpecs } from '@/capabilities/notes/task-public';
import { practiceTaskSpecs } from '@/capabilities/practice/task-public';

/**
 * The composed, frozen catalog of all owned TaskDefinitions.
 * Indexed by TaskKind string. Runtime may index this by kind.
 */
export const taskCatalog = composeTaskCatalog(
  [
    { owner: 'practice', specs: practiceTaskSpecs },
    { owner: 'ingestion', specs: ingestionTaskSpecs },
    { owner: 'knowledge', specs: knowledgeTaskSpecs },
    { owner: 'notes', specs: notesTaskSpecs },
    { owner: 'agency', specs: agencyTaskSpecs },
    { owner: 'copilot', specs: copilotTaskSpecs },
  ] as const,
  // YUK-987: +SupplyPlanTask（供给需求层 planner）→ 50。
  // YUK-1016: +CauseCategoryProposeTask（cause catalog 增长提议）→ 51。
  // YUK-376: +ItemPriorLlasaTask（LLaSA 学生模拟冷启锚 opt-in 变体）→ 52。
  // YUK-1049: +JevScoringDecisionTask（首个 typed execution spec）→ 53。
  // YUK-1047: native frozen-rule pi task → 54.
  54,
);
