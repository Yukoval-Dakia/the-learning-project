// YUK-1062 — static capability composition, without application public barrels.
import { composeTaskCatalog } from '@/ai/task-catalog';
import { agencyTaskSpecs } from '@/capabilities/agency/task-public';
import { copilotTaskSpecs } from '@/capabilities/copilot/task-public';
import { drawingTaskSpecs } from '@/capabilities/drawing/task-public';
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
    { owner: 'drawing', specs: drawingTaskSpecs },
  ] as const,
  60,
);
