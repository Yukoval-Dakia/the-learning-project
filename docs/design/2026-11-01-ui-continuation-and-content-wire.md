# 界面重写接续：练习队列与同消息内容合同

服务第一天能用；原票 YUK-1351 / YUK-1473，沿 Astra/high/default、M3E 和 Owner 已接受 cleanroom 方向。作者为唯一继任 UI writer；没有新 writer、线程或 review。

## 固定基线与设计 preflight

实际树 `/Volumes/YukovalSBak/yukoval-projects/tlp-ui-practice-studio-20261030`，实施前 HEAD `06d59c55ac4adb67fec2a771ca0271841d016d3a`、porcelain 空。保留其 parent `1149fbe495e71e6de4b33dac5e1e8ca557fffb6a`；不改原 2215 集成树。

设计原文：`docs/design/2026-10-30-teaching-and-generative-ui.md:16`：
> 其它页面依次：练习列表/今日 → 题库/详情 → 录入/用途/费用 → 知识/笔记/收件箱 → 教学其它入口/管理。每片覆盖真实页面及状态，不用统一换token当全部完成。新结构复用headless业务owner，不复制旧DOM当cleanroom。

同文第 3 行：
> 已接受页不重新选风格。

组件类型：page（现役 `/practice` 的练习流与列表标题；非新路由）。页面回答“现在从哪项练习继续？”；主要内容是真实队列及当前项，数据为原 stream 的日期、范围、预算、进度、来源、理由、题/卷标题、题数、估时、完成时间与判分；不造数据、不算额外学习成效。沿现有 M3E 语义色、字体和按钮，原风车花只在标题处装饰；队列突出当前项，后续项和完成事实保留原排序，手机转纵排。design-taste-frontend 作为应用界面指导，已锁风格不重抽；运行禁令优先，浏览器检查 NOT_RUN。

写集：新增 `src/ui-next/practice-studio/PracticeQueue.tsx`、`queue.css`；修改 `src/capabilities/practice/ui/PfStream.tsx`、`PracticeFacePage.tsx`；本设计文档。没有 package、API、业务 controller、transport、判分、恢复、测试写入。

`PfStream` 保有原 source fallback、current/allDone/scope 投影、skip/unskip/recompose 与 Copilot handoff；新 Queue 只接受展示值和现成 callbacks。`PracticeFacePage` 只改列表页头/作用域，不动 URL、请求、scope fence、保存、推进、焦点/scroll lifecycle。标题保有 h1，行保有 data-morph/data-morph-row。视图切换使用现有原生 radio Segmented；加练保 `send:false`，IME composition 不触发 Enter handoff。卷架、整卷作答及复盘内容仍是原页面，不称这些已完成重写。

## actual-main、候选与余下页面

2026-11-01 本轮 `git ls-remote origin refs/heads/main` 实得 `02778f6d11bcd82f372c9b1b5452d80cc18bd537`，与本地 origin/main 相同。以下仅对此固定远端 main 源码成立；不代表部署/运行。核对 git log、固定树文件和既有 merge receipts；不把历史 Done 当全站完成。

| 页面/能力 | 固定 main | 本地候选 | 尚缺交付 |
| --- | --- | --- | --- |
| 做题/伙伴 | 2163 `6b242a352`、2172 `96e699fb7` 的局部 M3E 已合，原 controller 与业务路径存在 | 已接受整页工作区与导航 `391685c45`，公开正文到 `1149`；2215 原子组合在原功能 owner。`06d59c55a` 是独立吉祥物/数学/GFM/短 prompt follow-up | 不能将 2215/06d 算 main；教学真实非空内容、流式/Stop/恢复、provider 输出未验 |
| 外壳/今日 | main 无 `src/ui-next/practice-studio`；Today 仍 LoomHero/KpiRow/各领域 blocks 聚合 | StudioShell/RootShell 新全局导航随整页候选；本树 Today 与固定 main 相同 | 今日完整展示仍缺；架构线 due-scope/Inbox consumer 另归父集成，禁止覆盖 |
| 练习列表 | main PfStream 仍旧织线布局；与本片前 PfStream 相同 | 本片重写默认练习流及专项队列、列表页头；新组件真实被 PfStream/PracticeFacePage 消费 | 本片静态候选待集成/独立审查安排与真实页面验收；卷架/整卷/复盘未重写 |
| 题库/详情 | 2022 统一题库及 Start readers 已有，旧布局保留 | 本片无新增 | 按既有 library owner 保留筛选/分页/计数/编辑/审核/删除恢复，再交完整页面 |
| 录入/用途/费用 | 2023/2031 既有功能；用途 2205 merge `6c8c500d9`、费用 2207 merge `c9fa68516` 已在 main | 本片不混入其它树 follow-up | 两个窄 consumer 不是全录入页重写；上传、历史及写路径运行缺口保留 |
| 知识/笔记/收件箱 | 既有页面及 reader 迁接不是 cleanroom 全页成果 | 本片无新增；Inbox labels/4consumer 与 due-scope 已交回架构 | 各真实状态、阅读编辑/审批与恢复验收尚缺 |
| 教学其它入口/管理 | 原功能 UI 保留 | 本片无新增 | 依原顺序逐页面重写，不能以公共 token 改色核销 |

**下一实际页面为 `/today`**：先吸收原架构 owner 的 due-scope 已批准接口，保 `due_count > 0`、缺 scope 旧缓存及本批计数语义；查询、冷启动、TeachingBrief、夜间交班、probe、提议、费用及画像各自 owner 不变。新展示可在本 UI 树推进，不能写架构树。卷架/整卷/复盘明确留账，不混称默认练习流全域完成。此顺序不等 2215 两 cancel TEXT 批准；本次提交可独立提取四个产品文件和本文，组件只依赖已合 main 的 ui-next/public 与 practice-foundation tokens，queue.css 独立有作用域；不导入未发布 studio.css 或消息恢复代码，不借本片重复发布 1149/06d。

## 原 GenUI 报告亲读与证据区别

本轮完整读回 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/yuk1473-practice-studio-20261030/generative-ui-owner-design.md`（179 行），包括末尾“最少必要验证与证据边界”。这是固定 06d 源上的**设计报告**，不是实现/审查批准。

轮换交接记“原咨询 usage 失败无有效报告”；历史记忆另记一份报告写成后只 `wc -l`、未完成要求的全文回读。这两条证据须分别保留：存在可读报告不能倒改失败 run 为成功；仅 wc 也不等于报告文件不存在。本轮已亲读实际文件并对下列源码交叉核实，不声称找回失败 run 的有效结论。报告里的提案可作为方案输入，不能冒固定 H 已有字段或后端接受。

### 真实支持范围（06d，源码证据）

- `companion/MessageRow.tsx`：StepList → ConversationMarkdown → SkillTurnBlock → 单个 HeroBlock → ProposalNotice/更正/撤回。不是任意多块交错。
- `ConversationMarkdown.tsx`/`SkillTurnBlock.tsx`：安全 MathMarkdown/KaTeX + GFM；表格局部滚动、消息脚注隔离和代码复制。真实非空教学运行仍 NOT_RUN。
- `primary-view-contract.ts`：一个 artifact/ephemeral_html/tool_result 联合，模型 nomination 不等于授权；`server/reply-finalization.ts` 仍验证真实 root tool/公开快照/存活引用。
- `HeroBlock.tsx`：artifact 可打开原页，interactive note 或 ephemeral HTML 使用 `InteractiveArtifactRenderer`；后者首位 CSP、`sandbox="allow-scripts"` 且无 same-origin。HTML 保存不等于内部 JS 状态可恢复；保既有 self-navigation 残余说明。
- `server/copilot-execution.ts` 当前发 prose_delta，`server/copilot-run-settlement.ts` 的 progress union 仅 delta/step；没有 content revision 协议。`ui/subtask-events.ts` 已按真实事件去重，public_prose 水位仅覆盖正文，不是通用结构游标。
- public_prose 后端完整组合仍归 2215，06d UI consumer 不能当本树后台已支持它。原报告描述的 ContentSnapshot/ContentBlock/control/compiler 都是 **PROPOSED**。

因此仍缺：有序原生块生产与持久化、生成中版本替换、终稿文本/块布局、统一恢复、逐块失败/取消、图表/图解/表单真实来源及动作 owner、状态持久化合同、完整窄屏/主题/放大/键盘/读屏证据。最终 HTML 卡不等于完整 Intelligent UI。

## 交原 backend/job-event/replay owner 的首片精确 wire（提案，未实施）

首个真实 consumer：现役 `MessageRow` 的同一条 AI 消息，目标是“正文 → 原生 comparison 或 steps → 正文”；不是新聊天页、工具 demo 或第二 transport。先支持两个 kind；chart/diagram/form 的 schema 和 consumer 后续各自同片进入，不提前铺组件库。

**生产入口**：原 copilot root execution 的 presentation control `present_content_block`。输入 `{block_id?: string, expected_revision?: number, spec, fallback_text, complete: boolean}`；新块二者均省略，更新必须同时提供服务端已返回 id/revision。服务端返回 `{block_id, revision, event_id}` 的已提交接受结果，或明确安全拒绝。沿 root tool_use_id 的幂等键，重试返回同一结果；不是业务写工具。id/session/run/ordinal/event_id 不信任模型自报。

```ts
// PROPOSED wire types, not a new runtime module in this change.
type NativeSpec =
  | { kind: 'steps'; title: string; items: { id: string; title: string; text_md: string }[] }
  | { kind: 'comparison'; title: string;
      columns: { id: string; label: string }[];
      rows: { id: string; label: string; cells: { column_id: string; text_md: string }[] }[] };
type ContentBlock = {
  id: string; ordinal: number; revision: number;
  after_prose_event_id: number; // first insertion anchor; immutable on revision
  state: 'loading' | 'ready' | 'failed' | 'cancelled';
  spec: NativeSpec; fallback_text: string;
};
type ContentSnapshot = {
  version: 1; session_id: string; run_id: string;
  last_event_id: number; // actual committed job event watermark, not prose or SSE cursor
  state: 'streaming' | 'completed' | 'interrupted' | 'failed';
  blocks: ContentBlock[];
  sealed_layout?: {
    reply_sha256: string;
    items: ({ text_range: [number, number] } | { block_id: string })[];
  };
};
// Existing SSE envelope retains event_id/event_type/payload.
// New event_type copilot_run.content; payload {version:1, block:ContentBlock}.
// Optional content:ContentSnapshot on original marker/turn/terminal projections.
```

- 严格 schema 拒额外键、重复 item/column/row id、缺/多 cells、不属于本 run 的 block 更新。首片建议上限：32 块/run、32KB UTF-8 JSON/块、256KB snapshot；steps ≤30，comparison ≤8 列/50 行，所有 id ≤120 字符、标题 ≤240、正文/回退受块总限额约束。不是原合同既定值，原 owner 应在实施回执固定；拒版本保旧安全版本，不能截断后报完整。
- `ready` 仅结构有效，绝不代表事实正确、判分成功或业务写入。说明文字经原公开内容策略，不将 raw/private tool result 填入 spec。Markdown 继续禁原生 HTML。
- publish 在原 settlement lock 中核 cancel/fence/terminal；先等待同 run 已接受 prose 的持久提交，取得真实 anchor，再写原 job_events。**commit 后**才返回 accepted/通知；Stop 先赢拒块，块先赢纳入终态。未闭合 tool 参数不发布；本片粒度是完整小版本，未闭合 JSON 子树流仍 UNKNOWN。
- 顺序以服务端 ordinal + 固定 anchor，修订完整替换；块和正文沿同一持久序列。UI fold 用 session/run/event_id 去重，旧 revision 不覆盖新值，同 revision 不一致留原值并安全降级；终态不能被晚包退回 streaming。全局 event id 有间隔正常。
- snapshot 覆盖已纳入水位的内容状态，只叠加更高 event id 的 suffix。正文快照只含累计文本和末尾水位不足以重建中间分段：原 owner **必须同时提供可恢复的正文 segment/event anchor 映射或等价有序布局**，否则在途刷新只能整段正文 + 块降级，不能声称交错恢复已完成。原报告没有把该前提写进 snapshot 形状，不能直接照抄实现。
- 原 reply marker 冻结 content，turns/REPLY/FAILED/DONE 从同一冻结对象投影；无 reply 的在途 turns 用原 session/run 事件。prune owner 保未冻结必要事件及冻结后快照，不新建 TTL/日志/会话。
- completed 继续 sealed reply_md/turns.text，failed/interrupted 保 public_prose；DONE 不能发明正文/receipt。finalizer 在 correction/披露/存储说明后产生 sealed_layout，范围按 JS UTF-16 半开区间完整、无重叠、无遗漏、不拆 surrogate/Markdown 结构，绑定最终正文 digest。这属于产品完整性机制，不是人工 hash/seal 流程。缺/无效布局时整段 sealed 文本 + 已允许块按序，披露恰好一次，不前端猜切分。
- 首片不将 primary_view_ref 混入增量 native union。原 HeroBlock 仍在最终获授权后显示一次；原 SkillTurn/StepList/ProposalNotice/更正/撤回保持。后续若放入布局，须同一 finalizer 授权与唯一引用。
- 首片只读 steps/comparison，没有业务 action。后续 form 必须有原 owner 的 action ref、参数验证、授权、幂等、receipt/unknown；无现成 callback 就只读/导航。内容恢复是必须；本地探索输入首版内存、刷新重置，不擅加 localStorage 或 model JS→host bridge。

### 精确交付接缝与写权

原功能 owner 先在其当前集成基线上交付：共享 `copilot/message-content-contract.ts`；真实 producer/control/compiler（`server/tools/present-content-block.ts`、`server/content-compiler.ts`、manifest/allowlists）；`server/copilot-execution.ts`、`jobs/copilot_run.ts`、`server/copilot-run-settlement.ts` 的 commit；`server/copilot-run-status.ts`、`copilot-run-outcome.ts`、`conversation-writes.ts`、`reply-finalization.ts`、`turns.ts` 的同源冻结投影；`api/contracts.ts` 与现有生成工件；原 `src/server/boss/handlers/prune_job_events.ts` 的保留策略。路径按 06d 定位；若其当前树已迁址，由同一责任 owner 映射，不建转发壳。本 UI 不写这些文件。

UI 在 wire 被交付后才接：`ui/message-content.ts` 纯 fold，挂原 `subtask-events.ts/replay.ts/message-projection.ts`；`companion/MessageContent.tsx` 原生 switch 和 comparison/steps，真实 `MessageRow.tsx` 消费；复用 ConversationMarkdown、原 tool/skill/hero/操作回执；`practice-studio/renderers.css` 补窄屏/状态/放大。无第二 store、无 useEffect、无新 writer，不擅修改 run-tracker/turn-sender/turn-actions。此写集是后续接缝，**本片未执行，也未为此增加审查轮次**。

## 验收边界

本片只交独立练习流展示源码和精确方案。业务动作与生命周期由原 owner，no provider/DB/paid/runtime/browser，测试 0 改/0 跑，无生成题、无新 review。06d 原 R1 仍只覆盖 06d，不转借本片；2215 两 cancel TEXT 未动。新片未独立审、未 push/CI/merge，不报 GO。

后续真实验收需在获准环境中检验：队列空/加载/失败/当前/已交/完成/跳过找回/专项，原跳过禁止 intervention、scope 不跨越、重排与点播真实动作，手机/明暗/焦点/morph/IME；GenUI 必须真实 run 在终态前产块，断线/刷新/Stop/乱序/晚包恢复同一 reply，公开/私密/终稿披露和真实动作 receipt 保持。静态门不能替代这些结果。

### 本片本地结果

最终产品源码的 `pnpm typecheck`、`pnpm lint`、`pnpm build` 均 exit 0，串行走本机 shared heavy limiter（≤2）；lint 保留 167 条仓库 warning，不称零告警。首轮也为三门 0，随后移除对未发布 studio.css 的依赖，改用已合 main 的 Button/Segmented 与 practice-foundation token，再跑最终三门，日志分别保留。scoped Biome 0；初次 unused Btn warning 已清除。`git diff --check` 0。

日志：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1473/practice-queue-20261101/{checks.json,checks-final.json,*-final.log}`。仅文档补记结果在验证之后；本轮没有 browser/业务/DB/provider/paid/runtime/测试/新独立review/CI。共享 Linear notes 工具返回 `Tool get_agent_context not found`，直接读取原 1351/1473 票及评论继续，未新建重复票。代码索引返回未就绪，按已知路径核源码；没有主动重建或调用 embedding。
