// ====================================================================
// YUK-1046 — 统一评估契约基座（五层模型 / ResponseSpec / scoring unit /
// 身份与 CAS / 未决态 / DTO 边界 / 发布 policy）
// ====================================================================
//
// 真相源：
//   - docs/planning/2026-09-24-question-assessment-implementation-grounding.md（§3–§4、§7.1）
//   - docs/planning/2026-09-24-question-assessment-decisions.md（D1–D19）
//
// 纯类型 + 确定性原语，无 IO、无 DB、无 route —— 业务接线由后续 lane 经
// 既有 capability manifest 贡献。subject-agnostic：科目专属逻辑不进本目录。

export * from './coverage';
export * from './dto';
export * from './evaluation';
export * from './execution';
export * from './ids';
export * from './judgment';
export * from './lifecycle';
export * from './materials';
export * from './pending';
export * from './publish';
export * from './response';
export * from './revision';
export * from './scoring';
export * from './settlement';
export * from './structure';
