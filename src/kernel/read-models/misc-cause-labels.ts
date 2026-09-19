// misc-cause-labels — YUK-1018 (454-A 下游): `misc_<sha256-24>` stored cause id
// 的显示回填。misc id 是已晋升 misconception 节点 id（454-A promote writer 落
// `misc_` 前缀 + caused_by edge）；渲染面（timeline / mistakes 投影 / copilot
// 工具输出）只持 id，展示层要 title——这里做读模型层 by-id 解析，id 原样保留
// 在原始字段，label 另列。kernel 不能 import capability，直查表（同
// cause-overlay.ts 读 practice 属表的先例）。

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { misconception } from '@/db/schema';

/**
 * `misc_` 命名空间——已晋升 misconception 节点 id 的前缀（454-A）。与
 * practice 侧 `MISCONCEPTION_CANDIDATE_PREFIX`（tasks/attribute-retrieve.ts）
 * 是同一个 wire 值；那里做 candidate id 生成，这里做显示解析。
 */
export const MISC_CAUSE_ID_PREFIX = 'misc_';

export function isMiscCauseId(causeId: string): boolean {
  return causeId.startsWith(MISC_CAUSE_ID_PREFIX);
}

/**
 * misc cause id → misconception title（active + unarchived only）。
 * 找不到（draft / archived / 未知 id）→ map 里缺席，调用方回退裸 id 渲染。
 * 只收 `misc_` 前缀 id——非 misc 的 cause id 词表 label 归 profile 管。
 */
export async function resolveMiscCauseLabels(
  db: Db | Tx,
  causeIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(causeIds.filter(isMiscCauseId))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: misconception.id, title: misconception.title })
    .from(misconception)
    .where(
      and(
        inArray(misconception.id, wanted),
        eq(misconception.status, 'active'),
        isNull(misconception.archived_at),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.title]));
}
