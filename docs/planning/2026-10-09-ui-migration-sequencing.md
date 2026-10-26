# UI 渐进迁移顺序与交接责任

更新：2026-10-27（Asia/Tokyo）。当前 UI 设计、实施、视觉复核由 **Astra** 承担，全面采用 **Google M3 Expressive**。
[Owner 决定](https://linear.app/yukoval-studios/issue/YUK-1351#comment-dcadddc1-14ab-4c44-a60f-00809a0588ba)已生效，
[正式方向与固定主线事实表](../design/2026-10-27-m3e-direction-and-migration.md)是当前入口。
本文件只给顺序与交接，不扩大 UI 实施、provider、TEST 写入或部署权限。

## 当前现状与已覆盖前置

核查基线 `8fd39d07f270bcb41508ffc51c8300153580e668` 已合 ui-next 基座、做题 #1831、学习伙伴 #2020、题库 #2022、录入 #2023、classic 显式复核 #2031，
以及 #2066/#2067/#2071 的 Start reader 接线。它们是旧视觉方向的源码交付，不能列作 M3E 已交或真实写入/恢复全部通过。
伙伴真实样本失败与流式 Stop 未验、题库写路径、录入上传/识别/history 全链缺口继续留 YUK-1473；具体证据与限制见正式方向 §2、§6。
外壳/今日的 V3 仅样稿，不是 M3E main 实现。

2026-10-09 的「等迁移全部退出才改首个现役页面」「UI 只交 Opus 5.5」「先建 showcase」是下方保留的历史，
不覆盖 2026-10-11 做题+学习伙伴首张真实页面决定和 2026-10-27 M3E 决定。
不再等待 A/B/C 风格选择。非视觉迁移仍保留已批 reader/transport 接缝；M3E 不成为其新前置。

## 当前顺序

| 交付 | 入口与完成边界 | 交接 |
| --- | --- | --- |
| 基础进入现役做题页 | scoped tokens / primitives 与 `PracticeSolo` 的标题、主操作、状态控件同片有真实 consumer；首片不声称完整页面迁完 | Astra 仅 `ui-next` 基础与页呈现；`PracticeClient`、`usePracticeSubmit`、Start route/client 由现有线保持 |
| 做题 + 学习伙伴完整代表页面 | 扩至适用组件、全部产品状态、亮暗/适配/键盘/动效；真实保存/恢复/Stop 分别验收 | Astra 负责 presentation；唯一 `CompanionMount` 生命周期、controller、发送/接受/恢复及 domain owner 不变 |
| 外壳 / 今日 | 将已验证的规范用于真实壳与今日；不以 V3 样稿冒充已交 | `RootShell` 展示 hunk 与 Start host/query/auth/navigation hunk 分开；今日业务决策不下沉组件 |
| 其余页面 | 题库 → 录入 → 其余现役面，按原功能票逐片；每片圈具体文件与真实 consumer | library/record 的读写、失效、分页、恢复与 paid 合同由当前 owner 负责；没有整目录冻结 |

最小下一片的精确候选文件、后续片范围及对应验收见正式方向 §4–§6。
组件数、行数和迁移百分比不作完成定义；不新建通用框架、展示入口、第二套 QueryClient、鉴权或业务状态。

## 接缝与移交规则

- Start adapters 保持鉴权、epoch 与现有 public typed domain contracts；旧/新 renderer 共用读取 DTO 与命令契约。
  不为「取齐数据」合并独立的 loading、error、pagination、refresh 或时钟；已有聚合直接复用，不造无人消费的 view-model。
- UI 仅变呈现与交互，不重写排序、选择、恢复、提交确认或重试策略；不能从 GET/read 名称推断无 queue/paid/写入。
  真实 reader 与 write/recovery 对照见正式方向 §5「精确交接合同」。
- 非视觉 writer 的已批精确接缝继续有效。例如 YUK-1358 的 #2086 `MyHistory` id-only mistakes reader 在本次基线之外，
  其 client/host/query 接缝保持由原 writer 完成；Astra 只在未来页面片内协调展示 hunk，不冻结整个文件或 practice capability。
- `ui-public.ts`、`RootShell`、共享 client 类型、routes/生成 route tree 逐 symbol/hunk 交接；不能凭“UI 文件”或“transport 文件”独占整文件。
  由 Start owner 处理 router/frontdoor/boot 与真实路由挂载，Astra 交已明确的组件与 props；不跨入领域内部端口。
- 新片开始核 fresh main、原票当前 owner 与真实 diff；共享 hunk 若重叠先由协调线指定先后，不抢写、不复制另一个恢复 owner。
  各 lane 隔离 worktree，一树一个 writer；原 UI 树的私有 PLAN/now/样稿状态不搬入新提交。
- 同一路由的 renderer 回退只影响呈现，不回滚数据或重放写入；不重建已退出 SPA/Hono 回落。
  旧 renderer 退出仍需原票真实流量与验收，一周无人用不算通过。已拒 NO-GO、不完整 callback 壳及无 consumer abstraction 不迁入。

## 验收与本次范围

源码静态、CI、实际部署 revision、真实页面、写入/恢复与 provider 输出分别报告。
未执行写明 NOT_RUN；真实运行缺口留原票，不把计划、样稿、typecheck/build 或 CI 当页面完成。
未来测试代码先由 owner 批准文本方案，测试不阻塞开发；本次测试零写零跑，构建/浏览器/provider/DB/TEST/paid/容器/部署均不执行。

本轮仅正式文档与本地固定提交，由协调线继续读 diff、处理 PR；不 push、启动独立 review、merge 或 watch。
YUK-1351/YUK-1473 仍 In Progress，无新增同义票。已知 Inbox 计数失效、同源字体/CSP、未知费用展示等问题沿用原归属，
不因 M3E 改名重开，也不把它们混入本片修复。

## 历史：2026-10-09 原交接全文

以下原文原样保留，供追溯当时的顺序与约束。当前模型、视觉、首张真实页面排期及禁止专用演示入口以上文为准；
领域合同、无全局污染、真实验收和退出安全等仍适用。

# UI waves and migration ownership

Owner schedule communicated by YUK-1353 on 2026-10-09: existing pages are not redesigned during migration. UI rewrites follow functional waves, with backend delivery before the Opus 5.5 UI change. This records the migration coordinator response sent to the visual thread and Start owner; it does not replace PR1612 or claim three-party agreement is complete.

Start adapters retain authentication, epoch fencing and existing public typed domain contracts. Old and new renderers consume the same contracts. “Fetch the page data together” does not require a single aggregate or request: independent loading, errors, pagination and refresh remain intact. Existing aggregates are reused; no unused view-model layer is introduced. Existing pages receive only necessary behavior fixes and transport changes during migration.

A later UI wave may switch renderers within one Start route. This is not legacy SPA fallback, a second application, or a reason to retain old runtime paths. The Start owner implements the route switch when that wave has a real consumer. Switching rendering must not replay commands or roll back data. The owner's one-week P0/P1-free observation period applies to removal of the old renderer; meaningful traffic and acceptance evidence remain necessary.

YUK-1354 may prepare an isolated design-system foundation, proposed under src/ui-next/, with scoped tokens, primitives, shell and showcase components. This directory is a proposal, not a current worktree conflict check. No global reset, :root/body styling, application font change, second auth/query state or real business writes. A hidden showcase route is still owned by the Start integrator (5796); the UI author supplies the component and props without editing Start routes, generated route tree, router, frontdoor or boot. Dependency/build changes require separate ownership coordination. YUK-1395 remains confined to prototypes and dedicated static assets.

Existing follow-ups are handed to the visual planning lane without duplicate tickets: Inbox dismiss leaves the sidebar count stale until reload (shared invalidation contract); Google Fonts is blocked by CSP (solve font delivery without loosening CSP); YUK-1382 distinguishes unknown costs from actual zero. The first is a behavior correction, not merely visual styling.

No reliable SPA-retirement date is established. Remaining task families and recovery ownership, judge gates, remaining Start consumers and canonical boot, plus dev/build/image/restore and legacy exit evidence remain open. The first rewritten existing page follows migration exit and uses Start directly. Foundation/prototype work may proceed independently. Restore acceptance remains the active implementation lane.
