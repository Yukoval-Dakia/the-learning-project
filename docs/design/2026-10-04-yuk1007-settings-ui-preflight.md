# YUK-1007 — 设置页 UI preflight 更新

2026-10-04。状态：owner 于2026-10-04明确“批准”；按本文件范围实施。
以配置读面、原生 pi provider 迁移、预算/语言 reader 和当前写接口为基础。
Owner 已要求以主线为主，此方案不包含依赖升级。

## 1. 设计原文

以下逐字引自 `docs/design/2026-09-26-yuk1007-settings-panel-preflight.md`：

§2：
> **类型：新增一条 route（kind: page）**，route 路径 `/admin/config`，surface id `admin-config`，owner `observability`，照常套主 chrome（RootShell）。

§3.3：
> 配置面是天然密集面——**committed controlled density**：表格 + mono 值列 + meta 字号，与既有 admin 面同密度档；不做卡片化稀疏排版，不做营销式视觉。总览区是唯一例外（计数卡用既有 `Card`）。

§5：
> 全部写动作：经 `/api/admin/*`（x-internal-token gate，既有 `apiJson` 自动带 token）；留痕遵循 `admin-trait-journal` 既有审计先例（每次写记 journal，谁/何时/前后值）。

## 2. 组件类型与本批范围

类型为 route/page：`/admin/config`。复用主壳、PageHeader、TabBar、Button、Badge、
Card 与现有加载/错误态；行内编辑和确认，不新增 modal/drawer 或设计 token。

保留总览、功能开关、AI 模型、阈值、语言、调度运行六个分区，计数来自实际响应。
首批开放 chat task 的原生 provider/model、已接线预算字段和 AI 输出语言编辑；
系统开关、阈值、scoped lane/rejudge 与调度运行先展示。它们的编辑继续留在1007，
不将页面交付等同于整个epic完成。Typed任务先只读，避免旧providers.implemented
读面未表达typed专用provider时给出错误选择。

## 3. 核心交互与生效说明

- provider来自后端目录，model仅从所选pi原生provider目录选择；同时显示原生身份
  与协议。provider/model成组保存、成组恢复默认；浏览器不接收或保存provider密钥。
- 编辑前后对比当前配置，行内确认后才写入。非法模型/能力组合使用后端错误显示；
  不在前端另造provider协议、UA或compat实现。
- 配置值与当前运行选择分列，operator全局固定明确显示。未设密钥的provider禁用并说明。
- 预算按budget_wiring逐字段开放；chat maxCost与typed maxIterations不冒充已生效。
  超时使用秒显示，保存毫秒值；上界小于一小时。恢复默认只清所选配置组。
- 语言首批为简体中文/English，作用于下一次AI调用。UI界面语言仍为中文。
- 保存后刷新读面；已提交但本进程快照未更新时显示“已保存，等待刷新”。不宣称
  worker已确认；后台通常每15秒刷新，失败可延后。
- 搜索/分区深链/加载/无匹配/缺配置/失败重试均使用既有交互模式。

## 4. 将新增的文件

- `src/capabilities/observability/ui/config.tsx`：页面与查询、分区。
- `src/capabilities/observability/ui/config-sections.tsx`：六个分区与语言行内编辑。
- `src/capabilities/observability/ui/config-model.ts`：类型、过滤、配置/生效投影。
- `src/capabilities/observability/ui/config-task-editor.tsx`：原生provider/model与预算编辑。
- `src/capabilities/observability/ui/config-model.unit.test.ts`
- `src/capabilities/observability/ui/config.render.unit.test.tsx`
- `src/capabilities/observability/ui/config-task-editor.unit.test.tsx`

## 5. 将修改的文件

- `src/kernel/ui-surfaces.ts`：route、标题与命令搜索声明。
- `web/src/router.tsx`：lazy路由挂载与查询状态传递。
- `src/capabilities/observability/ui-public.ts`：lazy页面入口。
- `src/capabilities/observability/ui/observability-shared.tsx`：AdminLinks配置入口。
- `src/ui/shell/nav-config.ts`：复用settings图标。
- `src/capabilities/observability/AGENTS.md`：文件职责同步。

沿用现有Admin入口到互链的导航，不顺带改造其他admin页面。API生成类型已经随
写接口生成，页面消费既有契约，不手写第二份服务器契约。

## 6. 验收

验证provider变更同步更新model候选、保存完整成对payload、取消无写入、恢复默认、
无key/全局pin/typed/未接线预算的准确状态，以及失败和待刷新提示。
验证键盘可达、标签与错误可读、分区深链、surface inventory、生产bundle和浏览器走查。
本批不再使用付费额度；协议行为由已交付真实pi驱动/本地HTTP回归证明，页面测试
验证实际管理接口契约。UI上线不等同于生产部署授权。
