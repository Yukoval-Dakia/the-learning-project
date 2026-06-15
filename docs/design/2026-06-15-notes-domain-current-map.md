# 笔记域 re-think · 现状地图（understand 阶段）

**Date**: 2026-06-15
**Status**: Grounded current-architecture map（understand，不设计应然）
**生成**: workflow `notes-domain-current-map`（7 agent / 877k tokens / 200 工具调用，6 路并读 + 1 综合，全 opus，含 file:line 核验）
**触发**: owner 把 notes-artifact 域单拎出来重想产品形态（主 rethink 跳过最狠的核心域；114-agent 审计 notes-artifact 镜头报 9 缺口）。本文是决策前的现状底图。

---

## 一句话现状

notes 域 = 三类 artifact（note 三型 `note_atomic`/`note_hub`/`note_long` + interactive + tool_quiz）共用同一张 `artifact` 表的多态承载，note 三型靠**裸 text 的 `type` 字段 + `knowledge_ids` 基数约定**区分（DB 无 enum，全靠 Zod parse barrier）。核心是 **Living Note 自演化**子系统：单一 pg-boss job `note_refine` 被**四触发信号**喂入，产 `NotePatch`（op 流非整篇重写），经 `ops≤3 且 new_blocks≤2` 的 gate 分流——小改 **mutator 直落改 `body_blocks` 无人审**（A 档语义但代码零 tier 概念），大改走 `note_update` proposal 进收件箱人审（B 档）。挂载是**单层扁平 label**（刻意不进 mastery 投影），`hub_auto_sync_nightly` 是唯一维护 hub→atomic 双层一致性的 job。**整域对 D14 对话面零可达**（无 copilotTools 贡献）。

---

## 六层现状（grounded，带 health）

| 层 | 现状形态 | health |
|---|---|---|
| **schema/数据** | `artifact` 表统一承载五型（type 裸 text，Zod 收窄五值）；`body_blocks` 单 jsonb（TipTap doc）；五段 `NoteSection`（definition/mechanism/example/pitfall/check）**从 semanticBlock 块派生非 DB 行**；三状态轴（generation/verification/embedded_check）+ version 乐观锁 | 半截：裸 text 列 DB 不挡非法值；jsonb 对 audit:schema 不透明；五段骨架仅 atomic 软门；**history 双轨分裂**（人工编辑写 `artifact.history` jsonb / AI refine 走 event 表，reader timeline 看不见 AI refine） |
| **jobs 自演化** | 单入口 `note_refine`：四信号 → `NotePatch` → `decideNoteRefineMode` gate 分 mutator/propose；`note_generate`（诞生）+ `hub_auto_sync_nightly` 同链 | 多处待裁：debounce 进程内 Map 与跨进程 PG presence 不一致；trigger flag 默认全开无生效 kill switch；mastery_change 名不副实；文件头注释 stale |
| **verify 信任** | `runNoteVerify` 双路：atomic 先跑零成本五段硬合同（缺则 needs_review confidence:1 不调 LLM），过才调 LLM 软判；needs_review 写 `note_update` proposal | 半截：**verdict 无 fail 终态**（fail 是 catch 副作用）；confidence 存了不 gate 行为；**产的 note_update proposal 缺 patch 字段无法 Accept（死提议）**；boss 注册 M5 拆簿未完 |
| **ui+编辑** | 单页三栏 `NoteReaderPage`（/notes/$id）；保存 PATCH body-blocks 带 version 乐观锁；AI 改动两处回显（右栏 + Today 24h strip）共用 per-event undo；`?entry` 一篇笔记多扇门 | 读取三态（载/错/空）成熟（视觉环+双 bot 打磨）；但 **generation_status/embedded_check_status wire 上有 UI 不渲**（生成中笔记看不出正在生成）；check 段=D6 墓碑只读；协同故障态半缺（AI 改后只 409 toast 无 diff） |
| **挂载（双层图）** | `knowledge_ids` 扁平 label（非 ownership），atomic=1/long&hub 1~N，**刻意不进 mastery 投影**；cross_link（note↔note）与 knowledge_edge 分层；`hub_auto_sync` 沿 mesh curate cross_link（带 relation chip） | 功能稳但未对齐新设计：单层扁平；note 与「学没学会」数据脱钩；新双层异构图的 misconception 节点/typed-edge 尚未触及笔记挂载 |
| **提案能动** | AI 改笔记全经 note_refine：mutator 直落（事务 UPDATE + reverse_patch+previous_body_blocks）vs propose（kind=note_update 收件箱）；`editing_presence`（PgPresenceStore）做编辑感知 defer | 坏/半截：**撤销链断成两半**；**apply 对 user_verified 零保护**；代码层零 A/B/C tier；note_update proposed_change 泛型两 producer 形状漂移 |

---

## Living Note 四触发信号

| 信号 | 来源 | 状态 |
|---|---|---|
| **mark_wrong**（标块错） | `correct.ts:118` | 活、默认开、语义清晰无争议 |
| **mastery_change**（复习成功） | `submit.ts:596-611`（outcome==='success'，纯成败代理） | 活、默认开，**名不副实——从不读任何 mastery 数值**；C 组待裁「B1 重写下重接」；B1 改表不会让它崩（trigger 不读 view） |
| **dwell**（编辑驻留） | `editing-heartbeat.ts:29-31`（每 5s 心跳即触发） | 活、**默认 ON 且 kill switch 实际无效**；⚖️ 争议行从 M3 拖到 M5 未裁；最弱信号却最频繁；与 presence defer 自相牵制 |
| **dreaming**（夜扫候选） | `dreaming_nightly.ts:369` | 活、默认开、语义清晰 |
| ~~error_rate~~ | （D6 删） | 已死墓碑；refine 从五信号降四信号，mastery_change 被定位为其替代 |

---

## 九个待决（决策就绪：现状 → options → 阻塞）

1. **note_update 终档**：mutator 直落（A 档语义）vs 全走 propose（B 档）。⚠️ 与已拍 A/B/C 表（note_update=B）**矛盾未对齐**。
2. **mastery_change 触发器重接**：保持 success 代理 / 改读 mastery_state 真实 delta / 重命名 review_success 诚实化。
3. **五段 check 段形态**：保留 atomic 硬契约 / 降级 generate prompt 提示 / 彻底放开。三方张力（D6 删内嵌自测 + B1 开放题天花板 + check 段）。
4. **笔记挂载对齐双层图**：保持扁平 label / 块内分挂 / note 进图成一等节点喂 mastery / 沿 typed-edge 聚合挂 misconception。
5. **笔记进度可见性**：接 generation/embedded_check status 到 reader / 统一改动时间线 / 沉淀量物化为进步信号。被成效层缺席阻塞。
6. **dwell 遥测去留**：下线（连带评估 editing_presence）/ 保留改语义加真 kill switch / 保持冻结。
7. **AI 改动撤销链并入 A/B/C**：统一单一撤销入口 / 给 retract 补 note_update body_blocks 回退分支（复用已存 reverse_patch）/ kind 元数据引入 tier 字段。
8. **note_verify patch-less 死提议修复**【真 bug】：note_verify 产可应用 patch / 用独立 proposal kind / accept 期走 summary-only 路径。本质先裁「verify 提议该不该可一键 Accept」。
9. **AI refine 对 user_verified/已读内容硬边界**【最严重故障缺口】：user_verified 设 refine 硬边界（跳过/拒改）/ 强制走 propose / 保持现状（仅展示语义）。

---

## 故障/降级态现状

- **note_generate 产空/坏**：fail-closed 有设计（空 body_blocks throw → generation_status='failed' → 重试，UI 见 failed 非永久 pending）。但五段在 generate 阶段 NOT 强制（只要 ≥1 block），check 段缺失靠 verify 异步补判。
- **note_verify 误杀**：结构上非破坏性（最坏 needs_review + 写 proposal，从不删/改 body_blocks），但**无「不破坏」断言测试**，confidence 存了不 gate；verdict 无独立 fail 态（「内容有问题」与「流程崩了」同列）。
- **refine 改坏 user_verified**【最严重】：仅两层兜底（编辑期 presence defer + 乐观版本锁），**完全无 user_verified/source_tier 内容保护**（apply-note-patch.ts grep 0 命中）。版本锁只防并发不防「AI 静默改掉用户认可的定义」。
- **refine deferred 陈旧 pending 静默蒸发**：超 10min 仍编辑 → dropStalePending + console.warn，AI 改动无声蒸发无重试无通知。
- **hub_auto_sync 夜间漂移**：退化态设计**最周全（范本级）**——bypass 编辑期 presence、乐观锁让 version_conflict no-op 次夜重试、幂等、单坏 hub try/catch tally 不杀 batch、尊重 suppressed 名单。
- **进度可见性=数据层基本空白**：只有 note_generate 把失败物化到列；refine 的 deferred/conflict/skip 全 in-memory 即焚。

---

## 遗留债（legacy_debt）

- **editing-session/presence 旧栈 M5 后活着且被升级**（非遗留物）——已从「不搬区」收编进 notes manifest（/api/editing-session/* 现是 Hono 一等路由）+ Redis→PG 迁移（PgPresenceStore）+ 写侧接线补齐。但 CONTEXT.md:14 仍写「未裁前继续旧栈服务」= **文档↔代码 drift**。它是单人编辑 vs 后台 AI 的并发仲裁（纯写侧单向，UI 只发心跳从不读回）。
- **dwell debounce 跨进程失效**：用 module-level 进程内 Map，但 presence 已迁跨进程 PG 表——app 进程和 worker 进程各维护一份 60min 防抖，**跨进程去重已悄悄失效**（Redis 退役清理漏掉的一致性债）。
- **embedded_check 链「说删了但没真删」**：note-refine.ts:36 注释称「内嵌自测全链路裁撤」，但 `embedded_check_generate` boss.send 仍发、`embedded_check_status` 列仍 4 态、embedded-check/attempt 路由（199 行 judge 逻辑）仍挂 manifest 活着——**实际只删了 error_rate 这一条 refine 触发信号**。SPA 端零 UI 消费（孤儿端点）。
- **note_verify/note_generate boss 注册 M5 拆簿未完**（工厂带 boss 二参不符 kernel 单参签名，半迁移态）。
- **history/undo 双轨分裂**：人工编辑写 artifact.history jsonb（reader 直读当 timeline），AI refine 绕过该列改写 event 表——reader timeline 看不见 AI refine。
- **接线层测试盲区**：editing-heartbeat/blur 两路由零测试；四 refine 触发源实际接线点无统一回归测试（rethink 重接 mastery_change 后「信号还通不通」只能手测）。

---

## 给 decide 阶段的提示

- **两条不是产品决策、是该修的洞**：#8 note_verify 死提议（真 bug）、#9 user_verified 零保护（最严重故障缺口，AI 可静默覆写用户认可内容——对 evidence-first/propose-only 产品是红线级）。这两条无论笔记形态往哪走都该修。
- **#1/#7 同源**（mutator 直落 vs A/B/C 表 note_update=B + 撤销链断两半）——A/B/C 18 行表已拍 note_update=B，但代码现状 mutator 是 A 档语义，**这个矛盾是笔记形态第一块要拍的**。
- **#3/#6 牵连遗留债**：check 段去留 ↔ embedded_check 假删链；dwell 去留 ↔ editing_presence 旧栈死代码。决策连带清债。
- **#4/#5 依赖外部**：挂载对齐双层图依赖 ADR-0036 misconception 节点形态（H7）；进度可见性依赖成效层语义（YUK-354/成效面）。
