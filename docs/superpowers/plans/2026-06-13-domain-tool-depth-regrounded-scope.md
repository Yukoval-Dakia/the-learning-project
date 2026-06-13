# 领域/Copilot 工具深化 — Re-grounded 范围图（ADR-0031/0032/0033 ↔ M5 后代码）

> 2026-06-13 · Map 阶段产物（Workflow `wf_d3ea7732-5f9`，4 agents / 431K tokens / 98 tool uses）
> 缘起：owner 选「领域/copilot 工具深化」为 M5 后下一阶段（YUK-203 epic）。三个 ADR 写于 **06-09（重写前）**，本稿把它们对**当前 M5 后 capability-包代码**重新核实。
> 上游：`docs/adr/0031/0032/0033`、`docs/design/2026-06-09-mcp-tool-design-review.md`。
> 状态：**owner 已拍范围 + D1（2026-06-13）**，进 launch-phase。

---

## 决策已锁（2026-06-13 owner）

- **阶段范围 = B**：ADR-0033 接线（L1/L2/L3）+ L10 清理 + L7 边归档 + ADR-0032 结构活（L5→L6 + L8）。
- **D1 = 已弃**：现状（attribute_mistake 留 base 外 + 保留 CP+ chip + copilot 走 author_question(seed=variant) 出变式）是有意设计。**L4 → doc-only，并入 L10**：ADR-0032 标 D1 abandoned + 加 superseded 注，零代码。
- **L9（D3 learning_item 4→1 收敛）= 不入本阶段**（高耦合低价值，defer）。
- **仍待 lane 级裁决**（在各 lane pre-flight/plan 关口拍，不前置）：
  - **L8 grant 子集**（G5 / RP-4 / G6 哪些还要，还是已被 author_question(seed=record)+write_quiz 取代）→ L8 lane plan 关口。
  - **L2 摆位**（KnowledgeDetailPage 主列 vs NodeDrawer 侧栏）+ **L3 渲染策略**（inline vs route）+ **CSP 签字**（首个沙盒用户内容面，L1/L2 扩大暴露）→ L1/L2/L3 UI design-doc pre-flight 关口。

---

## 0. 总评（state of play）

三个 ADR 的高价值核心**在 M0-M5 重写期间已落地**，真正剩余工作远窄于单读 ADR 的印象。

- **ADR-0031（quiz C→A 内联出题）= 100% 完成**：keyword pre-dispatch（detectQuizIntent/resolveQuizIntent/runQuizSkill）已删；copilot 在自己 loop 里编排 `query_questions → author_question → write_quiz`；方法论住 `src/subjects/_shared/skills/quiz-gen/SKILL.md`；结构由 `QuestionAuthorDraft` schema 强制（吸收 YUK-302 的材料+小题 composite 树）；重 QuizGen/Sourcing agent 降级为夜间 pg-boss only。
- **ADR-0032（DomainTool 面重设计）= 一半已落、一半未动、一处被反转**：keystone D8（author_question 统一）/D9（query_questions·query_mistakes 分轴）/RP-2（tool-quiz-core）/RP-3（copilot write_quiz）+ D4/D5 分离半 + D6-draftwrite 全已落；**D1 在代码里被主动反转**（allowlists.ts:170-179、:298 故意把 attribute_mistake/propose_variant 留在 copilot base 外、保留 CP+ chip 面——与 D1「合并进 base + 拆 CP+」相反）；D3/D4-E1/D5-G6/G5/RP-4/D6-read≡write 未动。
- **ADR-0033（interactive 学习 artifact）= 后端+渲染器+临时态全通，持久渲染面半接线**：`ArtifactType='interactive'` enum + attrs.html 存储 + 沙盒 iframe 渲染器（`InteractiveArtifactRenderer.tsx`，sandbox 无 allow-same-origin + network-deny CSP）+ author_artifact/update_artifact 写工具 + copilot 临时态 hero 内联——全已落。**但 SPA 持久渲染面没接**：服务端在 /notes/$id 和知识节点页都已返回 interactive payload，却没有 SPA 组件渲染它 → **保存的 interactive artifact 在原对话之外不可见（实质 write-only）**。

**架构位移注记**：`src/server/proposals/actions.ts` 不再是收费站，已是薄路由壳；proposal applier 按包住 `src/capabilities/*/server/proposal-appliers.ts`；copilotTools 经各包 manifest 贡献制聚合。任何剩余 D-row 落在这些当前路径，**不在 ADR 命名的旧路径**。

---

## 1. Lane 切分（剩余真活）

| Lane | ADR | 规模 | 现状 | 范围 / 剩余 | 依赖 |
|---|---|---|---|---|---|
| **L1** notes reader 渲染 interactive | 0033 WS7 | S | 后端全done / SPA 零渲染 | `notes-api.ts` NotePage wire 补 `interactive:{html}` 字段 + `NoteReaderPage.tsx` 条件挂 `InteractiveArtifactRenderer` + 降级分支。复用已测渲染器。**UI pre-flight 必做** | — |
| **L2** 知识节点 discovery 面 | 0033 WS8 | S | 后端全done（`interactiveForKnowledge`+wire type）/ SPA 零渲染 | 渲染 interactive_artifacts 列表 + 链到 /notes/{id}。**UI pre-flight 必做** | L1 |
| **L3** CopilotHeroCard 持久态 inline vs route | 0033 WS6后续 | S | 临时态 inline done / 持久态退化为引用链接 | 决策 inline 渲染 or 路由到 L1 reader；若选 route-only 则并入 L1 | L1 |
| **L4** D1 doc-vs-code 调和 | 0032 D1 | doc:S / 重接:L | **代码已反转** | (a) ADR 标 D1 abandoned + 加 superseded 注 → doc-only；(b) owner 要重接则 attribute_mistake 进 base + 拆 CP+ + actor='user' 因路径 + force_reattribute + guard 分层（高爆炸半径） | **owner D1 裁决** |
| **L5** D6 read≡write 坐标修复 | 0032 D6-R6 | M | not-started | get_question_context 加 `include:['structure']` 返回可寻址 StructuredQuestion 树 + get_question_block_structure 草稿层 reader。纯读 | — |
| **L6** propose_question_edit（active 题） | 0032 D6-B | L | stale-target | 新 proposal-only 工具改 active 题 + mini verify gate。**对当前 active-题写路径建，非 ADR 命名的 YUK-281 write.ts（已不存在）** | L5 |
| **L7** 边归档 discriminator | 0032 D4-E1 | S/M | partial | proposeKnowledgeEdge 加 propose_create\|propose_archive 分支（lib archived_at 已支持，仅 propose 路径 create-only）。自含于 knowledge | — |
| **L8** copilot 读/grant 扩张 | 0032 D5-G6/G5/RP-4 | M | not-started | grant propose_record_links/promotion(G6) + get_review_knowledge_snapshot(G5) + 4 review_plan 工具(RP-4) 上 copilot base。机械 additive，可按 owner 批准子集拆 | **owner G5/RP-4/G6 裁决** |
| **L9** learning_item 收敛 | 0032 D3 | L | not-started | 4 工具 → propose_learning_item_transition(discriminated)。高耦合低用户价值，**建议 defer/drop** | **owner D3 裁决** |
| **L10** stale 注释 + ADR supersession 清理 | 全 | S | 注释漂移确认 | 修 question-author.ts:13 / proposal-tools.ts:1341 仍指 actions.ts 的旧注释；ADR-0031 search/write_question_draft→0032 D8 / ADR-0032 D1→反转 的 superseded 注。零行为变化 | — |

---

## 2. 需 owner 拍的决策

1. **D1 abandon-vs-regress（最关键，gate L4 + 塑造 copilot 错题归因 UX）**：代码故意把 attribute_mistake/propose_variant 留在 base 外、保留 CP+ chip——与 ADR-0032 D1 相反。是 D1 已弃（L4=doc-only）还是代码回归了（L4=完整重接，L 级）？
2. **G5+RP-4+G6（gate L8）**：copilot 没拿 4 review_plan 工具 / get_review_knowledge_snapshot / record_links·promotion 上 base，而是走了 author_question(seed=record)+write_quiz 平行路径。这些 grant 还要不要，还是已被 quiz C→A 取代？
3. **D3（gate L9）**：learning_item 4→1 收敛还要不要？高耦合低价值，**建议 defer**。
4. **D6 优先级（gate L5/L6）**：copilot 现已 author_question 出题 + 草稿层工具改题，prose/node 坐标错配的紧迫性是否降低？L5/L6 进本阶段还是 defer？
5. **ADR-0033 WS6/WS7 渲染策略（gate L3）**：保存的 interactive artifact 在 copilot hero **inline 渲染**（同 ephemeral_html）还是**always 路由**到 /notes/$id reader？
6. **ADR-0033 WS8 摆位（gate L2）**：知识节点 interactive discovery 列表放 KnowledgeDetailPage 主列还是 NodeDrawer 侧栏？
7. **ADR-0033 CSP 签字**：渲染器 CSP 含 `script-src 'unsafe-eval'`（在 exfil-only 威胁模型下 frame 不持任何 parent/user 数据，论证为非外泄通道）。这是项目首个沙盒用户内容面，L1/L2 会扩大暴露——值得 owner 显式签字（或主动收紧）后再 fan-out。
8. **Linear 对账**：ADR-0032 未完 D-row（D1/D2-guards/D3/D4-E1/D5-G6/G5/RP-4/D6）均未按 M5 后代码重新归档；YUK-302/303/306/308 应核实已 ship 部分（D8/D9/RP-2/RP-3/draft-writes）别双轨重做。

---

## 3. 推荐顺序

先做用户可见、低风险、零新安全面的 **ADR-0033 前端接线（L1→L2，L3 大概率并入 L1）**——这是唯一把已 ship 后端变成用户真能看见的 feature，价值/成本最高，全 S 级，复用已测渲染器。**L10**（注释+ADR supersession 清理）零风险，早期并行跑掉，防后续 agent 追 stale 引用。然后**拍决策**再碰 ADR-0032 代码：L4 形态全看 D1 裁决。决策后 additive 低耦合先行：**L7**（边归档，自含）、**L8**（copilot grant，按批准子集）。**L5→L6**（坐标修复→active 题编辑器）结构活留后。**L9**（learning_item 收敛）最后或 drop。

---

## 4. 风险

- **孤立读 ADR 会误导实施**：ADR-0031 命名的 search/write_question_draft 不存在（实为 author_question/query_questions/write_quiz）；ADR-0032 D1 描述与现码相反；都引 actions.ts 当收费站（现仅薄壳）。任何 lane 必须对当前路径建，否则产生死/错位代码。L10 缓解。
- **ADR-0033 半接线持久路径**（主 shippability gap）：author_artifact 存的 interactive 只在原对话临时 hero 可见，重开看到空壳。L1+L2 ship 前 = write-only。
- **孤儿 draft 累积**（ADR-0031 D5 phase-deferred）：dismissed question_draft 从不归档（proposal-appliers.ts:266-269）。**仅在所有面持续排除 draft_status='draft' 时无害**——该排除契约是 load-bearing；新 query_questions 默认 include_drafts=TRUE，若某查询丢了过滤，copilot-authored-but-dismissed 草稿会漏进题池/复习。
- **面变更不变量脆弱**：registerCoreTools（bootstrap，仍作 standalone worker 幂等兜底）与 manifest copilotTools 贡献都注册进同一 registry。任何面变更（L4/L7/L8/L9）须同步 bootstrap CORE_TOOLS 顺序 + allowlists + 包 manifest + 保持 copilot-tools.unit.test.ts 集合相等绿。旧 34/14/16/4 计数已变 25 copilot==5-manifest union / 38==CORE_TOOLS。
- **CSP `unsafe-eval`**：沙盒 frame 可自导航到带参外链 + `<a ping>`/dns-prefetch（无 navigate-to 强制）。exfil-only 模型下 accepted（frame 无 parent/user 数据），但 L1/L2 扩大暴露，值得签字。
- **HTML 三存**（attrs + mirror-event args + tool_call_log）是 update_artifact 回滚的故意 seam；未来「存储优化」去重会静默破坏回滚——标记给后续成本/存储工作。
