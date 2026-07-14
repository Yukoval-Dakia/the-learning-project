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
  /** 注册科目（yuwen/math/physics）或未注册科目 id（走 general fallback profile） */
  subject: string;
  /** 题型 hint；undefined = 让 agent 自由选型（观测 free-choice 行为） */
  kind?: string;
}

// 9 科全题型评测矩阵（2026-07-10 owner：高中 9 门课全题型边角覆盖，sonnet-5 + medium）。
// 注册科目（yuwen/math/physics）用各自 profile 的全部 questionKinds；其余 6 科未注册 →
// 引擎按现行为走 general fallback profile（single/multiple/short_answer 三型）——这正是
// YUK-597 自定义科目上线前 thin-subject 的真实边角行为，报告/导出里 registered 分开标注。
interface SubjectMatrixRow {
  subject: string;
  registered: boolean;
  kcId: string;
  kcName: string;
  kinds: string[];
}

const MATRIX: SubjectMatrixRow[] = [
  {
    subject: 'yuwen',
    registered: true,
    kcId: 'spike:yuwen:quanxue',
    kcName: '文言文·《劝学》实词与句式',
    kinds: [
      'single_choice',
      'multiple_choice',
      'short_answer',
      'translation',
      'reading_comprehension',
    ],
  },
  {
    subject: 'math',
    registered: true,
    kcId: 'spike:math:erci-tuxiang',
    kcName: '二次函数·图像与性质',
    kinds: [
      'single_choice',
      'multiple_choice',
      'short_answer',
      'calculation',
      'proof',
      'word_problem',
    ],
  },
  {
    subject: 'physics',
    registered: true,
    kcId: 'spike:physics:niudun-yingyong',
    kcName: '牛顿运动定律·应用',
    kinds: ['single_choice', 'multiple_choice', 'short_answer', 'calculation'],
  },
  {
    subject: 'yingyu',
    registered: false,
    kcId: 'spike:yingyu:dingyu-congju',
    kcName: '英语·定语从句',
    kinds: ['single_choice', 'multiple_choice', 'short_answer'],
  },
  {
    subject: 'huaxue',
    registered: false,
    kcId: 'spike:huaxue:yanghua-huanyuan',
    kcName: '化学·氧化还原反应',
    kinds: ['single_choice', 'multiple_choice', 'short_answer'],
  },
  {
    subject: 'shengwu',
    registered: false,
    kcId: 'spike:shengwu:xibao-huxi',
    kcName: '生物·细胞呼吸',
    kinds: ['single_choice', 'multiple_choice', 'short_answer'],
  },
  {
    subject: 'lishi',
    registered: false,
    kcId: 'spike:lishi:xinhai-geming',
    kcName: '历史·辛亥革命',
    kinds: ['single_choice', 'multiple_choice', 'short_answer'],
  },
  {
    subject: 'dili',
    registered: false,
    kcId: 'spike:dili:daqi-huanliu',
    kcName: '地理·大气环流与气候类型',
    kinds: ['single_choice', 'multiple_choice', 'short_answer'],
  },
  {
    subject: 'zhengzhi',
    registered: false,
    kcId: 'spike:zhengzhi:shichang-jingji',
    kcName: '政治·市场经济与宏观调控',
    kinds: ['single_choice', 'multiple_choice', 'short_answer'],
  },
];

const TARGETS: SpikeTarget[] = MATRIX.flatMap((row) =>
  row.kinds.map((kind) => ({
    key: `${row.subject}-${kind}`,
    kcId: row.kcId,
    name: row.kcName,
    subject: row.subject,
    kind,
  })),
);

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
  const { ai_task_runs, knowledge, question, event } = await import('@/db/schema');
  const { and, asc, eq, inArray } = await import('drizzle-orm');
  const { runQuizGen } = await import('@/server/boss/handlers/quiz_gen');
  const { runQuizVerify } = await import('@/server/boss/handlers/quiz_verify');
  const { runTask } = await import('@/server/ai/runner');

  const runTaskFn = async (kind: string, input: unknown, ctx: unknown) =>
    runTask(kind, input, ctx as Parameters<typeof runTask>[2]);

  // ---------- spike KC bootstrap（幂等，形状照 knowledge/server/seed.ts） ----------
  // 注册科目挂 seed:<subj>:root；未注册科目先造 spike:<subj>:root（parent=null，
  // domain=subject id → resolveKnownSubjectId=null → 引擎 general fallback）。
  async function ensureSpikeKcs() {
    const now = new Date();
    const kcRow = (id: string, name: string, domain: string, parentId: string | null) => ({
      id,
      name,
      domain,
      parent_id: parentId,
      merged_from: [] as string[],
      proposed_by_ai: false,
      approval_status: 'approved' as const,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    for (const row of MATRIX) {
      let parentId: string;
      if (row.registered) {
        parentId = `seed:${row.subject}:root`;
      } else {
        parentId = `spike:${row.subject}:root`;
        await db
          .insert(knowledge)
          .values(kcRow(parentId, row.kcName.split('·')[0], row.subject, null))
          .onConflictDoNothing({ target: knowledge.id });
      }
      await db
        .insert(knowledge)
        .values(kcRow(row.kcId, row.kcName, row.subject, parentId))
        .onConflictDoNothing({ target: knowledge.id });
    }
    console.log(
      `[spike] KCs ensured: ${MATRIX.length} subjects → ${TARGETS.length} (subject×kind) cells`,
    );
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
    // lane 归因：created_by.task_run_id → ai_task_runs.provider/model（A/B 混库时逐题可辨）
    const genRunIds = [
      ...new Set(
        qs
          .map((q) => (q.created_by as { task_run_id?: string } | null)?.task_run_id)
          .filter((x): x is string => typeof x === 'string' && x.length > 0),
      ),
    ];
    const genRuns = genRunIds.length
      ? await db
          .select({
            id: ai_task_runs.id,
            provider: ai_task_runs.provider,
            model: ai_task_runs.model,
          })
          .from(ai_task_runs)
          .where(inArray(ai_task_runs.id, genRunIds))
      : [];
    const laneByRunId = new Map(genRuns.map((r) => [r.id, `${r.provider}/${r.model}`]));
    const laneOf = (q: (typeof qs)[number]) =>
      laneByRunId.get((q.created_by as { task_run_id?: string } | null)?.task_run_id ?? '') ?? '?';
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
    lines.push('| # | question_id | KC | kind | lane | difficulty | draft_status | verify |');
    lines.push('|---|---|---|---|---|---|---|---|');
    qs.forEach((q, i) => {
      const evs = evByQ.get(q.id) ?? [];
      const verdicts = evs.map(
        (e) => `${e.outcome ?? '?'}:${(e.payload as { overall?: string })?.overall ?? '?'}`,
      );
      const kc = (q.knowledge_ids ?? []).map((id) => kcName.get(id) ?? id).join('; ');
      lines.push(
        `| ${i + 1} | \`${q.id}\` | ${kc} | ${q.kind} | ${laneOf(q)} | ${q.difficulty} | ${q.draft_status ?? 'NULL(≡active)'} | ${verdicts.join(' / ') || '(未验)'} |`,
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

  // ---------- phase: export（结构化 JSON，供质量面板 + 网页仪表盘消费） ----------
  async function phaseExport() {
    const qs = await db
      .select()
      .from(question)
      .where(eq(question.source, 'quiz_gen'))
      .orderBy(asc(question.id));
    const genRunIds = [
      ...new Set(
        qs
          .map((q) => (q.created_by as { task_run_id?: string } | null)?.task_run_id)
          .filter((x): x is string => typeof x === 'string' && x.length > 0),
      ),
    ];
    const genRuns = genRunIds.length
      ? await db
          .select({
            id: ai_task_runs.id,
            provider: ai_task_runs.provider,
            model: ai_task_runs.model,
            cost_usd: ai_task_runs.cost_usd,
          })
          .from(ai_task_runs)
          .where(inArray(ai_task_runs.id, genRunIds))
      : [];
    const runById = new Map(genRuns.map((r) => [r.id, r]));
    const qIds = qs.map((q) => q.id);
    const verifyEvents = qIds.length
      ? await db
          .select({ subject_id: event.subject_id, outcome: event.outcome, payload: event.payload })
          .from(event)
          .where(and(eq(event.action, 'experimental:quiz_verify'), inArray(event.subject_id, qIds)))
      : [];
    const evByQ = new Map<string, Array<{ outcome: string | null; payload: unknown }>>();
    for (const ev of verifyEvents) {
      const list = evByQ.get(ev.subject_id) ?? [];
      list.push({ outcome: ev.outcome, payload: ev.payload });
      evByQ.set(ev.subject_id, list);
    }
    const failures = await db
      .select({ subject_id: event.subject_id, payload: event.payload })
      .from(event)
      .where(and(eq(event.action, 'experimental:quiz_gen'), eq(event.outcome, 'failure')));
    const matrixKcIds = new Set(MATRIX.map((m) => m.kcId));
    // 钉型 hint → 入库 kind 的归一走仓里的 canonical 映射（single/multiple_choice 都塌缩为
    // 'choice'、reading_comprehension→'reading'、calculation→'computation'——库列无法区分
    // 单选/多选，cell 按 (kcId, canonicalKind) 归并核算，塌缩本身作为发现记录）。
    const { normalizeToCanonicalKind } = await import('@/subjects/question-kind');
    const canonicalOf = (k: string) => normalizeToCanonicalKind(k) ?? k;
    const data = {
      generated_at: new Date().toISOString(),
      env_lane: {
        override: process.env.AI_PROVIDER_OVERRIDE ?? null,
        model: process.env.AI_PROVIDER_MODEL ?? null,
        effort: process.env.AI_PROVIDER_EFFORT ?? null,
      },
      matrix: MATRIX,
      cells: (() => {
        const grouped = new Map<
          string,
          { subject: string; kcId: string; name: string; canonical: string; hint_kinds: string[] }
        >();
        for (const t of TARGETS) {
          const c = canonicalOf(t.kind ?? 'free');
          const key = `${t.kcId}::${c}`;
          const g = grouped.get(key) ?? {
            subject: t.subject,
            kcId: t.kcId,
            name: t.name,
            canonical: c,
            hint_kinds: [],
          };
          if (t.kind) g.hint_kinds.push(t.kind);
          grouped.set(key, g);
        }
        return [...grouped.values()].map((g) => ({
          ...g,
          produced: qs.filter(
            (q) => (q.knowledge_ids ?? []).includes(g.kcId) && q.kind === g.canonical,
          ).length,
        }));
      })(),
      questions: qs.map((q) => {
        const runId = (q.created_by as { task_run_id?: string } | null)?.task_run_id ?? '';
        const run = runById.get(runId);
        const meta = (q.metadata as Record<string, Record<string, unknown>> | null)?.quiz_gen;
        return {
          id: q.id,
          kc_ids: q.knowledge_ids,
          subject: MATRIX.find((m) => (q.knowledge_ids ?? []).includes(m.kcId))?.subject ?? '?',
          kind: q.kind,
          lane: run ? `${run.provider}/${run.model}` : '?',
          gen_batch_cost_usd: run?.cost_usd ?? null,
          difficulty: q.difficulty,
          draft_status: q.draft_status,
          prompt_md: q.prompt_md,
          reference_md: q.reference_md,
          choices_md: q.choices_md,
          rubric_json: q.rubric_json,
          parse_repaired: meta?.parse_repaired === true,
          generation_method: meta?.generation_method ?? null,
          verify: evByQ.get(q.id) ?? [],
        };
      }),
      gen_failures: failures
        .filter((f) =>
          matrixKcIds.has(((f.payload as { ref_id?: string })?.ref_id ?? '') as string),
        )
        .map((f) => ({
          ref_id: (f.payload as { ref_id?: string })?.ref_id ?? f.subject_id,
          error: (f.payload as { error?: string })?.error ?? '?',
        })),
    };
    const fs = await import('node:fs');
    fs.mkdirSync('scratchpad', { recursive: true });
    const outPath = 'scratchpad/question-supply-eval.json';
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(
      `[spike:export] written -> ${outPath} (${qs.length} questions, ${data.gen_failures.length} gen failures)`,
    );
  }

  await ensureSpikeKcs();
  if (phase === 'gen' || phase === 'all') await phaseGen();
  if (phase === 'verify' || phase === 'all') await phaseVerify();
  if (phase === 'report' || phase === 'all') await phaseReport();
  if (phase === 'export' || phase === 'all') await phaseExport();
  process.exit(0);
}

main().catch((e) => {
  console.error('[spike] fatal:', e);
  process.exit(1);
});
