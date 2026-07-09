# 夜链 cron → 逻辑 trigger 替代性终审报告（YUK-377 复审 · 2026-07-06）

> **Provenance**：ultracode workflow `wf_aee4eaf8-4ff`（37 agent / ~2.83M tok / 22min）。方法沿 YUK-377 原版：3 路 grounding（send 先例 / handler 缺口回填 / docs 佐证）→ 16 lane 逐 cron 设计（Opus high）→ 每 lane 对抗反驳（Opus high）→ fable xhigh 终裁。裁决规则：refutation 的 final_verdict 优先于 design verdict；被击杀假设全部留档（§7）。
>
> **诚实缺口注记**：`reference_answer_backfill` 专属 design lane 失败（StructuredOutput 5 次重试未过，agent 生前倾向 hybrid——「当天上传当天可用」的冷启体验收益）。其 keep-cron 终判由 practice_chain_dag lane 的对抗结论覆盖（「LLM 资产 per-write 触发 = 白天扇出净负」）。**「冷启当日 reference 可用性 vs 夜批」这一具体张力未获专属对抗裁决**——与 PLAN.md S3 trace 的 🟡「ref_md 滞后一夜链 judge 降级 prompt-only」同源；如 owner 关心此体验，可单独复审该条。

---

审计方法：16 条 lane（设计 → 对抗验证）+ 9 条日历节律直判 + 组合根 manifest 实测对账（31 条 cron 全量核实：practice 10 / knowledge 7 / agency 5 / notes 1 / memory 3 / housekeeping 5）。

## 1. 执行摘要

**总答：31 条 cron 中，没有一条支持纯 replace（删 cron 改事件）。** 经对抗验证后的最终格局是 **2 条 hybrid、1 条 remove-question、28 条 keep-cron**。YUK-377 原判「墙钟错峰当编排」的病灶在逐条打开代码后大面积不成立：绝大多数 offset 是「避同分钟竞争的错峰」而非数据依赖，「compose 05:30 前资产就位」是可优雅降级的软契约（`effectiveB = b_calib ?? b_anchor ?? b`，compose 完全不读 answer_class / reference_md / embedding / kt_json）；本仓真正的病根解药——ADR-0021 transactional outbox、NULL 列自净谓词、fingerprint cooldown——**已经就位并正是这些 cron 本身**。全仓仅确认一条真数据依赖 barrier（edge_propose 02:30 SUPERSEDE 写 live 边 → hub_auto_sync 02:45，与 YUK-384 立项措辞相反），和一个真排序 bug（kc_dedup 02:00 跑在 embed 04:40 之前，恒滞后一天，一行改期即修）。

**Top 替代/行动候选**（详见 §3）：
1. `memory_brief_sweep` subject 腿事件化（唯一存活的真事件化候选，hybrid）
2. `hub_auto_sync_nightly` 交互 accept/archive 触发（hybrid，= YUK-384 修正版）
3. `kc_dedup_nightly` 改期到 embed 之后（非事件化，但值/险比最高的单行修复）
4. `knowledge_edge_propose_nightly` watermark 续扫（keep-cron 内的 MEDIUM-1 主修，机制已被对抗修正）
5. `research_meeting_nightly` propose 腿空跑早退（零风险，消除空夜 outbox 扇出）
6. `QUESTION_SUPPLY_REFILL_ENABLED` 翻 flag（逻辑 trigger 已建成、dark 待 go-live，归 YUK-372）

## 2. 31-cron 全量 verdict 主表

Verdict 均为对抗后终判（refutation 优先）。

### Practice（10）

| name | cron (BJT) | verdict | 一句话理由 |
|---|---|---|---|
| item_prior_backfill | 04:20 每日 | keep-cron | anti-join 自净夜批；写点触发绕过 25/夜预算闸 + 12 站点埋点脆弱，收益软且边际（amended：hybrid→keep） |
| embed_backfill | 04:40 每日 | keep-cron | `embedding IS NULL` 本身即 durable outbox；如需低延迟按 ADR-0021 家法**提 poll 频率一行**，不撒 12+ 写点 seam（amended） |
| recalibration_nightly | 04:50 每日 | keep-cron | 数据谓词水位轮询非墙钟冒充；「recalc 须在次日 item_prior 刷锚后」的排序锁死可删性；盘中收益量级小 |
| answer_class_backfill | 05:00 每日 | keep-cron | **on-write 派生已全量上线**（12 站点均已 `withAnswerClass`）；cron 仅剩 NULL 尾 + 新站点漂移兜底，无 audit lint 前不可删（amended：hybrid→keep） |
| kt_estimate_nightly | 05:10 每日 | keep-cron* | 机制层 keep（批聚合、事件化负收益）；但 kt_json 零消费者死列，**是否停跑归 owner**，见 §5 |
| reference_answer_backfill | 05:20 每日 | keep-cron | `reference_md IS NULL` 自净；compose 不读；LLM 资产 per-write 触发 = 白天扇出净负（practice_chain_dag lane 覆盖；专属 lane 失败见头部注记） |
| practice_stream_compose_nightly | 05:30 每日 | keep-cron | 「今天到了」无事件可投；`singleFlightCompose` lazy 首读即恢复路径，合法日历墙钟 |
| axis_state_nightly | 05:40 每日 | keep-cron | display-only 慢变描述符批聚合（有 live 显示读点 placement-profile.ts:117）；per-event 重折叠 = 扇出爆炸 + 语义错；可选降周频 |
| question_supply_nightly | 06:00 每日 | keep-cron | 5 类缺口中 4 类是跨源驻留聚合、无写点可宣告「缺口出现」；低延迟补充已实现（refill.ts pull 触发，dark）（upheld） |
| confusable_contrast_nightly | 06:20 每日 | **remove-question** | flag off → discovery 返 [] 彻底 NO-OP，替代评审失义；翻 flag 后继承 supply 的 keep 理由 |

### Knowledge（7）

| name | cron | verdict | 一句话理由 |
|---|---|---|---|
| kc_dedup_nightly | 02:00 每日 | keep-cron | 事件化被 refute（embed-完成链投退化为 cron-链-cron）；唯一真实收益 = **改期到 embed 04:40 之后**修一天滞后 bug |
| knowledge_edge_propose_nightly | 02:30 每日 | keep-cron | 跨作答聚批 LLM 是价值核心，per-event 毁信号 + 炸成本；须配 watermark 修 24h 有损窗（机制见 §3.4） |
| knowledge_maintenance_nightly | 03:00 每日 | keep-cron | 夜间 agent 维护 pass，日历本质 |
| frontier_fill_nightly | 05:15 每日 | keep-cron | frontier 空是全图衍生持续态、无写点锚；propose-only 进人工 inbox；并发双 propose 风险使 cron 更安全（upheld） |
| merge_attribution_sweep | 周一 04:00 | keep-cron | 残留竞态 census + bounded repair，「检测漏网」本质要周期全量；事件侧主修在 YUK-544 |
| projection_oracle_sweep | 周一 04:30 | keep-cron | REPORT-ONLY 审计节律，就是要周期性 |
| kg_borrow_shadow_sweep | 周一 05:00 | keep-cron | 特意从 per-read emit 改周 sweep 防 outbox 扇出——事件化的反例教材 |

### Agency（5）

| name | cron | verdict | 一句话理由 |
|---|---|---|---|
| dreaming_nightly | 03:15 每日 | keep-cron | 夜间创造性 agent pass 读聚合信号，日历节律本质 |
| coach_daily | 03:45 每日 | keep-cron | 每日 TodayPlan/brief 生产者，日历本质；旧 review_plan 链投已 retire |
| coach_weekly | 周日 04:30 | keep-cron | 周反思，日历本质 |
| goal_scope_propose_nightly | 03:50 每日 | keep-cron | 已改 mastery tree-snapshot 选取（watermark-independent，Codex P1 FIX），非事件驱动 |
| research_meeting_nightly | 04:35 每日 | keep-cron | reconcile 输出全 dark（FLIP defer ADR-0046）零即时收益；propose 是 Opus N=3 真批；只做空跑早退，事件化 defer 到 ledger 转 live（amended：hybrid→keep） |

### Notes（1）

| name | cron | verdict | 一句话理由 |
|---|---|---|---|
| hub_auto_sync_nightly | 02:45 每日 | **hybrid** | 交互 accept/archive 后 best-effort 去抖 sweep 加速白天子集；**02:45 cron 原样保留且必须仍在 02:30 之后**——它是 SUPERSEDE 夜批 live 边的唯一消费路径（真 barrier，非 YUK-384 所称伪 barrier） |

### Memory（3）

| name | cron | verdict | 一句话理由 |
|---|---|---|---|
| memory_ingest_outbox_poll | 每分钟 UTC | keep-cron | ADR-0021 transactional outbox 的 dispatch 心跳——是病根**解药**非病例；写点直投 = 复刻已回滚的 PR #163（upheld，不可降频） |
| memory_ingest_outbox_recover | 每小时 UTC | keep-cron | outbox event-level recovery drain（cap1000），专治 worker outage/burst，不可删 |
| memory_brief_sweep | 03:00 每日 | **hybrid** | subject 腿事件化（桥搬进 ingest handler）；global 腿其实**已**事件触发（scope_tagger 无条件塞 'global'）；cron 降为冷启 + DLQ + 丢投 + dormant 兜底 |

### Housekeeping（5）

| name | cron | verdict | 一句话理由 |
|---|---|---|---|
| promote_conversation_idle | 每分钟 | keep-cron | idle = 事件缺席，只能 poll 或 timer；sendAfter 零先例 + debounce 须 fired-job 自我重排，净负（upheld） |
| prune_orphan_review_sessions | 04:15 每日 | keep-cron | 丢信号安全网本体；sendAfter 预约反而新增 commit-后-send-前缺口（upheld） |
| prune_orphan_conversation_sessions | 04:25 每日 | keep-cron | 同上；三条错峰仅为避 learning_session 行锁竞争（handlers.ts:93-95），非数据依赖 |
| prune_orphan_placement_sessions | 04:35 每日 | keep-cron | 同上 + dark-ship（YUK-470 go-live 前置件），原样保留 |
| prune_job_events | 04:00 每日 | keep-cron | 30d bulk DELETE，日历本质（handlers.ts:75-77 实测确认） |

## 3. Ranked 替代候选（按值/险比排序）

### 3.1 memory_brief_sweep — subject 腿事件化（hybrid，唯一存活的新事件化）
- **触发写点**：`src/server/memory/triggers.ts:328-330`（ingest handler 的 affected_scopes fan-out 循环之后追加）——单一消费漏斗，不碰 12+ 个 writeEvent 写点。
- **机制**：`row.action ∈ QUALIFYING_ACTIONS` 时用 `resolveQualifyingEventSubjects`（从 `active-subjects.ts:111` 导出，函数体只读 id/action/subject_id/payload，outcome 传 null 即可）解析 subjectId → `enqueueBriefRegen(boss, 'subject:<id>')`。普通 boss.send，不用 sendAfter。
- **singletonKey**：复用现成 `memory.regen.subject:<id>` + `singletonSeconds=360` + `singletonNextSlot=true`（triggers.ts:246-268），同 subject 突发 6min 塌缩成一个 LLM regen。
- **兜底**：cron 保留（可维持每日 03:00 或降 6h），职责收窄为：never-built 30d 冷启 + DLQ 恢复 + best-effort 丢投 + dormant/meta 面。**对抗修正**：global 腿已由 `scope_tagger.ts:40` 无条件 'global' 事件覆盖，cron 残余职责比设计所述更小。
- **幂等**：`subjectScopeHasNewEvidence` 守卫 + onConflictDoUpdate + singleton 塌缩；durability 继承 ingest job 的 pg-boss 重试。
- **主要风险**：丢 `maxSubjectsPerRun` 跨 subject 聚批帽（单用户个位数 subject，可忽略）；brief regen 是真 LLM 调用（brief-writer.ts:198-209），白天分摊多次是有界 tradeoff。
- **与既有档关系**：符合 YUK-377 轻量档「事件为主 + cron 兜底」精神；与 YUK-384 无关。排序契约无损：goal_scope 已不依赖 sweep 水位（见 §6）。

### 3.2 hub_auto_sync_nightly — 交互 accept/archive 触发（hybrid，= YUK-384 修正版）
- **触发写点**：`src/server/proposals/actions.ts:619`（边 create accept tx 提交后）、`:495`（边 archive accept tx 提交后），best-effort post-tx（try/catch + warn swallow）。
- **机制**：`boss.send('hub_auto_sync', {})` 去抖**全量** sweep——单-hub 粒度不可行（`HubAutoSyncDeps` 无 hubId、loadHubs 全表扫，hub_auto_sync_nightly.ts:222-231），且整链零 LLM，全量 sweep 廉价。
- **singletonKey**：`'hub_auto_sync.global'` + `singletonSeconds=300` + `singletonNextSlot=true`（连 accept 10 条边塌成 1-2 次 sweep）。
- **兜底（对抗强制修正）**：**02:45 cron 原样保留、ordering 必须仍在 edge_propose 02:30 之后**——`applyEdgeSupersede` 在 02:30 夜批内自主写 live `knowledge_edge` + 归档旧边（actor=dreaming），02:45 是这类边的唯一消费路径，属 load-bearing 真 barrier。触发只加速 owner 白天交互 accept 子集。
- **幂等**：`buildAutoZonePatch` 无变更返 null；`persistNoteRefineApply` 乐观版本锁（note-refine-apply.ts:162-166）撞用户编辑 → version_conflict → 下轮重收。
- **主要风险**：note-refine apply 事件是否走 memory outbox 未核实到底（medium）——singleton 已把频次压到 ≤1/5min 窗。
- **与既有档关系**：直接落 YUK-384，但立项措辞「替代 02:45 offset 伪 barrier」必须改写（barrier 是真的）。

### 3.3 kc_dedup_nightly — 一行改期（非事件化，值/险比最高）
- **动作**：`knowledge/manifest.ts:150` 的 `'0 2 * * *'` 改到 embed_backfill 04:40 之后（如 `'0 5 * * *'`）。
- **理由**：dedup self-join 硬 gate `embedding IS NOT NULL`（kc_dedup_nightly.ts:142-143），而 KC 向量由 04:40 embed 夜批事后填——当前 02:00 排位使新 KC 向量落地后要等下一夜才被扫，恒滞后约一天。
- **对抗结论**：事件链（embed 完成 → send dedup）被 refute——embed 本身只 04:40 跑一次，链投退化为 cron-链-cron，零即时性增益，还引入跨域耦合 + 丢投窗口 + singleton 陷阱。改期拿到全部真实价值，零代码。
- **落地前置确认**（风险低）：knowledge_maintenance 03:00 不消费 pending merge 提议（grep 初核无读取路径）。

### 3.4 knowledge_edge_propose_nightly — watermark 续扫（keep-cron 内健壮性修复，YUK-377 MEDIUM-1 主修）
- **问题**：24h 滚动窗是有损批边界——02:30 LLM 故障被 swallow（propose_edge.ts:628 catch 后 return EMPTY_RESULT 不 re-throw），当天失败随窗滑走永久丢。
- **机制（对抗修正后）**：watermark 游标 `{last_processed_at, last_processed_event_id}` 替代 `since: 24h`；**推进点必须在 `runEdgeProposeAndWrite` 成功写库路径内（catch 之前）**，或给返回值加 success/failure 判别式——handler 侧 advance-on-non-throw 会在吞错夜照样推进，复现要修的信号丢失（design 声称的「handler-only 零改动」被击杀）。
- **兜底/幂等**：existingEdgeKey + pending 去重已幂等，watermark 重叠区安全；limit200 自然分页。
- **附带 GAP（单独落 issue 草案 D）**：review-again 失败不入 `getFailureAttempts`（queries.ts:176 谓词 `action='attempt'`，submit.ts:544 写的是 `action:'review'`）——复习期重复答错恰是持久混淆最强信号，却对提边不可见。

### 3.5 research_meeting_nightly — propose 腿空跑早退（非替代，零风险）
- **动作**：`research_meeting_nightly.ts:218` topCells 计算后加 `if (topCells.length===0)` 早退（必须在 reconcile :201 之后——兜底扫不能跳）。
- **收益**：消除空夜 2 个 outbox-eligible 事件（:222 trigger + :263 scan，均未 opt-out ingest_at）的 brief-regen 扇出 + 空 LLM loop。
- **事件化本体 defer**：reconcile 腿事件触发技术上干净（appeal.ts REJUDGE 范式、predictionScoreEventId 幂等锚），但 typed-ledger 全 dark（ADR-0046），零可观测收益——待 ledger 转 live 再落地。

### 3.6 question_supply refill flag（已建成的逻辑 trigger，翻 flag 即得）
- `refill.ts:226` compose-empty pull 触发已实现并接线在 `stream-store.ts:651`（compose 提交后 best-effort），与 nightly R1 共享 fingerprint 7d cooldown 不双付费；当前 `QUESTION_SUPPLY_REFILL_ENABLED` 默认 off。翻 flag 是 owner 决策，归 YUK-372 lane，不新开。只覆盖 frontier_zero，替代不了 cron 的其余 4 类驻留缺口扫描。

## 4. 明确 keep-cron 名单（28 条，按理由归组）

- **outbox 心跳（不可降频）**：memory_ingest_outbox_poll、memory_ingest_outbox_recover——它们就是 ADR-0021 解药本体，替代 = 倒退回已回滚的 PR #163。
- **事件缺席检测（结构上无法事件化）**：promote_conversation_idle——absence 只能 poll 或 timer。
- **丢信号安全网（替代 = 把缺口挪位）**：prune_orphan_review / conversation / placement_sessions。
- **NULL/谓词自净夜批（cron 即恢复网，无成本压力）**：item_prior_backfill、embed_backfill、recalibration_nightly、answer_class_backfill（on-write 已上线，cron 只剩兜底）、reference_answer_backfill、kt_estimate_nightly（机制层）、axis_state_nightly。
- **无事件锚的衍生态/驻留聚合**：frontier_fill_nightly（全图 frontier 空态）、question_supply_nightly（跨源缺口聚合）、knowledge_edge_propose_nightly（跨作答聚批 LLM）、kc_dedup_nightly（改期后保留）。
- **日历节律本质**：practice_stream_compose_nightly、dreaming_nightly、coach_daily、coach_weekly、goal_scope_propose_nightly、knowledge_maintenance_nightly、research_meeting_nightly、prune_job_events。
- **周期性 census/遥测（特意反事件化）**：merge_attribution_sweep、projection_oracle_sweep、kg_borrow_shadow_sweep。

## 5. remove-question 名单（价值本身存疑）

| job | 疑点 | 建议 |
|---|---|---|
| confusable_contrast_nightly（06:20） | `CONFUSABLE_CONTRAST_ENABLED` off → discovery 返 [] 彻底 NO-OP，每夜空转 | owner 决策：近期无翻 flag 计划则停 schedule；翻 flag 后按 supply 同理 keep |
| kt_estimate_nightly（05:10） | kt_json 全仓零消费者（red-line 测试断言 null vs populated 位等价）；ADR-0035 刻意 dark 的多用户期权 | owner 决策：停跑或降周频（抄 kg_borrow weekly 范式）保活管线；机制判决仍 keep-cron，不事件化 |

（axis_state 曾被提名此列但被对抗击杀——有 live 显示消费者 placement-profile.ts:117，见 §7。）

## 6. YUK-377 事实修正清单（issue 文本 stale 点）

1. **盘点 17 → 实测 31 条**（agency 5 + notes 1 + knowledge 7 + practice 10 + housekeeping 5 + memory 3，本次已对 manifest + handlers.ts + triggers.ts 逐条对账）。
2. **02:00 node propose 已拆除**（Lane D / YUK-482）；02:00 现为 kc_dedup_nightly；edge_propose handler 注释（:6-15）自认 02:30 现在 arbitrary-but-harmless。
3. **coach_daily→review_plan 链投已 retire**（coach_daily.ts:448 附近）——HIGH-3 / HIGH-5 中涉该链的地貌已变，需按现状改写。
4. **「mastery 夜链」幻影注释仍在**：lane 实测位置为 `practice/manifest.ts:226/:241` + `question_supply_nightly.ts:15` + `axis_state_nightly.ts:15`（原 `:176` 行号已漂移）——指向不存在的 job，应删或改真实 job 名。
5. **「compose 05:30 前资产就位」应降级为软契约**：candidate-signals.ts:176-205 `effectiveB=b_calib??b_anchor??b` 优雅退化、softmax-selection.ts:148 只 `.from(question)`；compose 不读 answer_class/reference_md/embedding/kt_json。offset DAG 实为独立自净 sweep 的错峰，「无完成信号」病判对此链不成立。
6. **hub_auto_sync 02:45 是真 barrier**（edge_propose SUPERSEDE 分支经 `createKnowledgeEdge` 写 live 边）——YUK-384「伪 barrier」立项措辞需反转。
7. **answer_class on-write 已全量上线**（YUK-395 P2 A3，12 站点均 `withAnswerClass`）；backfill 头注释「on-write@insert 是 deferred follow-up」已 stale。
8. **goal_scope 已不依赖 memory sweep 水位**（goal_scope_propose_nightly.ts:17-25 Codex P1 FIX 改 mastery tree-snapshot）——「sweep 03:50 前 bump 水位」排序契约失效。
9. **新发现两条**：kc_dedup 02:00 早于 embed 04:40 的恒一天滞后（§3.3）；edge_propose 不吃 review-again 失败的覆盖缺口（§3.4）。

## 7. 被反驳/降级实录（防重复排查）

| 假设 | 结局 | 击杀理由 |
|---|---|---|
| answer_class「12 站点未接线，写点内联是待办」 | 前提证伪，hybrid→keep | 12 站点全部已 `withAnswerClass`（grep 实证）；lane 自报的「无一站点 import」核验被判编造；提案描述的是已上线状态 |
| embed「12+ 写点撒 post-commit seam」 | 机制否决，hybrid→keep | 本仓对持久 NULL 列 outbox 的家法是 ADR-0021「写者不 enqueue、poller 扫」；正确杠杆是提 poll 频率一行；lane 对 memory-ingest 的对比讲反了 |
| kc_dedup「KC 创建写点触发」/「embed 完成链投」 | 双双击杀，唯一 refuted lane | 创建时 embedding=NULL 必扫空；链投上游每夜只跑一次，退化 cron-链-cron；改期一行等效且零代价 |
| hub_auto_sync「02:45 伪 barrier，可移除 offset」 | 证伪 | SUPERSEDE 分支夜批自主写 live 边，02:45 是唯一消费路径；hybrid 保留但理由基座重奠 |
| kt/axis「双双 remove（零消费者）」 | axis 半边证伪 | placement-profile.ts:117 live 显示读点 + export 备份；kt 死列属实但停跑是 owner 决策，不并入机制判决 |
| recalibration「盘中 b_calib 无人读，故零收益」 | 论据证伪、verdict 保留 | state.ts:942 / candidate-signals.ts:203 在线读 effectiveB；但收益量级小 + 排序契约（须在次日锚刷新后）锁死可删性 |
| brief sweep「global 腿无自然事件」 | load-bearing 前提击杀、verdict 保留 | scope_tagger.ts:40 无条件塞 'global'，global 已事件触发；cron 保留理由改为冷启/DLQ/丢投/dormant |
| practice 链「backfill 整体事件化」 | 半案否决，hybrid→keep | cron sweep 本就是漏投唯一恢复网、空跑一条 SELECT 无压力、LLM 资产白天 fan-out 净负；「为不存在的排序上机器」 |
| item_prior「批量产题入口埋 enqueue」 | hybrid→keep | 绕过 25/夜预算闸、OCR burst 扇出、三块新基建换软收益 |
| research_meeting「reconcile 腿现在就建触发队列」 | hybrid→keep | 输出全 dark 零可观测差异；技术干净但违 smallest-sufficient；defer 到 ledger live |
| edge_propose「watermark handler-only 零改动」 | 机制缺陷击杀 | EMPTY_RESULT 重载「无事可做」与「吞错」两义，advance-on-non-throw 复现信号丢失；推进点须进成功写库路径 |
| promote_idle / prune_orphan / memory poll / frontier_fill / question_supply 的替代设想 | 全部 upheld keep | 七向攻击全空；反被加固（absence 谓词、安全网本体、outbox 判例、无写点锚、驻留聚合） |

**通用坑三条（所有 lane 反复撞到，未来提案先查）**：
1. `sendAfter/startAfter` 全仓零先例；
2. pg-boss v12 standard 队列裸 `singletonKey` 是 no-op，必须配 `singletonSeconds`（且只挡 pending 不挡 active）；
3. `writeEvent` 默认 `ingest_at=NULL` 进 memory outbox 扇出 brief-regen——任何触发化提案要么走 `boss.send` 不落 event，要么显式 `ingest_at: now` opt-out。

## 8. Linear 落地建议

**A. 更新 YUK-377（并入，不新开）— High（维持）**
- 贴 §6 全部事实修正（17→31、node propose 拆除、coach 链 retire、软契约降级、幻影注释位置）。
- 两档修复收窄：**完整档（boss.send 链投 / orchestrator DAG）判死**——对抗证实 offset 链非硬依赖，为不存在的排序上机器；轻量档聚焦四件：edge_propose watermark（按 §3.4 修正机制）、kc_dedup 改期一行、幻影注释清理、research_meeting 空跑早退。
- 附 §7 反驳实录防复查。kt_estimate 停跑/降周频作为 owner 决策项挂在本 issue。

**B. 更新 YUK-384（并入，不新开）— Medium**
- 立项措辞反转：02:45 不是伪 barrier（SUPERSEDE live 边唯一消费路径），cron 保留且 ordering 不动。
- Scope 改为 §3.2 修正版：actions.ts:619/:495 post-tx best-effort send + `hub_auto_sync.global` singleton(300s/nextSlot) 去抖全量 sweep；放弃单-hub 粒度。
- 验收补一条：确认 note-refine apply 事件的 outbox 扇出量级。

**C. 新开（草案待 owner 拍）：memory brief subject 腿事件化 — Medium/Low**
标题：`memory_brief_sweep hybrid：ingest handler 内 subject 桥事件触发 + cron 降为兜底`
- triggers.ts:328-330 追加 QUALIFYING_ACTIONS → `resolveQualifyingEventSubjects`（导出）→ enqueueBriefRegen(subject:X)，复用 6min singleton。
- 注明 global 已事件覆盖（scope_tagger.ts:40）；cron 职责收窄为冷启/DLQ/丢投/dormant。
- 风险登记：丢 maxSubjectsPerRun 帽（单用户可忽略）。

**D. 新开（草案待 owner 拍）：edge propose 不吃 review-again 失败 — Medium**
标题：`getFailureAttempts 谓词 action='attempt' 漏掉复习 again 失败（持久混淆最强信号）`
- queries.ts:176 谓词 vs submit.ts:544 `action:'review'`（finalRating='again'→failure）；与 cron/trigger 选择正交，独立评估是否扩谓词或另建输入面。

（YUK-372 不动：refill flag 翻开属其既有 scope；不为 confusable_contrast 新开——作为 owner 决策项并入 A。）

---

**附：审计副产品（非 cron 结论）**
- `src/server/boss/handlers/AGENTS.md` 的 cron catalog 只列 11 条、缺整条 practice 夜链——严重过时，应随本次修正一并更新（可并入 YUK-377 轻量档清单）。
