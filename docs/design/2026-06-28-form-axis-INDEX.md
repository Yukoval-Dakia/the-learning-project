# 形态轴 A1–A8 re-excavation 记录（2026-06-28）

> ⚠️ **定位（必读）**：本批 doc 是 ulw「全面推进形态轴 YUK-354」时对每条**当前代码** code-ground 的产出。re-excavation 结论（见 YUK-354 epic comment，2026-06-28）：**形态轴 7/8 屏已被 wave 工作建成，gate doc `2026-06-15-rethink-implementation-gate.md` §2 的旧缺口清单严重腐败**。
>
> 故这批 doc **不是一律「交 claude design 的全新 handoff」**：
>
> - **A7 = 唯一真缺屏（router.tsx 无路由）→ 真 handoff**，交 claude.ai/design 出视觉稿。挂 **YUK-519**。
> - **A1/A2/A3/A4/A5/A8 = 既有屏增量 grounding 记录**——屏已存在、有 loom 视觉语言，**不该交 claude design 重画整屏**。它们 ground 了每条的当前实现 + 真实剩余 + 基础设施去重 + owner 留白，是 owner 逐条决策 + 后续「在既有屏上加体验维度」实现的材料（实现仍走 design pre-flight）。

## 各 doc 真实定位

| doc | 屏现状（亲验） | 定位 | 去重裁定 |
|---|---|---|---|
| `form-axis-A1-handoff.md` | TodayPage 交班体验已实现（今日之线+AiChangesStrip+AgentNotesBoard+WeekHeat） | 既有屏增量记录 | 当日交班 digest 读模型（微，待 ground） |
| `form-axis-A2-handoff.md` | PfCoach socratic 逐级 hint 已实现 | 既有屏增量记录 | hints_used = **YUK-352 Done**；阶语义/逃生口待 owner 拍阶数；PfCoach「会话不计入判分」是设计非 bug |
| `form-axis-A3-handoff.md` | CopilotDock chat+SSE 已实现 | 既有屏增量记录 | 会话记忆=**YUK-267 Done**；session=YUK-268；tool-use 卡=YUK-457；主动开口/checkpoint 待核重复 |
| `form-axis-A4-handoff.md` | InboxPage 按 kind 分 lane+isAcceptSupported 门控 已实现 | 既有屏增量记录 | A/B/C 出手强度 vs 决策成本**口径冲突待 owner 拍**；映射表=留白5；熔断真缺但属设计决策 |
| `form-axis-A5-handoff.md` | KnowledgePage 树/图双视图+MeshGraph+NodeDrawer+AI提议 已实现 | 既有屏增量记录 | 裸数字+置信 wire=**YUK-476 重叠**；大图=**YUK-236 Done**（cap 已加，CTE 未做）；misconception 层依赖 ADR-0036 |
| **`form-axis-A7-handoff.md`** | **真无屏** | **真 handoff → claude design** | **挂 YUK-519**（唯一真缺屏 + 后端纵向聚合读模型，无重复） |
| `form-axis-A8-handoff.md` | RecordPage+/mistakes（死链已闭 #508）已实现 | 既有屏增量记录 | 出口叙事/rescue/phase0 降级；figure 端点（crop 不建 source_asset）；rescue 富策略=已注释 gated-future |

## owner 待拍留白（贯穿，逐条决策前置）

1. **A2** hint 阶梯最终阶数 + 每阶内容（ledger §6 倾向 6 阶 H0-H5 vs synthesis 建议 3 阶 v0）。
2. **A4** A/B/C 三档口径：出手强度轴（ledger §A4，C=最轻移出视线）vs 决策成本轴（C=最重裁决）——两轴在 C 处最大冲突，须 owner 定。
3. **A5** 是否接 YUK-297（知识图谱 SVG 重写 + 渐进披露引擎）；双层图误区层本期出形态还是押后（误区层今无数据）。
4. **A7** 开放题为主科目（IRT 三量退化）的替代可视化形态（owner 自评趋势的输入 modality 未定义）。
5. **A8** 录入成功着陆形态（着陆页 vs 瞬时 toast；去向集合）。

> 真账全文 + meta 教训（任何「缺口」判断都需 code-ground 当前状态）见 **YUK-354 epic comment（2026-06-28 re-excavation）**。

## 2026-06-28 后续进展

- **A7 落点 IA 拍定 + handoff 盲点修正**：claude.ai/design 把成效趋势折进现有 Coach 周报、复用同名标题——撞车。根因之一是本批 handoff **漏 ground 既有 Coach 周报（活动报表）+ 校准成熟度面**。owner 拍定 = **Coach 升「复盘中枢」三视图**（活动量 / 校准诊断〔从 admin 迁入〕/ 成效趋势〔A7〕，校准 vs 成效正交不合并）。A7 handoff 已更新落点 IA 段。重构工单见 Linear。
- **A7 数据前置已 ship**：纵向聚合读模型 = YUK-519 / PR #664（`effectiveness-trend.ts`），handoff 底部「基础设施缺口」已标 resolved。
- **A1/A4/A8 基础设施**：对抗 workflow 验完全部 confirmed-real 但全部 revise-design（无一可照搬），落 Linear 子单 **YUK-520**（A1 夜窗 digest 读模型）/ **YUK-521**（A4 A/B/C 强度表+裁决熔断）/ **YUK-522**（A8 figure content + PDF abort），verdict 的坑当实现约束写进 body。
- **A1/A2/A4/A5/A8 增量 brief**：既有屏新视觉维度（非重画整屏），decisions 已锁，串行 workflow 撰写零风格 brief + 对抗审风格泄漏中。
