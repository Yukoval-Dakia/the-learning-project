# YUK-1340 Copilot 会话入口 — UI 设计 pre-flight

日期：2026-10-07。状态：实施前记录，依 owner 2026-10-07 持续委托由 agent 作出方案并承担验收责任，不再等待 owner 逐项批准。

## 授权依据（替代逐次批准）

[自主交付与本机运维授权](2026-10-07-autonomous-delivery-charter.md)：

> 本线程负责产品取舍、设计细化、实施、验证、必要修复、GitHub PR 与审查处理、满足仓库门禁后的合并，以及这台 Mac 上的配置、发布和运维。owner 主要通过使用建议提供反馈，不再承担常规任务排序、UI 方案确认、逐次实施批准或逐次部署批准。

> UI 的设计引用、组件形态和变更文件仍应在实施前明确，已有持续授权替代反复向 owner 询问。

本文件即「实施前明确」的记录：设计引用、组件形态、变更文件如下。

## 设计引用（逐字）

设计基线：`docs/design/2026-10-06-continuous-learning-system-behavior.md`（2026-10-07 由 agent 在本委托下采用为基线）。

1. 第 78 行（§4 用户怎样进入和使用产品）：

   > 产品接住三种同等正式的进入方式：继续已有学习、带着自己的事情来、让系统提出安排。任意一种都能进入完整的记录、帮助与后续跟进，不要求先走系统推荐。

2. 第 257 行（§7.6 停止、休息和回归）：

   > 回来时先利用已有记录恢复上下文，再按最新情况提出合适的继续方式。可以短暂确认重要变化，但不强制重走初始化测评。

3. 第 82 行（§4.1 回来时）：

   > 首页主要呈现可以继续的事情和有理由提出的建议。

生产缺陷记录（`docs/planning/2026-10-07-local-release-result.md` 日用验证第 1 条）：

> Copilot 默认选择最近的已结束会话，导致输入和快捷按钮全部禁用。打开对话记录、新建对话后恢复可输入，源码初始化逻辑与浏览器观察一致。应给出可继续的入口并保持历史只读。

## 组件形态

**drawer** — 全局 Copilot 抽屉 `CopilotDock`（`web/src/router.tsx` 根挂单一实例，内部 `CopilotDrawer` 壳层）。本次只改抽屉内的会话入口与 composer 上沿提示，不改路由、不新增页面/模态。

## 缺陷与方案

根因（`src/capabilities/copilot/ui/CopilotDock.tsx`，bootstrap `useEffect` 原 L767-787）：抽屉打开时无条件选择 `sessions[0]`（`listCopilotConversations` 按 `updated_at DESC` 返回的最新一条），不看 status；`conversationReady` 只对 `active`/`idle` 为真（原 L1546-1548）。当最新一条是 `ended`/`abandoned` 时，输入框、快捷 chip、出题、教学按钮全部禁用，且「新对话」入口藏在「对话记录」菜单里。

agent 在本委托下采用的方案（最小充分变更，只用既有 primitives / design tokens）：

1. **Bootstrap 只在用户没有有效选择时落位**：已有仍在列表中的选择（含用户显式打开的只读历史会话）永不被异步 bootstrap 覆盖。优先选择最近的 `active`/`idle` 会话（与服务端 `findReusableCopilotConversation` 的 live 判定一致：`status IN ('active','idle')`）；完全没有 live 会话且用户未选择时，走既有 `createConversation` 开新对话（与空历史同一条路），保证打开 Copilot 即可继续提问。
2. **只读提示 + 显式「开始新对话」**：凡当前会话不可继续（`ended`/`abandoned` 或尚无会话），composer 上沿显示一句说明与 `Btn`「开始新对话」按钮——历史查看保持只读，开始新对话的入口在禁用控件旁直接可见，不再依赖隐藏菜单。
3. **不重写历史**：不调用任何恢复/改写已结束会话的接口，不改 backend/schema/route；`conversationReady` 语义不变，`ended`/`abandoned` 仍不可发送。
4. **异步竞态防护**：`createConversation` 记录发起时的选择，POST 返回后仅当用户未改选时才落位新会话，列表照常刷新；bootstrap 自动建会话不得抢走用户在等待期间的显式选择。

## 将创建 / 修改的文件

| 文件 | 动作 |
| --- | --- |
| `src/capabilities/copilot/ui/CopilotDock.tsx` | 修改：bootstrap 选择逻辑、create 竞态防护、footer 只读提示 + 开始新对话 |
| `src/capabilities/copilot/ui/CopilotDock.session-entry.unit.test.tsx` | 新建：组件级 RED→GREEN 行为测试（多状态、多日期真实会话列表夹具） |
| `docs/planning/2026-10-07-yuk1340-copilot-session-entry-preflight.md` | 新建：本文件 |
| `docs/planning/2026-10-07-yuk1340-copilot-session-entry-evidence.md` | 新建：实施后证据记录 |

不触碰：`CopilotSessionPanel.tsx`（历史面板已只读展示 + 自带「新对话」）、server/api/schema/manifest、路由与 admission。

## P1 修正补充（2026-10-07 初审后）

初审发现 bootstrap 自动续接遗漏服务端 24h 复用窗口（GitHub discussion 4200151363）。修正范围：

| 文件 | 动作 |
| --- | --- |
| `src/capabilities/copilot/session-reuse.ts` | 新建：共享 `COPILOT_REUSE_WINDOW_MS` + `isWithinCopilotReuseWindow()` |
| `src/server/session/conversation.ts` | 修改：import 共享常量（re-export 保持兼容） |
| `src/capabilities/copilot/ui/CopilotDock.tsx` | 修改：bootstrap resumable find 增加年龄检查 |
| `src/capabilities/copilot/ui/CopilotDock.session-entry.unit.test.tsx` | 修改：新增 7 条冻结时钟测试 |
| `src/capabilities/copilot/ui/CopilotDock.durable-retry.unit.test.tsx` | 修改：夹具日期改相对时间 |
| `src/capabilities/copilot/ui/CopilotDock.tool-use.unit.test.tsx` | 修改：同上 |

不改服务端窗口政策、显式 sessionId 语义、API/DB/schema。验证与证据见 evidence 文档 P1 节。

## 验收映射

| 验收条件 | 落点 |
| --- | --- |
| 仅 ended/abandoned 时有清晰可用的新建入口 | 方案 1（自动开新对话）+ 方案 2（可见按钮）；测试 2/4 |
| 有 active/idle 且存在更新的 ended 时选中可继续会话 | 方案 1 优先 live；测试 1 |
| 显式查看历史保持只读 + 清晰新建动作，无隐藏自动历史变更 | 方案 2/3；测试 3 |
| 异步 bootstrap 不抢用户选择 | 方案 4；测试 4 |

## 范围与验证边界

- 只动 CopilotDock 与本地测试/文档；无后端、schema、provider、默认值、route、admission 变更。
- 本机只跑 scoped 组件测试 + `typecheck`/`lint`/`build`；完整 `pnpm test` 归 exact-head GitHub CI。
- 浏览器验收在本机补丁 UI + 合成 API 夹具上进行（fixture-backed，不写生产、不发付费消息）；不宣称生产已修复。
