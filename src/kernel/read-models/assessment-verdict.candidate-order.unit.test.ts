// YUK-1106 — candidate 返回顺序确定性回归（SQL seam 级，无 DB）。
//
// 原 RED（CI run 36444482025，head f91d47c，DB shard 2/4）：
// assessment-verdict.db.test.ts:332 expected 'j_old' got 'j_new' —— 只读诊断定位
// judgeCandidatesForAttempts（无 ORDER BY）返回顺序 + 聚合 338-340 行「两个候选
// 最终 resolve 到同一 effective 行时 comparison 必不更新、先出现者 truth 保留」
// ⇒ effective.original_event_id 取决于 DB 堆序。
//
// 本测试复刻该诊断方法：reader / getEffectiveTruths 链 / getCorrectionStatuses /
// newerEventRow 比较器全部**未 mock、跑真实现**，唯一替换的是存储层——一个按
// drizzle 谓词形状分派的内存 seam db，其中 bySubject 候选查询的返回顺序可正可
// 逆（各 100 次）。修复前：逆序 RED（j_new 自链 truth 先到）；修复后：两序同果
// （j_old 链来源保留，effective 行仍 j_new）。
import { describe, expect, it } from 'vitest';
import type { Tx } from '@/db/client';
// @/db/schema 仅类型面（typeof event.$inferSelect）：unit 分区审计按文件级
// DB import 判 P0，type-only import 运行时擦除、不引入 DB 依赖。
import type { event as eventTable } from '@/db/schema';

import { resolveVerdictsForAttempts } from './assessment-verdict';

// ---------- fixture（与 assessment-verdict.db.test.ts 申诉重判用例同形状） ----------

type EventRow = typeof eventTable.$inferSelect;

const T0 = new Date('2026-09-26T00:00:00Z');
const T1 = new Date('2026-09-26T00:01:00Z');
const T2 = new Date('2026-09-26T00:02:00Z');

function row(
  partial: Partial<EventRow> &
    Pick<EventRow, 'id' | 'action' | 'subject_kind' | 'subject_id' | 'created_at'>,
): EventRow {
  return {
    actor_kind: 'agent',
    actor_ref: 'seem',
    outcome: 'success',
    payload: {},
    caused_by_event_id: null,
    dispatch_seq: 0,
    task_run_id: null,
    cost_micro_usd: null,
    ingest_at: null,
    ...partial,
  } as EventRow;
}

function buildFixture(): EventRow[] {
  return [
    row({
      id: 'att_2',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_att_2',
      outcome: 'failure',
      payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: [] },
      created_at: T0,
    }),
    row({
      id: 'j_old',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'att_2',
      caused_by_event_id: 'att_2',
      payload: {
        cause: {
          primary_category: 'other',
          secondary_categories: [],
          analysis_md: '<test>',
          confidence: 0.9,
        },
        referenced_knowledge_ids: ['kc_a'],
        coarse_outcome: 'incorrect',
        score: 0.1,
        feedback_md: 'fb_j_old',
      },
      created_at: T1,
    }),
    row({
      id: 'appeal_1',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:appeal_request',
      subject_kind: 'event',
      subject_id: 'j_old',
      outcome: null,
      payload: { reason_md: '判错了' },
      created_at: T2,
    }),
    row({
      id: 'j_new',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'att_2',
      caused_by_event_id: 'appeal_1',
      actor_ref: 'rejudge',
      payload: {
        cause: {
          primary_category: 'other',
          secondary_categories: [],
          analysis_md: '<test>',
          confidence: 0.9,
        },
        referenced_knowledge_ids: ['kc_a'],
        coarse_outcome: 'correct',
        score: 0.95,
        feedback_md: 'fb_j_new',
        appeal_event_id: 'appeal_1',
      },
      created_at: T2,
    }),
    row({
      id: 'corr_1',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'j_old',
      payload: {
        correction_kind: 'supersede',
        replacement_event_id: 'j_new',
        reason_md: 'test correction',
        affected_refs: [{ kind: 'question', id: 'q' }],
      },
      caused_by_event_id: 'j_new',
      created_at: T2,
    }),
  ];
}

// ---------- in-memory SQL seam db ----------
//
// 只实现 legacy 读面真实触发的三类 event 查询，按 drizzle 谓词的列集合分派；
// 未识别的形状直接 throw（reader 查询面变化时显式失败，不静默错 seaming）。
// bySubject（候选拉取）是唯一的顺序控制点：candidateOrder 决定返回顺序。

interface DecodedPredicate {
  columns: Set<string>;
  params: unknown[];
}

/** 鸭子类型解析 drizzle 谓词块（跨构建器/转换器稳定的形状，不依赖 ctor 名）：
 * SQL（queryChunks 递归）/ StringChunk（纯 string value，跳过）/ Param
 * （value+encoder → 绑定值）/ Column（name+table → 列名）/ Array
 * （inArray 的值数组 → 元素为参数）。 */
function decodeChunks(chunks: readonly unknown[], out: DecodedPredicate): void {
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') {
      if (chunk !== undefined) out.params.push(chunk);
      continue;
    }
    if (Array.isArray(chunk)) {
      decodeChunks(chunk, out);
      continue;
    }
    const record = chunk as Record<string, unknown>;
    if (Array.isArray(record.queryChunks)) {
      decodeChunks(record.queryChunks as readonly unknown[], out);
      continue;
    }
    if (typeof record.name === 'string' && 'table' in record && 'primary' in record) {
      out.columns.add(record.name);
      continue;
    }
    if ('encoder' in record && 'value' in record) {
      out.params.push(record.value);
      continue;
    }
    if (typeof record.value === 'string') {
    }
  }
}

function decodePredicate(predicate: unknown): DecodedPredicate {
  const out: DecodedPredicate = { columns: new Set(), params: [] };
  const chunks = (predicate as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) {
    throw new Error('seam db: predicate without queryChunks');
  }
  decodeChunks(chunks, out);
  if (out.columns.size === 0) {
    throw new Error('seam db: unrecognized predicate shape (no columns)');
  }
  return out;
}

class SeamDb {
  constructor(
    private readonly store: EventRow[],
    private readonly candidateOrder: 'forward' | 'reverse',
  ) {}

  select(fields?: unknown): {
    from: () => {
      where: (
        p: unknown,
      ) => Promise<unknown[]> & { orderBy: (...o: unknown[]) => Promise<unknown[]> };
    };
  } {
    return {
      from: () => ({
        where: (predicate: unknown) => {
          const result = this.runQuery(fields, predicate);
          // drizzle builder 形态：真 Promise 上附加 orderBy（getCorrectionStatuses
          // 会追 orderBy；顺序对语义无关——corrections 归 Map，链上直接兑现）。
          const builder = Promise.resolve(result) as Promise<unknown[]> & {
            orderBy: (..._order: unknown[]) => Promise<unknown[]>;
          };
          builder.orderBy = () => result;
          return builder;
        },
      }),
    };
  }

  private runQuery(fields: unknown, predicate: unknown): Promise<unknown[]> {
    const decoded = decodePredicate(predicate);
    const cols = decoded.columns;
    const params = decoded.params.map((v) => String(v));

    const project = (r: EventRow): unknown => (fields !== undefined ? { id: r.id } : r);

    if (cols.size === 1 && cols.has('id')) {
      // rowsById / getEffectiveTruths 存在性检查：inArray(event.id, ids)
      const ids = new Set(params);
      return Promise.resolve(this.store.filter((r) => ids.has(r.id)).map(project));
    }

    if (cols.has('action') && cols.has('subject_kind') && cols.has('subject_id')) {
      const action = params[0];
      const ids = new Set(params.slice(2));
      if (action === 'judge') {
        // ★ 顺序 seam：bySubject 候选查询——顺序完全由 candidateOrder 决定。
        const judges = this.store.filter(
          (r) => r.action === 'judge' && ids.has(String(r.subject_id)),
        );
        const ordered = this.candidateOrder === 'reverse' ? [...judges].reverse() : judges;
        return Promise.resolve(ordered);
      }
      if (action === 'correct') {
        // getCorrectionStatuses：correct 行按 subject_id 拉取（顺序无关——
        // getCorrectionStatuses 按 id 归 Map）。
        return Promise.resolve(
          this.store.filter((r) => r.action === 'correct' && ids.has(String(r.subject_id))),
        );
      }
      throw new Error(`seam db: unexpected action filter ${action}`);
    }

    if (cols.has('action') && cols.has('subject_kind') && cols.has('caused_by_event_id')) {
      const ids = new Set(params.slice(2));
      return Promise.resolve(
        this.store.filter(
          (r) =>
            r.action === 'judge' && r.caused_by_event_id !== null && ids.has(r.caused_by_event_id),
        ),
      );
    }

    throw new Error(`seam db: unrecognized query columns [${[...cols].join(',')}]`);
  }
}

// 断言核心期望（与 assessment-verdict.db.test.ts:324-334 同一套业务语义）。
function expectAppealRejudgeVerdict(
  v: ReturnType<typeof resolveVerdictsForAttempts> extends Promise<Map<string, infer V>>
    ? V
    : never,
): void {
  // original = 历史第一判（即使已被 supersede）。
  expect(v.original?.judge_event_id).toBe('j_old');
  expect(v.original?.correction_state.state).toBe('superseded');
  // effective = 链端新判，但**链来源保留 j_old**（YUK-1106 的核心钉）。
  expect(v.effective?.judge_event_id).toBe('j_new');
  expect(v.effective?.verdict.coarse_outcome).toBe('correct');
  expect(v.effective?.verdict.appeal_event_id).toBe('appeal_1');
  expect(v.effective?.original_event_id).toBe('j_old');
  expect(v.newest_raw?.judge_event_id).toBe('j_new');
}

type AttemptVerdict = Parameters<typeof expectAppealRejudgeVerdict>[0];

describe('assessment-verdict — candidate return-order determinism (YUK-1106)', () => {
  it('forward candidate order (j_old first): j_old provenance is preserved', async () => {
    const db = new SeamDb(buildFixture(), 'forward') as unknown as Tx;
    const v = (await resolveVerdictsForAttempts(db, ['att_2'])).get('att_2');
    if (!v) throw new Error('missing att_2 verdict');
    expectAppealRejudgeVerdict(v as AttemptVerdict);
  });

  it('REGRESSION (RED on the unsorted reader): reverse candidate order must yield the SAME j_old provenance', async () => {
    // 原 bug 的确定性复现：候选 bySubject 查询返回 j_new 在前时，j_new 的自链
    // truth 先占据 acc.effective，j_old 候选随后 resolve 到同一 effective 行
    // （comparison 必不更新）⇒ effective.original_event_id 错成 j_new。
    const db = new SeamDb(buildFixture(), 'reverse') as unknown as Tx;
    const v = (await resolveVerdictsForAttempts(db, ['att_2'])).get('att_2');
    if (!v) throw new Error('missing att_2 verdict');
    expectAppealRejudgeVerdict(v as AttemptVerdict);
  });

  it('100 iterations each direction stay identical (order-independence after the fix)', async () => {
    for (let i = 0; i < 100; i++) {
      for (const order of ['forward', 'reverse'] as const) {
        const db = new SeamDb(buildFixture(), order) as unknown as Tx;
        const v = (await resolveVerdictsForAttempts(db, ['att_2'])).get('att_2');
        if (!v) throw new Error(`missing att_2 verdict (order=${order}, i=${i})`);
        expect(v.effective?.original_event_id, `order=${order} i=${i}`).toBe('j_old');
        expect(v.effective?.judge_event_id, `order=${order} i=${i}`).toBe('j_new');
      }
    }
  });
});
