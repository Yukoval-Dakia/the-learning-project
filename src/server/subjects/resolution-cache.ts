// YUK-598/599 — trait 装配溯源缓存（db-free 轻模块）。
//
// hydrate.ts（重模块：拖 db/client）是唯一写者；读者（GET /api/subjects 的
// isGeneralFallback 派生、YUK-601 §3.5 管理读面）只需这份内存缓存——拆成
// 无 db 依赖的独立模块，路由 handler / unit 测试不必为读一个 Map 拖起整条
// postgres import 链。每轮 hydrate 整体换 Map 引用（不改旧对象——in-flight
// 已捕获引用天然稳定，v3 §5.1）。

import type { TraitVersionComponent } from '@/subjects/trait-compose';
import type { SubjectTraitKind } from '@/subjects/trait-schemas';

export type TraitDegradation = 'journal_fallback' | 'code_seed' | null;

// per (subject, kind) 的装配溯源——revision（live）vs effective（实际采用）vs
// degraded 的三元事实；D6 provenance 与管理读面共用。
export interface TraitResolution {
  kind: SubjectTraitKind;
  traitId: string;
  origin: 'builtin' | 'custom';
  ownerSubjectId: string | null;
  seedVersion: string | null;
  liveRevision: number;
  effective: TraitVersionComponent['effective'];
  degraded: TraitDegradation;
}

let traitResolutions = new Map<string, TraitResolution[]>();

export function getSubjectTraitResolutions(): ReadonlyMap<string, TraitResolution[]> {
  return traitResolutions;
}

// 唯一写者 = hydrate（每轮整体替换）。
export function replaceSubjectTraitResolutions(next: Map<string, TraitResolution[]>): void {
  traitResolutions = next;
}

// YUK-598（v3 §2.3）— isGeneralFallback 派生（不落列）：≡ 六绑定全部指向 general
// 的种子 trait（按 trait **身份**判定，不比内容——owner 编辑过 general 后未 fork
// 的科目仍为真：它们确实在活跟随，这正是标签的诚实语义）。general 自身豁免
// （对自己恒真是语义噪音）→ null。无水合溯源的科目（代码地板 builtin / 未水合）
// → false（builtin 绑自己的种子，天然非 fallback）。
export function isGeneralFallbackFor(subjectId: string): boolean | null {
  if (subjectId === 'general') return null;
  const res = traitResolutions.get(subjectId);
  if (!res || res.length === 0) return false;
  return res.every((r) => r.traitId.startsWith('trt_seed_general_'));
}
