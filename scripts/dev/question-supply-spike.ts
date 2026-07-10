// 自动供给引擎质量 spike —— 把 quiz_gen → quiz_verify 从 nightly cron / learning_item 锚上拆下来直驱。
//
// 背景：供给链测绘（2026-07-10，YUK-604/605）后 owner 要先观测「引擎产出的题到底什么质量」。
// 本脚本绕开 pg-boss 与 frontier discovery（后者被 YUK-604 pending-stall 挡住），直接以
// spike KC 为锚驱动 runQuizGen（closed_book），再逐题 runQuizVerify，最后渲 markdown 质检报告。
//
// 用法（本地 dev DB，compose Postgres :5433）：
//   pnpm exec tsx scripts/dev/question-supply-spike.ts                       # gen+verify+report 全跑
//   pnpm exec tsx scripts/dev/question-supply-spike.ts --phase gen --targets yuwen-huoyong --count 2
//   pnpm exec tsx scripts/dev/question-supply-spike.ts --phase verify        # 只补验尚无终态判词的题
//   pnpm exec tsx scripts/dev/question-supply-spike.ts --phase report        # 只渲报告
//
// 清理（手动）：delete from question where source='quiz_gen';
//              delete from knowledge where id like 'spike:%';
//
// 安全：只连 127.0.0.1/localhost（非本地 DATABASE_URL 直接 throw）；count 硬顶 5/target
// （YUK-555 精神——verify 每题 2-3 次 LLM call）。

import { loadEnv } from '../../server/env';
import { buildLocalDatabaseUrl } from '../local-db-env';

loadEnv();
// 强制本地 dev DB（覆盖 .env 里任何 DATABASE_URL），杜绝误连生产。
process.env.DATABASE_URL = buildLocalDatabaseUrl(process.env);
const dbHost = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')).hostname;
if (dbHost !== '127.0.0.1' && dbHost !== 'localhost') {
  throw new Error(`refusing non-local DB host: ${dbHost}`);
}

interface SpikeTarget {
  key: string;
  kcId: string;
  name: string;
  subject: 'yuwen' | 'math' | 'physics';
  /** 题型 hint；undefined = 让 agent 自由选型（观测 free-choice 行为） */
  kind?: string;
}

// 三个内容 KC：两个钉 kind（走 skill 规范包），一个不钉（观测自由选型）。
const TARGETS: SpikeTarget[] = [
  {
    key: 'yuwen-huoyong',
    kcId: 'spike:yuwen:cilei-huoyong',
    name: '文言文实词·词类活用',
    subject: 'yuwen',
    kind: 'translation',
  },
  {
    key: 'yuwen-lunzheng',
    kcId: 'spike:yuwen:lunshu-lunzheng',
    name: '现代文阅读·论证方法辨析',
    subject: 'yuwen',
    // 不钉 kind——观测引擎自由选型
  },
  {
    key: 'math-dingdian',
    kcId: 'spike:math:erci-dingdian',
    name: '二次函数·顶点式与最值',
    subject: 'math',
    kind: 'calculation',
  },
];

const args = process.argv.slice(2);
function getFlag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const phase = getFlag('phase') ?? 'all';
const countPerTarget = Math.min(Number(getFlag('count') ?? 3), 5);
/** 覆盖所有选中 target 的 kind（判别自由选型 vs kind 本身的失败归因） */
const kindOverride = getFlag('kind');
const targetFilter = getFlag('targets')?.split(',');
const selectedTargets = targetFilter
  ? TARGETS.filter((t) => targetFilter.includes(t.key))
  : TARGETS;

async function main() {
  const { db } = await import('@/db/client');
  const { knowledge, question, event } = await import('@/db/schema');
  const { and, asc, eq, inArray } = await import('drizzle-orm');
  const { runQuizGen } = await import('@/server/boss/handlers/quiz_gen');
  const { runQuizVerify } = await import('@/server/boss/handlers/quiz_verify');
  const { runTask } = await import('@/server/ai/runner');

  const runTaskFn = async (kind: string, input: unknown, ctx: unknown) =>
    runTask(kind, input, ctx as Parameters<typeof runTask>[2]);

  // ---------- spike KC bootstrap（幂等，形状照 knowledge/server/seed.ts） ----------
  async function ensureSpikeKcs() {
    for (const t of TARGETS) {
      const now = new Date();
      await db
        .insert(knowledge)
        .values({
          id: t.kcId,
          name: t.name,
          domain: t.subject,
          parent_id: `seed:${t.subject}:root`,
          merged_from: [],
          proposed_by_ai: false,
          approval_status: 'approved',
          created_at: now,
          updated_at: now,
          version: 0,
        })
        .onConflictDoNothing({ target: knowledge.id });
    }
    console.log(`[spike] KCs ensured: ${TARGETS.map((t) => t.kcId).join(', ')}`);
  }

  // ---------- phase: gen ----------
  async function phaseGen() {
    for (const t of selectedTargets) {
      const started = Date.now();
      const kind = kindOverride ?? t.kind;
      console.log(
        `[spike:gen] ${t.key} (${t.name}) count=${countPerTarget} kind=${kind ?? '(free)'} ...`,
      );
      try {
        const res = await runQuizGen({
          db,
          trigger: 'knowledge',
          refId: t.kcId,
          count: countPerTarget,
          generationMethod: 'closed_book',
          kind,
          // 断开 pg-boss：verify 由本脚本 phase=verify 直驱
          enqueueQuizVerify: async () => {},
        });
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        console.log(
          `[spike:gen] ${t.key} -> ${res.status} questions=[${res.question_ids?.join(', ') ?? ''}] (${secs}s)`,
        );
      } catch (e) {
        console.error(`[spike:gen] ${t.key} FAILED: ${(e as Error).message}`);
      }
    }
  }

  // ---------- phase: verify ----------
  async function phaseVerify() {
    const rows = await db
      .select({ id: question.id })
      .from(question)
      .where(eq(question.source, 'quiz_gen'))
      .orderBy(asc(question.id));
    console.log(`[spike:verify] ${rows.length} quiz_gen questions in DB`);
    for (const r of rows) {
      const started = Date.now();
      try {
        const res = await runQuizVerify({ db, questionId: r.id, runTaskFn });
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        console.log(
          `[spike:verify] ${r.id} -> ${res.status}${res.overall ? ` overall=${res.overall}` : ''} (${secs}s)`,
        );
      } catch (e) {
        console.error(`[spike:verify] ${r.id} FAILED: ${(e as Error).message}`);
      }
    }
  }

  // ---------- phase: report ----------
  async function phaseReport() {
    const qs = await db
      .select()
      .from(question)
      .where(eq(question.source, 'quiz_gen'))
      .orderBy(asc(question.id));
    const kcIds = [...new Set(qs.flatMap((q) => q.knowledge_ids ?? []))];
    const kcs = kcIds.length
      ? await db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(inArray(knowledge.id, kcIds))
      : [];
    const kcName = new Map(kcs.map((k) => [k.id, k.name]));
    const qIds = qs.map((q) => q.id);
    const verifyEvents = qIds.length
      ? await db
          .select({
            subject_id: event.subject_id,
            outcome: event.outcome,
            payload: event.payload,
          })
          .from(event)
          .where(and(eq(event.action, 'experimental:quiz_verify'), inArray(event.subject_id, qIds)))
      : [];
    const evByQ = new Map<string, (typeof verifyEvents)[number][]>();
    for (const ev of verifyEvents) {
      const list = evByQ.get(ev.subject_id) ?? [];
      list.push(ev);
      evByQ.set(ev.subject_id, list);
    }

    const lines: string[] = [];
    lines.push('# 自动供给引擎质量 spike 报告');
    lines.push('');
    lines.push(`- 生成时间：${new Date().toISOString()}`);
    lines.push(`- AI provider：${process.env.AI_PROVIDER_OVERRIDE ?? 'mimo-v2.5 (default)'}`);
    lines.push(`- 题目总数（source=quiz_gen）：${qs.length}`);
    lines.push('');
    lines.push('## 总览');
    lines.push('');
    lines.push('| # | question_id | KC | kind | difficulty | draft_status | verify |');
    lines.push('|---|---|---|---|---|---|---|');
    qs.forEach((q, i) => {
      const evs = evByQ.get(q.id) ?? [];
      const verdicts = evs.map(
        (e) => `${e.outcome ?? '?'}:${(e.payload as { overall?: string })?.overall ?? '?'}`,
      );
      const kc = (q.knowledge_ids ?? []).map((id) => kcName.get(id) ?? id).join('; ');
      lines.push(
        `| ${i + 1} | \`${q.id}\` | ${kc} | ${q.kind} | ${q.difficulty} | ${q.draft_status ?? 'NULL(≡active)'} | ${verdicts.join(' / ') || '(未验)'} |`,
      );
    });
    lines.push('');

    qs.forEach((q, i) => {
      lines.push(`## 题 ${i + 1} · \`${q.id}\``);
      lines.push('');
      lines.push(
        `**KC**: ${(q.knowledge_ids ?? []).map((id) => kcName.get(id) ?? id).join('; ')} · **kind**: ${q.kind} · **difficulty**: ${q.difficulty} · **draft_status**: ${q.draft_status ?? 'NULL(≡active)'}`,
      );
      lines.push('');
      lines.push('### 题面（prompt_md）');
      lines.push('');
      lines.push(q.prompt_md);
      lines.push('');
      if (q.choices_md?.length) {
        lines.push('### 选项（choices_md）');
        lines.push('');
        q.choices_md.forEach((c, ci) => lines.push(`- ${String.fromCharCode(65 + ci)}. ${c}`));
        lines.push('');
      }
      if (q.reference_md) {
        lines.push('### 参考答案/解析（reference_md）');
        lines.push('');
        lines.push(q.reference_md);
        lines.push('');
      }
      if (q.rubric_json) {
        lines.push('### rubric_json');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(q.rubric_json, null, 2).slice(0, 2000));
        lines.push('```');
        lines.push('');
      }
      const meta = q.metadata as Record<string, unknown> | null;
      if (meta?.quiz_gen) {
        lines.push('### metadata.quiz_gen');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(meta.quiz_gen, null, 2).slice(0, 2500));
        lines.push('```');
        lines.push('');
      }
      const evs = evByQ.get(q.id) ?? [];
      for (const ev of evs) {
        lines.push(`### verify 事件（outcome=${ev.outcome ?? '?'}）`);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(ev.payload, null, 2).slice(0, 4000));
        lines.push('```');
        lines.push('');
      }
    });

    const fs = await import('node:fs');
    fs.mkdirSync('scratchpad', { recursive: true });
    const outPath = 'scratchpad/question-supply-spike-report.md';
    fs.writeFileSync(outPath, lines.join('\n'));
    console.log(`[spike:report] written -> ${outPath} (${qs.length} questions)`);
  }

  await ensureSpikeKcs();
  if (phase === 'gen' || phase === 'all') await phaseGen();
  if (phase === 'verify' || phase === 'all') await phaseVerify();
  if (phase === 'report' || phase === 'all') await phaseReport();
  process.exit(0);
}

main().catch((e) => {
  console.error('[spike] fatal:', e);
  process.exit(1);
});
