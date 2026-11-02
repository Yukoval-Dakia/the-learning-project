# 原对话内一道确认题：UI 实际组合（YUK-1465 attempt_1 / YUK-1473）

## 设计 preflight 与范围

组件类型 **inline**，挂现役 MessageRow；不增加 route/modal/page。唯一原 Astra/high/default UI 作者，保 M3E 与已接受 cleanroom 方向。

原实施合同 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/yuk1465-confirmation-implementation-contract-20261102.md` §首片结果：
> 在目标已明确的 teaching 对话中，用户自报懂了后，给一次可拒绝、可延期的邀请；接受后只使用当前已准入、能自动判分的普通单题，在同一条对话中原生作答，通过既有 assessment 发行、原文保存、判分、activation 和 settlement。

`docs/design/2026-10-30-teaching-and-generative-ui.md` §任务顺序：
> 现役MessageRow/SkillTurnBlock/HeroBlock/InteractiveArtifactRenderer贯通
> 控件行为分离为本地探索与需要原业务owner处理的动作，按钮不能自行授权写入。

本片只消费确认题已交 wire，不实现 GenUI 分段/anchor，也不改选题、帮助资格、判分、撤回、费用、模型或配置。旧 ask_check 与纠错 chip 仍原 SkillTurnBlock；邀请/原生作答与当前 head 回执是独立内联块，不能把旧 teaching draft 当正式题。

UI写集：Copilot `ui/confirmation.ts`、`ui/replay.ts`、`ui/message-projection.ts`、`ui/durable-reconnect-storage.ts`、`ui/companion/{ConfirmationBlock,MessageRow,MessageStream,CompanionMount,CompanionPanel}.tsx`、`turn-sender.ts`；Practice `ui/ConfirmationAssessment.tsx` 与现有 `ui-public.ts` 窄原名导出；`web/src/RootShell.tsx`、`server/start/workbench-shell.tsx`；`src/ui-next/practice-studio/confirmation.css`；标准生成 `src/ui/lib/api-schema.generated.ts`；本设计文档。baseline 只追加协调已批准的一个精确 stable_contract。

## 正常组合与三处冲突

实际树 `/Volumes/YukovalSBak/yukoval-projects/tlp-ui-practice-studio-20261030`，旧分支 `feat/yuk-1473-practice-studio` 保留在 e691b0dde0e27e5cc07f69afd4b94a9d81319e1e。
fetch 后 main 固定 `02778f6d11bcd82f372c9b1b5452d80cc18bd537`；新分支 `feat/yuk-1465-confirmation-ui-attempt-1`，不改旧 PR，不 force。

- `9682166038377d9e59752d055dfdb2e75fb6f4b9`：parents main02778 + UI e691。
- `6520f96d86da155787415cce7da225bb320363e2`：parents968216 + backend `fcc2337d3ac9324d121cb2aba14863fcd8aa7e11`。
- `e947a7b1bd4ac7f8f0585fe4012518ad91a46890`：parents6520 + 完整2215 `3ce325727fc812a733c72d43f51eeb5f2c351045`。

原 repair-fcc resolved-TEXT/patch 实查截断：conversation-writes 11行、turns35行、execution632行，已报协调，**未应用**。原件失败保留。协调重新交付 merge-conflict-repair-6520f96d/LOCAL-conflicts-only-NOT_APPLIED.patch；按本次明确要求核 HEAD/MERGE_HEAD 和3 before SHA256匹配后仅应用局部四块并stage三resolved文件。保双方import、turns confirmation与public_prose均!forModel、execution correctionFiling+failure；冲突外没有改动。没有把截断文件覆盖真实 owner。三方组合不等于原2215旧R2覆盖新增UI，原两取消case批准缺口保留。

## 实际消息/展示/命令/恢复链

1. 原 `/api/copilot/turns` → 原 CopilotClient/listTurns → run-tracker/refetchTurns → replayToMessages/projectCopilotReply。新增 metadata 使用原 ConfirmationOccurrence 严格version1 decoder；assessment保持opaque交Practice解码。非法确认metadata显示不兼容，不降成按钮或普通确认。
2. 同一 occurrence 在消息流只取最早可见行作稳定展示位置，后续重复metadata不再建第二张邀请；仅在同一occurrence_id内比较sequence并禁用较早revision；不同occurrence之间不比较sequence。request_again的新occurrence从sequence=0开始，不受同LI旧occurrence的revision影响。服务端仍是occurrence真相源，这不是客户端去重/发行owner。旧行实际snapshot每次由原turns更新，最终提交后才解除旧动作等待，供明确request_again。
3. RootShell静态导入Practice原名ConfirmationAssessment，用依赖窄client的稳定memo renderer传CompanionMount→CompanionPanel→MessageStream→MessageRow→ConfirmationBlock。Copilot UI没有Practice value import。StartWorkbenchShell注入原startIssuanceStateClient/startResponseDraftClient；SPA走Practice已有HTTP client。不存在React server/practice-port、新registry或第二runtime。
4. Practice内完整展示owner校验occurrence/session、冻结DTO issuance/revision、原submission/group身份，使用原PracticeIssuanceDto/ResponseSet/GroupEvidence。优先原PresentationBlocks（select/blank/open等），旧格式用原ResponseSlotField/nativeResponseEntry；材料用原MathMarkdown/StimulusFigure。无usePracticeSubmit导航状态机，无伪review session。
5. 草稿初始只读turns内原draft与epoch；明确“保存草稿”走原saveResponseDraft/evaluation_group_ref/expected_save_epoch。失败/冲突停止提交，明确“载入原草稿”只get原issuance并替换本地未保存内容，沿原epoch；收到已有提交或不可用原因锁住并刷新turns。上传/未取得完整附件回执时禁止提交。未点保存的本地输入不承诺跨重挂载持久化，恢复按钮明确替换含义。
6. 显式accept/decline/defer/request_again/submit调用原TurnSender.sendConfirmation，保原session与teaching learning_item context，user_message为真实动作说明，confirmation严格version1、稳定command_id。submit只传response_set/group_evidence；评分坐标不由UI发明。普通send永不添加confirmation，也不猜“答案B”。命令在同发送栈用原Idempotency-Key/202/SSE/Stop/recovery。危机/撤回/结束的后端原防线保持；本地禁用非可继续会话、受限用途、正在更正、未确认或活跃run。
7. pre-202未知接纳保存原key/body/command/context；恢复显式使用原元组，禁止丢弃确认题未知元组后另建提交。只有确定拒收（或调用前校验失败）才解除本地提交锁供修正；网络/未知接纳不解锁新submit。202之后无重发，由原turns轮询/手动读取恢复。重复点击同步ref挡住，不依赖异步React渲染。
8. result issued/pending/review_required/effective/failed_pending分列；submission原文与pending_run_id可读。当前candidate只按effective_head.effective_evaluation_id选；activation/settlement receipt只匹配同effective ID，无head时不猜最后一条。显示真实effect/effects/theta_decision，不把correct等同于生效或独立掌握；unknown帮助明确限制。申诉/人工纠错后台与旧入口保持，没有前端重激活/再评分动作。

冻结DTO没有subject notation字段，本片不从当前页面学科猜题的notation，也不扩大原MathMarkdown门；真实数学题可读性仍需后续按原wire/reader补证，不称已验。原/native输入/附件链在源码接上，不代表执行过上传或提交。

## 公共边界与维护场景

确认题原文提交沿原 materializing 策略抑制实时/重放的“撤回本轮更改”入口；直接 checkpoint API 与原 cascade 策略也拒绝此根，避免仅撤对话却承诺撤销正式作答或结算。原文、判分与回执保留，合法申诉/纠错仍走原入口。

邀请授权检查在原短事务内持有 ask settlement、corrections:all 与包括邀请 reply 的排序 source 锁；发行及首次 activation 提交前保持互斥。provider 仍在这些事务外，不以重复无锁读取代替撤回串行化。

协调批准仅现有 practice/ui-public.ts 的 `ConfirmationAssessment` value export，target `ui/ConfirmationAssessment.tsx#ConfirmationAssessment`，owner practice，consumer RootShell命名import AST11；`ConfirmationDraftClient`为type-only。批准：https://linear.app/yukoval-studios/issue/YUK-1465#comment-6bd917e1-bee4-4db0-bb32-7412a523ef2d ，实际UTC date 2026-11-01。按原JSON只append一条changes，历史prefix/debts/pair/totals/offset/compatShims保持；不放行目录。

维护场景：更改原生输入或草稿CAS恢复只改Practice完整展示owner/原client；更改邀请、延期与命令接纳只改Copilot原owner/原sender。两者仅在稳定props/confirmation wire上协作，不互抄判分、发行、帮助或生命周期规则。加载闭包：组合根→两侧ui-public→既有Companion与Practice renderer；Practice renderer仅原core schema/已有UI/native/practice client，未新增server value入口。

## 验证与交付边界

证据目录 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1465/conversation-confirmation-ui-20261102/`。首次API生成/typecheck/lint/build均0。边界audit 159/0/14、深跨能力0/SCC0；architecture首次仅新public site未分类而红，原日志保留。后续parent精确批准后复验。UI收口第二轮typecheck0、lint因MessageStream格式换行一处红（不是共享schema红），已scoped修正；保原失败，不把后绿倒写成首轮全绿。

未新增/修改测试case，未运行tests/DB/provider/paid/native/browser/runtime/CI/部署，未push/PR/新review。pnpm在合并后首次exec依锁文件自动同步本地3增2减依赖，未下载新包、未修改package/lock之外的产品配置；该依赖变化来自原三方组合，不是本片新依赖。后续必要heavy静态检查沿既有共享limiter。

所有正确性结论限源码组合与静态门；未证明真实接受/拒绝/延期/提交、刷新重挂载/202、Stop/crisis/用途撤回、原生输入各题型、draft CAS、judge/receipt及键盘/明暗/窄屏实际行为。待协调验收完整固定UI/后端组合后唯一首次R1；不是原2215 R2的扩展，也不是运行GO。原1465/1473保持In Progress。

最终产品源码 typecheck exit0（checks-final.json）；后续仅MessageStream格式修正与批准台账追加，lint/build复验exit0（checks-resolved.json），lint保留161 warnings。API生成exit0。批准后architecture exit0，159/0/14、SCC0、+7 sites包含后端已批准6项和本UI新增1项；原未分类红独立保留。未手计KPI减量，不改debt，不将同逻辑组合称解耦收益。完整no-renames基线diff与UI增量diff及固定父引用在外置交付目录收口。
