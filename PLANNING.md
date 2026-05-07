# AI 学习工具 · 规划主索引

> 自用 · 移动 + 桌面双修 · 应试与兴趣并行
> v0.5 · 2026-05-08 · 加入 Quiz 子系统 + Cluster 决议落地

---

## 定位

不是「错题本 + 进度统计 + 笔记工具」三件套的拼盘，而是围绕**知识点图谱**这一根锚组织起来的个人学习系统。

错题、进度、artifact 都是知识点的不同切面：
- 错题 = 知识点上「失败的尝试」
- 进度 = 知识点上「掌握度的演化」
- artifact = 知识点上「可被反复消费的产物」

只要锚不丢，模块就不会变成孤岛。**架构是泛化的**，不锁单一学科或场景；**Phase 1 首发数据集 = 文言文（高中语文）**，理由是它逼出 4 种 judge_kind 的多样性。

---

## 文档结构

```
the-learning-project/
├── PLANNING.md                     # 本文件 — 总览、模块速览、路线图、待决策汇总
└── docs/
    ├── architecture.md             # 跨模块基础：知识图谱 / AI 角色 / AI 任务层 / 技术栈 / 数据模型
    └── modules/
        ├── mistakes.md             # 错题管理
        ├── learning-items.md       # 待学习列表
        ├── progress.md             # 学习进度追踪
        ├── notes.md                # Note artifact (含 TipTap / markdown 存储等技术实现)
        ├── lanes.md                # Dreaming + Maintenance lanes
        └── quiz.md                 # Quiz / Assessment 子系统（含 JudgeRouter / Direct multimodal / 申诉流程）
```

---

## 模块速览

| 模块 | 一句话 | 详细 |
| --- | --- | --- |
| 架构基础 | KG / AI 角色 / AI 任务层 / 技术栈 / 数据模型 | [docs/architecture.md](docs/architecture.md) |
| 错题管理 | 录入 / 归因 / 复习（FSRS） | [docs/modules/mistakes.md](docs/modules/mistakes.md) |
| 待学习列表 | 4 来源汇入的 LearningItem，多路径完成判定 + Evidence 留痕 | [docs/modules/learning-items.md](docs/modules/learning-items.md) |
| 学习进度追踪 | mastery 双层（base + AI delta），周复盘 | [docs/modules/progress.md](docs/modules/progress.md) |
| Note Artifact | AI 作者 / 用户消费；hub + atomic 结构；source tier 防幻觉 | [docs/modules/notes.md](docs/modules/notes.md) |
| Dreaming + Maintenance | AI 主动产出（生产 + 维护）两条 lane | [docs/modules/lanes.md](docs/modules/lanes.md) |
| Quiz / Assessment | 题目生产 → 判定（7 种 judge_kind） → 反馈 → 错题入库；含 ai_flexible 兜底和申诉重判 | [docs/modules/quiz.md](docs/modules/quiz.md) |

---

## 阶段路线图

### Phase 1 · 让一个闭环跑起来（最小可用）

只做错题管理 + 学习项 + 知识点挂载 + Quiz 骨架，验证数据模型。

**核心闭环**
- [ ] 知识点 schema（含 base / ai_delta mastery、merged_from、归档字段、updated_at/version）
- [ ] 文言文课标 import + AI 自动建议节点（人工确认）
- [ ] 错题录入（vision LLM 直接处理）
- [ ] LearningItem 数据流（来源：mistake / manual）
- [ ] AI 归因 + 自动挂载知识点
- [ ] FSRS 复习队列
- [ ] 完成判定多路径（自我宣告 + Evidence 留痕，软反问 + 强制覆盖）

**Quiz 子系统骨架**
- [ ] Schema: Question / Answer / Judgment / UserAppeal
- [ ] QuizGenTask（参数化）
- [ ] JudgeRouter
- [ ] JudgeExactTask / JudgeKeywordTask / JudgeSemanticTask（基础 3 种）
- [ ] JudgeFlexibleTask + UserAppeal 流程
- [ ] Mistake 创建事件（incorrect/partial → mistake，appeal 翻盘撤销）
- [ ] mastery 反馈喂 base_mastery
- [ ] feedback_md 模板 + partial credit 计算

**AI 基础设施**
- [ ] AI Task Layer 骨架（基于 OSS 框架，先单 Claude provider）
- [ ] Tool registry + Task 白名单 + Budget 控制
- [ ] ToolCallLog 观测

**项目结构**
- [ ] 目录边界：`core/` vs `subjects/wenyan/`
- [ ] 数据导出（JSON / Markdown）—— 给未来的自己买保险
- [ ] PWA 跑通（移动端能录入、能复习、能管学习项、能答 quiz）

目标：自己能用它备文言文一周，跑出第一批数据。

### Phase 2 · 进度图谱 + Dreaming + Maintenance + Note Artifact + 高级 Judge

- [ ] base mastery 公式实现：`max(fsrs_retrievability, quiz_pass_floor=0.7)`
- [ ] Hub mastery 聚合：按 `(错题数 + 学习项数)` 加权平均子节点
- [ ] AI delta mastery + 回滚（单次最大幅度 ±0.15）
- [ ] 知识点图谱可视化
- [ ] 学习会话记录 + 热力图
- [ ] 周复盘报告（WeeklyReportTask）
- [ ] Dreaming lane（每日总结、每日 quiz、题目 / 知识点建议）
- [ ] Maintenance lane（合并、归档、删错题、状态重置）
- [ ] 完成判定的 AI 主动提议路径（mastery>0.8 持续 14 天 ∨ 关联 check 全过 ∨ 7 天错 0）
- [ ] **学习意图声明输入 + Artifact 生成 pipeline**
- [ ] **Hub + Atomic note 双层结构（基于 TipTap + markdown 存储）**
- [ ] **结构化 section 模板（5 种 kind）**
- [ ] **Hub outline 同步 + atomic batch 异步生成**
- [ ] **Source tier 标记 + 双 pass 生成（NoteVerifyTask）**
- [ ] **Embedded check 与 mistake / mastery 联动**
- [ ] **Note 演进机制（基于错题更新 section）**
- [ ] **JudgeRubricTask（rubric 评分）+ JudgeStepsTask（步骤验证）**
- [ ] **JudgeMultimodalTask + VisionAnswerExtractTask + visual_complexity 路由**
- [ ] 视觉模型 eval（CMMMU + MMMU + 自定义 10~20 张样本），定 baseline
- [ ] Skill 抽离（如果 prompt 重复够多）
- [ ] MCP Server expose（safe resources + propose-only tools）
- [ ] 外部 MCP 消费（Calendar 优先）

### Phase 3 · Tool 型 Artifact / Plugin

- [ ] Tool 型 Artifact 评估（Note 升级 还是独立创作类）
- [ ] Plugin loader（如果引入第二学科）
- [ ] 论述题深度评分（多 pass + self-consistency）
- [ ] Tauri 桌面端打包

### Phase 4 · 体验打磨

- [ ] 云同步（D1 + R2，基于 Phase 1 留下的 version 字段）
- [ ] 离线优先策略
- [ ] 移动端拍照 vision pipeline 优化
- [ ] 多 provider 接入（按任务路由 / 备选链）
- [ ] Voice input
- [ ] Obsidian plugin（让用户在 Obsidian 里看 backlinks）

---

## 待决策汇总

### 已定（Cluster A/B/C 决议）

- [x] 应试 vs 兴趣两套图谱 → 共享 tag、独立主图
- [x] AI 调用 API 还是本地 → 走 API（Phase 1 单家 Claude，任务层留多 provider 接口）
- [x] 同步策略 → 本地优先 + 自动后台同步（去抖 3~5s），LWW + version 字段
- [x] 完成判定 → 多路径 + Evidence 留痕，不强制 quiz；self_declare 软反问 + 强制覆盖（留痕）
- [x] AI 能动性边界 → 软判断 / 软提议 AI free，硬数据 / 不可逆操作锁死
- [x] Artifact 定位 → AI 作者，用户消费；Phase 1/2 只做 Note，Tool 型 Phase 3 评估
- [x] Note 结构 → Hub + Atomic 双层，atomic ↔ 知识点节点
- [x] Tool calling 实现 → 用 OSS 框架（Vercel AI SDK / LangChain），不自建
- [x] Note 框架 → 自建（不嵌 Obsidian），编辑器用 TipTap，存储用 markdown + frontmatter
- [x] **第一个落地的应试场景 → 文言文（高中语文）**（理由：覆盖 4 种 judge_kind 多样性）
- [x] **视觉模型 eval baseline → CMMMU + MMMU + 自定义 10~20 张真实样本**
- [x] **Quiz 子系统的判定方式 → 7 种 judge_kind，由 JudgeRouter 路由**
- [x] **Vision 输入路径 → pipeline 与 direct multimodal 双路径，按 visual_complexity 路由**
- [x] **Embedded check 引擎 → 与 QuizGenTask 共用，参数化**
- [x] **AI 申诉兜底 → JudgeFlexibleTask（Opus + 完整上下文 + CoT），同 Judgment 限申诉 1 次**
- [x] **base mastery 公式 → `max(fsrs_retrievability, quiz_pass_floor=0.7)`**
- [x] **Hub mastery 聚合 → 按 `(错题数 + 学习项数)` 加权平均子节点**
- [x] **AI delta mastery 单次最大幅度 → ±0.15**
- [x] **LearningItem 优先级 → Hybrid（用户 pin + AI score）**
- [x] **跨学科引用 → markdown wiki link 软引用，不做强类型**
- [x] **阅读 UX → 移动优先线性流 + 桌面双栏（hub outline 侧栏 + atomic 主体）**
- [x] **变式题质量保证 → 双 pass + draft 状态**
- [x] **Search-grounded 搜索源 → Phase 2 初通用 web，后期教材 RAG**
- [x] **AI 主动提议完成的触发 → mastery>0.8 持续 14 天 ∨ 关联 check 全过 ∨ 7 天错 0**

### 阈值类默认（runtime 调）

- [x] 归档触发的久未触达阈值 → 90 天
- [x] dreaming 接受率阈值 → 滚动 30 天 <30% 触发砍信号
- [x] soft delete retention → 30 天
- [x] 成本天花板 → $5/day, $30/week（兜底）
- [x] borderline 阈值 → 0.4 ≤ score ≤ 0.7（统一，可 runtime 调）
- [x] partial credit verdict 阈值 → score≥0.85=correct, 0.4<score<0.85=partial, ≤0.4=incorrect

### 仍未定（runtime 数据后再决）

- [ ] Phase 1 启动后第一周跑出的具体数据，校准 base mastery 公式权重
- [ ] LearningItem priority score 的权重 (urgency/weakness/recency/pin)
- [ ] Rubric 多次评分的一致性检测策略（Phase 3+）

### 模块特定未定

各模块的 open questions 见各自文档底部。

---

## 未来可能性（不在当前路线图）

- 番茄计时和复习日程同步到日历
- 多人模式（学习小组、错题互通）
- 与已有 osu / 编程项目的数据打通（学习时长聚合）
- 语音问答（路上回顾错题）
- 知识图谱跨用户合并（应试图谱社区共享）
