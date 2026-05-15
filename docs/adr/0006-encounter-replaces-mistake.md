# encounter 替换 mistake — first-class learning event

**决策**：建立 `encounter` 表作为学习者与材料每次交互的 first-class entity。`outcome` enum 为 `wrong | right | exposed | created | drilled | reviewed`，覆盖错答 / 对答 / 仅暴露 / 创作 / 练习 / 复习六类语义。每种 outcome 的具体证据（错答内容、归因、artifact 引用、复习评分等）由 `evidence jsonb` 承载，**per-outcome Zod schema** 守护其形状。`material_ref jsonb` 字段以 polymorphic 方式指向被交互的材料（`question | source_document | free_text`；artifact 暂不支持，见下）。

`mistake` 表 **DROP**——其语义被 `encounter where outcome='wrong'` 完整覆盖。数据迁移在 Phase 1c.1 一次完成（每行 outcome='wrong'、evidence 重组为 `{ wrong_answer_md, wrong_answer_image_refs, cause }`）。

`artifact` 表 **同步 DROP**（零调用 verified，见 2026-05-14 audit）。`material_ref` enum **不**含 `'artifact'`——未来需要时新建表 + 加 enum value，是机械的 drizzle migration。

---

## 理由

1. **mistake 是"做错题→改对"范式的物化**。CONTEXT.md 提到的"学习内容"概念隐含错题驱动，与项目"通用学习框架"愿景冲突。encounter 把"学习行为"作为 first-class，错答只是众多 outcome 之一——同样级别还有"读过 (exposed)"、"做对 (right)"、"创作 (created)"、"练习 (drilled)"、"复习过 (reviewed)"。
2. **completion 前无真实使用数据**（2026-05-14 用户 grill）。原方案"先 lite rename，等 UI 反馈再做多态"的论据失效——反馈循环不存在。**做一次就要做对**。
3. **per-outcome evidence schema 守住 jsonb 黑洞**。参考 ADR-0002 `extraction_evidence` 模式：每种 outcome 自带 Zod schema 校验 evidence 形状；不开"什么都能塞"的口子。
4. **零调用 artifact 表 DROP** 顺手清理 schema 噪音——audit 报告标注其占用 agent context 但零产出。

---

## 接受的代价

- **1c.1 触面巨大**：~20 server / AI 文件 + ~15 test + 新增 1 张表 + DROP 2 张表。**接受**——一次做对比两次半途便宜。
- **mistake → encounter 命名变化触及 AI prompt 文案**。中文 "错题" 在 prompts 中保留语义（"做错的题"），但 LLM 拿到的 entity 名字是 encounter。**接受**——concept 与 surface form 解耦。
- **未来要 artifact 时需重建表**。**接受**——zero-call 表压在 schema 里就是死代码。

---

## 触发重新评估的条件

- `material_ref` 出现 `kind='artifact'` 的实需 → 加表 + 加 enum value，本 ADR 内承诺路径
- outcome 类型增长到 ≥10 种 → 重新审视是否该按 outcome cluster 拆模块（类似 ADR-0005 提到的 "session.ts > 500 行则按 transition cluster 拆"）
- evidence jsonb 出现"什么都塞"反模式 → 增设额外 ADR 收紧 per-outcome schema discipline

---

**相关：**
- **ADR-0002**（抽取证据 extraction_evidence）—— 本 ADR 的 evidence 设计模式参考
- **ADR-0008**（LearningSession 多态 envelope）—— 同期演化；encounter 与 learning_session 是 Phase 1c.1 双 first-class entity
- CONTEXT.md "错题（mistake）" 词条 → 本 ADR 落地后改为 "encounter (outcome='wrong')" 的语义注解
