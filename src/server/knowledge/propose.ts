import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import type { SubjectProfile } from '@/subjects/profile';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { writeRetryableAiFailureLedger } from './ai_failure_log';
import { writeKnowledgeProposeEvent } from './proposals';
import { loadTreeSnapshot } from './tree';

const ProposalSchema = z.object({
  name: z.string().min(1).max(80),
  parent_id: z.string().min(1),
  reasoning: z.string().min(1).max(500),
});

const OutputSchema = z.object({
  proposals: z.array(ProposalSchema).max(3),
});

export type ProposeOutput = z.infer<typeof OutputSchema>;

export interface MistakeContent {
  prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string;
  knowledge_ids_picked: string[];
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

export interface RunProposeAndWriteParams {
  db: Db;
  mistakeContent: MistakeContent;
  runTaskFn: RunTaskFn;
  env?: unknown;
  subjectProfile?: SubjectProfile;
}

export async function runProposeAndWrite(params: RunProposeAndWriteParams): Promise<void> {
  try {
    const tree = await loadTreeSnapshot(params.db);
    const input = {
      mistake_content: params.mistakeContent,
      tree_snapshot: tree.map((n) => ({
        id: n.id,
        name: n.name,
        parent_id: n.parent_id,
        effective_domain: n.effective_domain,
      })),
    };
    const result = await params.runTaskFn('KnowledgeProposeTask', input, {
      db: params.db,
      env: params.env,
      subjectProfile: params.subjectProfile,
    });
    const parsed = parseProposeOutput(result.text);
    for (const p of parsed.proposals) {
      const parentExists = (
        await params.db
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(eq(knowledge.id, p.parent_id), isNull(knowledge.archived_at)))
          .limit(1)
      )[0];
      if (!parentExists) {
        console.warn(
          `runProposeAndWrite: skipping propose_new with non-existent parent_id=${p.parent_id}`,
        );
        continue;
      }
      await writeKnowledgeProposeEvent(params.db, {
        payload: { mutation: 'propose_new', name: p.name, parent_id: p.parent_id },
        reasoning: p.reasoning,
      });
    }
  } catch (err) {
    console.error('runProposeAndWrite: failed (mistake unaffected)', err);
    await writeRetryableAiFailureLedger(params.db, 'KnowledgeProposeTask');
  }
}

export function parseProposeOutput(text: string): ProposeOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseProposeOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseProposeOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return OutputSchema.parse(json);
}
