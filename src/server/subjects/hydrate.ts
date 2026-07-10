// YUK-599 (YUK-597 v3 trait 合同 §2.2 + v2 §4 承接) — 装配水合：DB 六表 → 内存
// SubjectRegistry。server-only（红线：profile.ts 被浏览器 import，不得引 db/client；
// 水合逻辑因此住这里）。
//
// 合同要点：
// - hydrate-before-serve / worker 首 job 前（boot 接线在 server/index.ts /
//   start-worker.ts）；worker 另挂 startSubjectRefresh 60s 周期全量 reconcile
//   （level-triggered，是承重路径不是兜底——判词 B，LISTEN/NOTIFY 否决）。
// - **never-throws 失败矩阵**（v2 §4.4）：表缺席（42P01）/ DB down / 坏行，全部
//   WARN + 保持现状（四代码种子是地板，registry 构造器已注册）——绝不炸进程。
// - 加载**全部 subject 行含 retired**（resolvable-all：retired 科目不掉线，旧数据/
//   event/domain 串永不悬垂；selectable 过滤是 YUK-598 的读面事）。
// - **alias 水合**：JOIN subject_name_claim kind='alias' 传入 upsert——丢这步 =
//   wenyan→yuwen 等 legacy 别名全体 miss（KILL-1 回归，直测钉死）。
// - **坏行降级链（每 trait 独立，v3 §2.2）**：① 运行期 = registry 保内存 last-good
//   （本轮该科 skip，不 remove）；② 冷启动 = journal 按 revision 降序回溯第一条
//   safeParse 通过的历史 payload（journal 兼任快照仓）；③ journal 空/全坏：种子
//   血统 trait（seed_version 非空）→ BUILTIN_TRAIT_SEEDS 代码种子；custom/fork
//   trait 坏死按**绑定者 origin** 收口——builtin 科目整科回 import-time 代码
//   profile（四 builtin 地板不可破），custom 科目本轮装配缺席。
// - **降级态 version = effective 身份**（v3 §2.1④）：journal 回溯 → id@<该 rev>；
//   代码种子 → id@seed:<seedVersion>——D6 章永远指向真实生效的配置。
// - reconcileCustomIds 防御网：内存 custom id 不在本轮 DB 行集 → 摘除（唯一真实
//   触发 = restore 使行集收缩）；builtin 四种子永不摘。

import { db as defaultDb } from '@/db/client';
import {
  subject,
  subject_name_claim,
  subject_trait,
  subject_trait_binding,
  subject_trait_journal,
} from '@/db/schema';
import { BUILTIN_SUBJECT_IDS, BUILTIN_TRAIT_SEEDS } from '@/subjects/builtin-trait-seeds';
import {
  type SubjectRegistry,
  getDefaultSubjectRegistry,
  subjectProfiles,
} from '@/subjects/profile';
import {
  type TraitVersionComponent,
  assembleSubjectProfile,
  composeJudgeTraitVersion,
} from '@/subjects/trait-compose';
import {
  SUBJECT_TRAIT_KINDS,
  type SubjectTraitKind,
  type SubjectTraitPayloads,
  TRAIT_PAYLOAD_SCHEMAS,
} from '@/subjects/trait-schemas';
import { desc, eq } from 'drizzle-orm';
import { type TraitResolution, replaceSubjectTraitResolutions } from './resolution-cache';

// 缓存与派生的权威在 resolution-cache.ts（db-free）；这里 re-export 维持既有
// import 面（hydrate.db.test / 管理读面）不破。
export {
  getSubjectTraitResolutions,
  isGeneralFallbackFor,
  type TraitDegradation,
  type TraitResolution,
} from './resolution-cache';

type Db = typeof defaultDb;

const BUILTIN_ID_SET: ReadonlySet<string> = new Set<string>(BUILTIN_SUBJECT_IDS);

export interface HydrationReport {
  hydrated: string[];
  builtinFloor: string[]; // custom trait 坏死收口回代码 profile 的 builtin 科目
  skipped: Array<{ subjectId: string; reason: string }>;
  removed: string[]; // reconcileCustomIds 摘除的 custom id
}

function parseSeedSubjectFromTraitId(traitId: string): string | null {
  for (const sid of BUILTIN_SUBJECT_IDS) {
    for (const kind of SUBJECT_TRAIT_KINDS) {
      if (traitId === `trt_seed_${sid}_${kind}`) return sid;
    }
  }
  return null;
}

interface TraitRow {
  id: string;
  trait_kind: string;
  origin: 'builtin' | 'custom';
  payload: unknown;
  seed_version: string | null;
  owner_subject_id: string | null;
  revision: number;
}

// 单 trait 的降级链解析。返回 null = custom trait 坏死（收口交给调用方按绑定者
// origin 分流）。journal 回溯逐行读（revision desc），第一条 safeParse 通过即取。
async function resolveTraitPayload(
  db: Db,
  kind: SubjectTraitKind,
  row: TraitRow,
): Promise<{ payload: unknown; resolution: TraitResolution } | null> {
  const schema = TRAIT_PAYLOAD_SCHEMAS[kind];
  const base: Omit<TraitResolution, 'effective' | 'degraded'> = {
    kind,
    traitId: row.id,
    origin: row.origin,
    ownerSubjectId: row.owner_subject_id,
    seedVersion: row.seed_version,
    liveRevision: row.revision,
  };

  const live = schema.safeParse(row.payload);
  if (live.success) {
    return {
      payload: live.data,
      resolution: { ...base, effective: row.revision, degraded: null },
    };
  }
  console.warn('[subjects] trait live payload failed schema — entering degradation chain', {
    traitId: row.id,
    kind,
    issues: live.error.issues.slice(0, 3),
  });

  // ② journal 回溯：revision 降序第一条合法快照（journal 行是完整状态快照，v3.1）。
  const journalRows = await db
    .select({
      revision: subject_trait_journal.revision,
      payload: subject_trait_journal.payload,
    })
    .from(subject_trait_journal)
    .where(eq(subject_trait_journal.trait_id, row.id))
    .orderBy(desc(subject_trait_journal.revision));
  for (const j of journalRows) {
    const parsed = schema.safeParse(j.payload);
    if (parsed.success) {
      return {
        payload: parsed.data,
        resolution: { ...base, effective: j.revision, degraded: 'journal_fallback' },
      };
    }
  }

  // ③ 代码种子（仅种子血统 trait）：合成身份 seed:<seedVersion>。
  if (row.seed_version !== null) {
    const seedSubject = parseSeedSubjectFromTraitId(row.id);
    if (seedSubject) {
      const seed = BUILTIN_TRAIT_SEEDS[seedSubject as (typeof BUILTIN_SUBJECT_IDS)[number]][kind];
      console.warn('[subjects] trait degraded to code seed', { traitId: row.id, kind });
      return {
        payload: seed.payload,
        resolution: {
          ...base,
          effective: `seed:${seed.seedVersion}`,
          degraded: 'code_seed',
        },
      };
    }
  }
  return null; // custom/fork trait 坏死 → 调用方按绑定者 origin 收口
}

export async function hydrateSubjectRegistryFromDb(
  db: Db = defaultDb,
  registry: SubjectRegistry = getDefaultSubjectRegistry(),
): Promise<HydrationReport> {
  const report: HydrationReport = { hydrated: [], builtinFloor: [], skipped: [], removed: [] };
  try {
    const [subjectRows, bindingRows, traitRows, aliasRows] = await Promise.all([
      db.select().from(subject),
      db.select().from(subject_trait_binding),
      db.select().from(subject_trait),
      db.select().from(subject_name_claim).where(eq(subject_name_claim.kind, 'alias')),
    ]);

    const traitById = new Map(traitRows.map((t) => [t.id, t as TraitRow]));
    const bindingsBySubject = new Map<string, Map<SubjectTraitKind, string>>();
    for (const b of bindingRows) {
      const m = bindingsBySubject.get(b.subject_id) ?? new Map<SubjectTraitKind, string>();
      m.set(b.trait_kind as SubjectTraitKind, b.trait_id);
      bindingsBySubject.set(b.subject_id, m);
    }
    const aliasesBySubject = new Map<string, string[]>();
    for (const a of aliasRows) {
      aliasesBySubject.set(a.subject_id, [
        ...(aliasesBySubject.get(a.subject_id) ?? []),
        a.name_norm,
      ]);
    }

    const nextResolutions = new Map<string, TraitResolution[]>();
    const seenIds = new Set<string>();

    for (const row of subjectRows) {
      seenIds.add(row.id);
      const bindings = bindingsBySubject.get(row.id);
      const resolutions: TraitResolution[] = [];
      const payloads: Partial<Record<SubjectTraitKind, unknown>> = {};
      let dead: string | null = null;

      for (const kind of SUBJECT_TRAIT_KINDS) {
        const traitId = bindings?.get(kind);
        const traitRow = traitId ? traitById.get(traitId) : undefined;
        if (!traitRow) {
          dead = `binding/trait missing for kind '${kind}'`;
          break;
        }
        const resolved = await resolveTraitPayload(db, kind, traitRow);
        if (!resolved) {
          dead = `trait '${traitRow.id}' (${kind}) unrecoverable`;
          break;
        }
        payloads[kind] = resolved.payload;
        resolutions.push(resolved.resolution);
      }

      if (dead) {
        if (BUILTIN_ID_SET.has(row.id)) {
          // 四 builtin 地板：即便绑了 custom trait 且坏死，整科**显式**回
          // import-time 代码 profile——不是 last-good（暖轮里内存可能还持着上一轮
          // DB 装配），地板语义是确定性回代码（v3 §2.2 / §8-27）。
          const floor = subjectProfiles[row.id];
          if (floor) {
            registry.upsert(floor, [], {
              throwOnInvalid: false,
              // 地板态元数据同样确定性回 builtin 默认（general 结构性排除保持）。
              meta: {
                isBuiltin: true,
                isSelectable: row.id !== 'general' && row.is_selectable,
                retiredAt: row.retired_at,
              },
            });
          }
          console.warn('[subjects] builtin subject fell back to import-time code profile', {
            subjectId: row.id,
            reason: dead,
          });
          report.builtinFloor.push(row.id);
        } else {
          // custom 科目本轮缺席；不 remove（运行期 last-good：已在内存的旧装配保留）。
          console.warn('[subjects] custom subject skipped this hydration round', {
            subjectId: row.id,
            reason: dead,
          });
          report.skipped.push({ subjectId: row.id, reason: dead });
        }
        continue;
      }

      const byKind = new Map(resolutions.map((r) => [r.kind, r]));
      const comp = (k: SubjectTraitKind): TraitVersionComponent => {
        // biome-ignore lint/style/noNonNullAssertion: 六 kind 全部 resolve 才走到这
        const r = byKind.get(k)!;
        return { traitId: r.traitId, effective: r.effective };
      };
      const profile = assembleSubjectProfile({
        id: row.id,
        displayName: row.display_name,
        version: composeJudgeTraitVersion({
          charter: comp('charter'),
          judge_policy: comp('judge_policy'),
          cause_taxonomy: comp('cause_taxonomy'),
          source_policy: comp('source_policy'),
        }),
        payloads: payloads as unknown as SubjectTraitPayloads,
      });

      const result = registry.upsert(profile, aliasesBySubject.get(row.id) ?? [], {
        throwOnInvalid: false, // 坏装配 skip+WARN 不炸进程（never-throws 矩阵）
        // YUK-598 三集合元数据：DB 行是权威（general 的结构性排除也随行——
        // reconcile 落 is_selectable=false）。
        meta: {
          isBuiltin: row.origin === 'builtin',
          isSelectable: row.is_selectable,
          retiredAt: row.retired_at,
        },
      });
      if (result.valid) {
        report.hydrated.push(row.id);
        nextResolutions.set(row.id, resolutions);
      } else {
        console.warn('[subjects] assembled profile failed validateProfile — keeping last-good', {
          subjectId: row.id,
          errors: result.errors.slice(0, 3),
        });
        report.skipped.push({ subjectId: row.id, reason: 'validateProfile failed' });
      }
    }

    // reconcileCustomIds 防御网：内存 custom 不在 DB 行集 → 摘除；builtin 永不摘。
    for (const id of registry.listIds()) {
      if (BUILTIN_ID_SET.has(id)) continue;
      if (!seenIds.has(id)) {
        registry.remove(id);
        report.removed.push(id);
        console.warn(
          '[subjects] removed stale custom subject from registry (restore shrank rows?)',
          {
            subjectId: id,
          },
        );
      }
    }

    replaceSubjectTraitResolutions(nextResolutions); // 换引用不改旧对象（v3 §5.1）
    return report;
  } catch (err) {
    // 42P01（表未建）/ DB down / 任意异常：WARN + 现状即地板（四代码种子恒在）。
    console.warn('[subjects] hydration failed — registry keeps code-seed floor / last-good', err);
    return report;
  }
}

// worker 60s 周期全量 reconcile（level-triggered 承重路径；app 侧写后即时重装由
// YUK-600/601 写面接）。unref 不阻退出；返回句柄供 shutdown clearInterval。
export function startSubjectRefresh(db: Db = defaultDb, intervalMs = 60_000): { stop: () => void } {
  const timer = setInterval(() => {
    void hydrateSubjectRegistryFromDb(db).catch(() => {
      // hydrate 自身 never-throws；这层 catch 只是双保险。
    });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
