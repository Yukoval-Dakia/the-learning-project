// ADR-0072 D2 — 版本化题库内容引用（bank ref）。
//
// ref 指向不可变 `question_revision` 行，绝不指向可变指针（question 行 /
// question_group_lifecycle）。语法：
//
//   qrev1:<revision_id>:<integrity_digest hex 前 12 位>
//
// - revision_id：question_revision 主键（发布 seam 铸造，不可变，cuid）。
// - digest 前缀：同行 integrity_digest（`sha256:<64hex>`）的 hex 前 12 位。
//   读取不可变行后核对 digest 前缀，发现 ref 抄写/换 target 错位。
// - `qrev1` 版本号留给 migration 线重键（ADR-0072 未决问题 1）；携带 digest
//   使任何未来映射仍可验证内容身份。
//
// 解析语义（硬边界 3）：查无此行 → unresolvable；digest 前缀不符 →
// digest_mismatch（过期/错引，显式错误，绝不回退 latest）；lifecycle
// withdrawn → withdrawn。suspended 不拦读取，由调用方如实报告状态。
//
// 单题 = 1-part 组（YUK-1043 §3.1），question 与 group 共用组版本语法；
// kind（question/group）由 revision 形状派生，不进 ref。

import { inArray } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { question_group_lifecycle, question_revision } from '@/db/schema';

export const BANK_REF_VERSION = 'qrev1' as const;

/** integrity_digest hex 前缀长度（48 bit —— 抄写/错位检测，非密码学完整防线）。 */
export const BANK_REF_DIGEST_PREFIX_LEN = 12;

export interface ParsedBankRef {
  revisionId: string;
  digestPrefix: string;
}

/** digest 列形如 `sha256:<hex>`；取 hex 部分前缀。 */
export function bankRefDigestPrefix(integrityDigest: string): string {
  const hex = integrityDigest.startsWith('sha256:') ? integrityDigest.slice(7) : integrityDigest;
  return hex.slice(0, BANK_REF_DIGEST_PREFIX_LEN);
}

export function encodeBankRef(revisionId: string, integrityDigest: string): string {
  return `${BANK_REF_VERSION}:${revisionId}:${bankRefDigestPrefix(integrityDigest)}`;
}

/** 解析 ref 字符串。返回 null = 语法不合法（调用方按 unresolvable 报告并说明原因）。 */
export function parseBankRef(raw: string): ParsedBankRef | null {
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [version, revisionId, digestPrefix] = parts;
  if (version !== BANK_REF_VERSION) return null;
  if (!/^[a-z0-9]{10,}$/.test(revisionId)) return null;
  if (!/^[0-9a-f]{12}$/.test(digestPrefix)) return null;
  return { revisionId, digestPrefix };
}

export type BankRefRevisionRow = typeof question_revision.$inferSelect;

export type BankRefLifecycleRow = typeof question_group_lifecycle.$inferSelect;

export type BankRefResolution =
  | {
      raw: string;
      status: 'ok';
      revision: BankRefRevisionRow;
      lifecycle: BankRefLifecycleRow | null;
    }
  | {
      raw: string;
      status: 'unresolvable' | 'digest_mismatch' | 'withdrawn';
      /** 诊断说明（进工具响应/测试断言，不外抛）。 */
      detail: string;
    };

/**
 * 批量解析 refs。每个 ref 独立成败（部分成功合法），顺序与输入一致。
 * 一次查询 revision + lifecycle，批量无 N+1。
 */
export async function resolveBankRefs(db: Db, rawRefs: string[]): Promise<BankRefResolution[]> {
  const parsed = rawRefs.map((raw) => ({ raw, parsed: parseBankRef(raw) }));

  const revisionIds = [
    ...new Set(parsed.filter((p) => p.parsed != null).map((p) => p.parsed?.revisionId ?? '')),
  ].filter((id) => id.length > 0);

  const revisionsById = new Map<string, BankRefRevisionRow>();
  const lifecyclesByGroup = new Map<string, BankRefLifecycleRow>();
  if (revisionIds.length > 0) {
    const revisionRows = await db
      .select()
      .from(question_revision)
      .where(inArray(question_revision.revision_id, revisionIds));
    for (const row of revisionRows) revisionsById.set(row.revision_id, row);
    const groupIds = [...new Set(revisionRows.map((r) => r.group_id))];
    if (groupIds.length > 0) {
      const lifecycleRows = await db
        .select()
        .from(question_group_lifecycle)
        .where(inArray(question_group_lifecycle.group_id, groupIds));
      for (const row of lifecycleRows) lifecyclesByGroup.set(row.group_id, row);
    }
  }

  return parsed.map(({ raw, parsed: p }) => {
    if (p == null) {
      return {
        raw,
        status: 'unresolvable' as const,
        detail: `ref is not a valid ${BANK_REF_VERSION} bank ref`,
      };
    }
    const revision = revisionsById.get(p.revisionId);
    if (revision == null) {
      return {
        raw,
        status: 'unresolvable' as const,
        detail: `revision '${p.revisionId}' not found`,
      };
    }
    if (bankRefDigestPrefix(revision.integrity_digest) !== p.digestPrefix) {
      return {
        raw,
        status: 'digest_mismatch' as const,
        detail: `ref digest prefix '${p.digestPrefix}' does not match revision integrity digest '${revision.integrity_digest}'`,
      };
    }
    const lifecycle = lifecyclesByGroup.get(revision.group_id) ?? null;
    if (lifecycle?.withdrawn === true) {
      return {
        raw,
        status: 'withdrawn' as const,
        detail: `group '${revision.group_id}' is withdrawn (archived); the revision content is immutable but the group is no longer served`,
      };
    }
    return { raw, status: 'ok' as const, revision, lifecycle };
  });
}

/** 单 ref 解析（read/check 的便捷入口；批量路径用 resolveBankRefs）。 */
export async function resolveBankRef(db: Db, raw: string): Promise<BankRefResolution> {
  const [resolution] = await resolveBankRefs(db, [raw]);
  return resolution;
}

/** read/check 共用的 revision 形状派生 kind：>1 part（已有题组）→ group，否则 question。
 * （D2：group = 父题 + part 的既有分组；单题带共享材料仍是单题。） */
export function bankRefObjectKind(revision: BankRefRevisionRow): 'question' | 'group' {
  const parts = revision.structure?.parts ?? [];
  return parts.length > 1 ? 'group' : 'question';
}

/** Revision digests are sha256-prefixed; storage hashes may be bare hex. */
export function bankAssetDigestMatches(stored: string, revision: string): boolean {
  const bare = (value: string) => value.replace(/^sha256:/, '');
  return (
    /^[a-f0-9]{64}$/.test(bare(stored)) &&
    /^[a-f0-9]{64}$/.test(bare(revision)) &&
    bare(stored) === bare(revision)
  );
}
