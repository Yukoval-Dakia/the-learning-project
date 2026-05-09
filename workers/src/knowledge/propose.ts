import { z } from 'zod';
import type { D1Database } from '@cloudflare/workers-types';
import { loadTreeSnapshot } from './tree';
import { writeDreamingProposal } from './proposals';

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

export interface RunTaskFn {
  (kind: string, input: unknown, ctx: unknown): Promise<{ text: string }>;
}

export interface RunProposeAndWriteParams {
  db: D1Database;
  mistakeContent: MistakeContent;
  runTaskFn: RunTaskFn;
  env?: unknown;
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
    const result = await params.runTaskFn('KnowledgeProposeTask', input, { env: params.env });
    const parsed = parseProposeOutput(result.text);
    for (const p of parsed.proposals) {
      const parentExists = await params.db
        .prepare(`select id from knowledge where id = ? and archived_at is null`)
        .bind(p.parent_id)
        .first();
      if (!parentExists) {
        console.warn(`runProposeAndWrite: skipping propose_new with non-existent parent_id=${p.parent_id}`);
        continue;
      }
      await writeDreamingProposal(params.db, {
        payload: { mutation: 'propose_new', name: p.name, parent_id: p.parent_id },
        reasoning: p.reasoning,
      });
    }
  } catch (err) {
    console.error('runProposeAndWrite: failed (mistake unaffected)', err);
  }
}

export function parseProposeOutput(text: string): ProposeOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`parseProposeOutput: no JSON object found in text`);
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
