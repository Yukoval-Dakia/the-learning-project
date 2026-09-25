import { z } from 'zod';

// ====================================================================
// YUK-1046 — 统一评估契约 · 共享刺激材料与原始证据（grounding §7.2 / D10）
// ====================================================================
//
// 两个正交概念，不要合并：
//   - SharedMaterial：题目【发出】的刺激材料/图表（卷面的一部分，随 revision
//     版本化；判分与学生所见引用同版资产，§7.2）。
//   - EvidenceAttachment：学习者【提交】的原始证据附件（D10：image 之外扩展
//     audio/video/PDF/plaintext，与 image 并列；full release，不做 image-only
//     fallback）。
//
// D10 边界：只做上传 + 安全播放/下载 + format/size/security 校验；
// 不做录音工作站 / 代码执行 / 媒体编辑器。`voice` 之类的 enum 不冒充
// ASR/口语评分完成 —— 若题目要求音高/发音/时序等原媒体证据，执行计划必须
// 具备能力或明确 needs_review；转写不能冒充原媒体。

/** 刺激材料种类。开放集合语义上足够通用（figure/passage/table/音视频/PDF/纯文本）。 */
export const SharedMaterialKind = z.enum([
  'figure',
  'passage',
  'table',
  'audio',
  'video',
  'pdf',
  'plaintext',
]);
export type SharedMaterialKindT = z.infer<typeof SharedMaterialKind>;

/** 版本化资产引用：asset_id + 内容 digest。判分引用与呈现引用必须命中同版。 */
export const VersionedAssetRef = z.object({
  asset_id: z.string().min(1),
  digest: z.string().min(1),
});
export type VersionedAssetRefT = z.infer<typeof VersionedAssetRef>;

/**
 * 共享刺激材料。material_id 在 group 内稳定；语义不变时保留身份，
 * 语义替换生成新身份与映射（§3.1 —— 禁止按 label/相同文本自动认定连续）。
 */
export const SharedMaterial = z.object({
  material_id: z.string().min(1),
  kind: SharedMaterialKind,
  asset: VersionedAssetRef,
  caption: z.string().optional(),
  /** 可读替代说明（§7.2 —— 独立材料渲染、缩放、可读替代）。 */
  alt_text: z.string().optional(),
  /** YUK-1043（复审 P1-2a）：文本类材料的【字节】随 revision 内联持久化 ——
   * 不可变 revision 必须能自恢复共享段落，不能只留 txt_<hash> 引用而内容
   * 无处可寻。figure 等二进制资产走 asset store（asset_id + 实内容 digest）；
   * 纯文本材料的 content 即资产本身。进入 structure ⇒ 自动入 integrity digest。 */
  content_md: z.string().optional(),
});
export type SharedMaterialT = z.infer<typeof SharedMaterial>;

// ---------- D10 原始证据 ----------

/** D10 原始证据种类：image 与 audio/video/pdf/plaintext 并列。 */
export const EvidenceKind = z.enum(['image', 'audio', 'video', 'pdf', 'plaintext']);
export type EvidenceKindT = z.infer<typeof EvidenceKind>;

/** MIME 通配规则（如 'image/*'、'application/pdf'）。保守由校验层消费。 */
export const MimePattern = z.string().min(3);
export type MimePatternT = z.infer<typeof MimePattern>;

/** 单类证据的接收政策：format/size/security 校验的发布侧声明（D10）。 */
export const EvidenceAcceptanceRule = z.object({
  kind: EvidenceKind,
  allowed_mime_patterns: z.array(MimePattern).min(1),
  /** 上界字节；0 无意义，禁用该类证据直接不列规则。 */
  max_bytes: z.number().int().min(1),
  requires_security_scan: z.boolean(),
});
export type EvidenceAcceptanceRuleT = z.infer<typeof EvidenceAcceptanceRule>;

/** 学习者提交的原始证据附件。evidence_id 在 submission 内唯一。 */
export const EvidenceAttachment = z.object({
  evidence_id: z.string().min(1),
  kind: EvidenceKind,
  asset: VersionedAssetRef,
  mime_type: z.string().min(3),
  bytes: z.number().int().min(0),
  uploaded_at: z.string().datetime(),
});
export type EvidenceAttachmentT = z.infer<typeof EvidenceAttachment>;
