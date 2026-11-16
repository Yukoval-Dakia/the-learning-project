// YUK-1784 verification harness (not committed): runs NoteGenerateTask against a
// real provider with one fixed input, then replays the job-side contract check
// and the bounded in-round revision exactly as note_generate.ts does. Also feeds
// a synthetic NOTE v1 document that ends with a closing pleasantry through the
// current parse+check pipeline for a deterministic mechanism comparison.
//
//   set -a; . ~/.config/tlp/dev-secrets.env; set +a
//   DATABASE_URL=... pnpm exec tsx scripts/yuk1784-note-ending-verify.ts <label> <outdir>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  noteBodyContractIssues,
  noteKnownIssuesSummary,
} from '@/capabilities/notes/server/note-contract-check';
import type { NoteGenerateTaskInput } from '@/capabilities/notes/server/note-generation-input';
import { parseNoteGenerateOutput } from '@/capabilities/notes/tasks/note-tasks';
import { db } from '@/db/client';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { resolveNoteSkillDoc } from '@/subjects/note-skills';
import { resolveSubjectProfile } from '@/subjects/profile';

const label = process.argv[2] ?? 'run';
const outdir = process.argv[3] ?? '/tmp/yuk1784';
mkdirSync(outdir, { recursive: true });

const input: NoteGenerateTaskInput = {
  artifact_id: 'yuk1784-verify-note',
  artifact_type: 'note_atomic',
  atomic_title: '椭圆离心率',
  title: '椭圆离心率',
  one_line_intent: '用 a,b,c 的关系解释椭圆离心率 e，并会用 e=c/a 计算',
  knowledge_node: { id: 'kn-yuk1784-eccentricity', name: '椭圆离心率', domain: 'math' },
  knowledge_nodes: [{ id: 'kn-yuk1784-eccentricity', name: '椭圆离心率', domain: 'math' }],
  parent_hub: null,
  related_knowledge_ids: [],
  reference_artifacts: [],
};

const CHATTER_DOC = `NOTE v1
@type note_long

@body
椭圆离心率 $e=\\frac{c}{a}$，其中 $c=\\sqrt{a^2-b^2}$。$e$ 越接近 1 椭圆越扁。

以上就是本篇笔记的全部内容，希望对你有帮助，祝你学习进步！

@end
`;

function blockTexts(bodyBlocks: { content?: unknown[] }): string[] {
  const out: string[] = [];
  const walk = (node: Record<string, unknown>) => {
    if (typeof node.text === 'string') out.push(node.text);
    const content = Array.isArray(node.content) ? node.content : [];
    for (const child of content) {
      if (child !== null && typeof child === 'object') walk(child as Record<string, unknown>);
    }
  };
  for (const node of bodyBlocks.content ?? []) {
    if (node !== null && typeof node === 'object') walk(node as Record<string, unknown>);
  }
  return out;
}

async function main(): Promise<void> {
  const subjectProfile = resolveSubjectProfile('math');
  const skillDocs = await resolveNoteSkillDoc(subjectProfile.id);
  const runTaskFn = makeRunTaskFn(db);

  // Deterministic mechanism check on an identical synthetic document.
  const synthetic = (() => {
    try {
      const parsed = parseNoteGenerateOutput(CHATTER_DOC, 'note_long', 'end_turn');
      return {
        parsed_ok: true,
        blocks_tail: blockTexts(parsed.body_blocks).slice(-3),
        issues: noteBodyContractIssues('note_long', parsed.body_blocks),
      };
    } catch (err) {
      return { parsed_ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  const first = await runTaskFn('NoteGenerateTask', input, {
    subjectProfile,
    piSkillDocs: skillDocs,
  });
  const parsed = parseNoteGenerateOutput(first.text, 'note_atomic', first.finishReason);
  const issues = noteBodyContractIssues('note_atomic', parsed.body_blocks);

  const revision: Record<string, unknown> = { triggered: issues.length > 0 };
  let finalIssues = issues;
  let finalParsed = parsed;

  // Forced revision round: feed the synthetic chatter doc's real typed issues as
  // revision_context, mirroring the note_generate same-round fix on a real call.
  if (process.env.YUK1784_FORCE_REVISION === '1') {
    const seeded = parseNoteGenerateOutput(CHATTER_DOC, 'note_long', 'end_turn');
    const seededIssues = noteBodyContractIssues('note_long', seeded.body_blocks);
    const revised = await runTaskFn(
      'NoteGenerateTask',
      {
        ...input,
        artifact_type: 'note_long',
        revision_context: { issues: seededIssues, body_blocks: seeded.body_blocks },
      },
      { subjectProfile, piSkillDocs: skillDocs },
    );
    const revisedParsed = parseNoteGenerateOutput(
      revised.text,
      'note_long',
      revised.finishReason,
    );
    revision.forced = {
      seeded_issues: seededIssues,
      task_run_id: revised.task_run_id,
      cost_usd: revised.cost_usd,
      raw_tail: revised.text.slice(-1200),
      blocks_tail: blockTexts(revisedParsed.body_blocks).slice(-3),
      issues_after: noteBodyContractIssues('note_long', revisedParsed.body_blocks),
    };
  }

  if (issues.length > 0) {
    try {
      const revised = await runTaskFn(
        'NoteGenerateTask',
        { ...input, revision_context: { issues, body_blocks: parsed.body_blocks } },
        { subjectProfile, piSkillDocs: skillDocs },
      );
      const revisedParsed = parseNoteGenerateOutput(
        revised.text,
        'note_atomic',
        revised.finishReason,
      );
      revision.task_run_id = revised.task_run_id;
      revision.cost_usd = revised.cost_usd;
      revision.raw_tail = revised.text.slice(-1200);
      revision.blocks_tail = blockTexts(revisedParsed.body_blocks).slice(-3);
      finalIssues = noteBodyContractIssues('note_atomic', revisedParsed.body_blocks);
      finalParsed = revisedParsed;
    } catch (err) {
      revision.error = err instanceof Error ? err.message : String(err);
    }
  }

  const evidence = {
    label,
    code_head: process.env.GIT_HEAD ?? null,
    ran_at: new Date().toISOString(),
    provider_override: process.env.AI_PROVIDER_OVERRIDE ?? null,
    provider_model: process.env.AI_PROVIDER_MODEL ?? null,
    synthetic_chatter_doc: synthetic,
    generation: {
      task_run_id: first.task_run_id,
      cost_usd: first.cost_usd,
      finish_reason: first.finishReason,
      raw_tail: first.text.slice(-1200),
      raw_full: first.text,
      blocks_tail: blockTexts(parsed.body_blocks).slice(-3),
      issues,
    },
    revision,
    final: {
      issues: finalIssues,
      known_issues_summary: noteKnownIssuesSummary(finalIssues),
      blocks_tail: blockTexts(finalParsed.body_blocks).slice(-3),
    },
  };
  const path = join(outdir, `note-ending-${label}.json`);
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  console.log(`[yuk1784] wrote ${path}`);
  console.log(
    `[yuk1784] cost: first=${first.cost_usd ?? 'n/a'} revision=${String(revision.cost_usd ?? 'n/a')}`,
  );
  console.log(`[yuk1784] issues after first: ${issues.length}; final: ${finalIssues.length}`);
}

await main();
process.exit(0);
