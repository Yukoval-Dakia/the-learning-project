# 管理后台写入页：M3E 呈现（学科 / 学科特征 / 配置）

YUK-1473 · 2026-11-03 · 交付阶段：第一天能用（删旧界面，逐页迁移）· 批次 B（批次 A 见
`docs/design/2026-11-03-admin-readonly-m3e.md`，#2394）

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:95`（§5「其余真实页面」）：「其后 notes/knowledge/coach/profile/admin 等按原功能票、真实修改面逐页圈定」；同表最后一列「每页都有实际 consumer、完整状态表与旧行为对照；写入/恢复/paid 缺口留原票，不能用静态页面替代」。
   - 同文 `:98`：「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」
   - 同文 `:100`：「作用域、无全局污染、同源资源、无业务规则等承重限制保留。本次不修改任何 AGENTS.md；具体实施需列出发生冲突的规则及依据，不静默扩大路径权限。」
   - `docs/design/2026-10-07-ui-visual-direction.md`：`:297`「T1 组件只引用语义 token」；`:300`「T3 玻璃只给浮层」；`:323`「M1 只在变化时动」；`:359`「M14 三态：每个区域都设计载入（与布局一致的骨架…）、空（带进入动作）、出错（区域隔离、可重试、已保存的工作不受影响）」；`:366`「A2 触控目标：触屏上每个可点击目标的点击区 ≥ 44×44px」。
   - `docs/design/2026-11-02-config-catalog-presentation.md`（配置页上一片）：「配置面是天然密集面——committed controlled density：表格 + mono 值列 + meta 字号」；「不新增 credentials/custom-provider CRUD UI」。本片沿用，表格仍是表格。
   - 协调裁定（2026-11-03）：批次 B 只换呈现。每个写的 payload、确认步骤、忙时禁用、失效、出错呈现与跳转逐字不变；表单草稿、脏状态、校验消息不变；不新增 `useEffect`、不加测试、不碰服务端、`ui-public.ts` 导出、`config-model.ts`、`admin-client.ts`、`admin-control-client.ts`、`write-invalidation.ts`；不出现嵌套三元；有副作用的切换不用 `Segmented`。
2. 组件类型：page（三个已有路由的整页）。没有新路由、弹窗或抽屉。路由宿主 `server/start/routes/admin.subjects.tsx`、`admin.subjects.$id.tsx`、`admin.config.tsx` 一个都没改。
3. 文件：
   - 修改（只改呈现）：`src/capabilities/observability/ui/subjects.tsx`、`subject-traits.tsx`、`config.tsx`、`config-sections.tsx`、`config-task-editor.tsx`、`config-provider-catalog.tsx`、`admin-frame.tsx`、`admin-m3e.css`、`observability-shared.tsx`；批次 A 的 `admin-cost.tsx`、`admin-failures.tsx`、`coverage-lattice.tsx`、`conjecture-scores.tsx` 只改页标题文案（后两个同时改用共享的六链接常量）；`web/src/globals.css`（只删规则）。
   - 删除：`src/ui-next/config/config.css`（配置页旧样式，唯一使用者就是配置页）、`src/ui/primitives/Badge.tsx`、`src/ui/primitives/PageHeader.tsx`（最后的使用者是本片三页）。
   - 新建：本文件。

## 先把所有写入列清楚

页面上所有会改服务端数据的动作（`admin-control-client.ts` 的写方法全部在这里，没有别的）：

| # | 写入 | 端点 / payload（未改） | 触发与确认（未改） | 忙时禁用（未改） | 成功 / 失败（未改） |
| --- | --- | --- | --- | --- | --- |
| 1 | 改名 `renameSubject` | `PATCH /api/admin/subjects/:id` `{expectedRevision, displayName}` | 「rename」→ 输入框（`maxLength=32`，`aria-label="新科目名"`）→「确认改名」直接提交，无二次确认（原样） | `run.isPending` 或名字为空 | 成功：关输入、清名字、清确认、`invalidateAll`；失败：CAS 409 → 横幅 + 失效，否则行内错误 |
| 2 | 退休 `retireSubject` | `POST …/retire` `{expectedRevision}` | 「retire」→ 确认块（原文案）→「确认」 | `run.isPending` | 同上；失败时清确认 |
| 3 | 恢复 `restoreSubject` | `POST …/restore` `{expectedRevision}` | 「restore」→ 确认块 →「确认」 | 同上 | 同上 |
| 4 | 重置 `resetSubject` | `POST …/reset` `{expectedRevision}` | 「reset」→ 确认块 →「确认」 | 同上 | 同上 |
| 5 | 预检 `validateSubject` | `POST …/validate` `{traitPayloadOverrides: {[kind]: payload}}`（不落库） | 「预检」直接调用 | `validate.isPending` | 结果写进「预检通过 / 预检失败：…（前 5 条）」；JSON 非法时只显示字段错误 |
| 6 | 本科写 trait `editSubjectTrait` | `PUT …/traits/:kind` `{expectedSubjectRevision, expectedTraitRevision, payload}` | 主保存按钮：自有且共享 → 确认块「确认写入」；否则直接保存（非自有时自动 fork，文案预告） | `save.isPending` | 成功关面板 + `invalidateAll`；失败：CAS 分流 / 行内错误，清确认 |
| 7 | 共享面写 `editSharedTrait` | `PUT /api/admin/traits/:traitId` `{expectedRevision, payload}` | 「编辑共享面（影响 N 科）」→ 确认块（列出全部受影响科目）→「确认写入」 | `save.isPending` | 同上 |
| 8 | 恢复出厂 `resetTraitToSeed` | `POST /api/admin/traits/:id/reset-to-seed` `{expectedRevision}` | 「恢复出厂」→ 行内确认（「影响全部 N 科」）→「确认」 | `run.isPending` | 同上；失败时退出确认 |
| 9 | fork `forkSubjectTrait` | `POST …/traits/:kind/fork` `{expectedSubjectRevision}` | 「fork」打开的面板本身就是确认 →「确认 fork」 | `run.isPending`；general 上「fork」禁用 | 同上 |
| 10 | 换绑 `rebindSubjectTrait` | `PUT …/traits/:kind/binding` `{targetTraitId, expectedSubjectRevision}` | 「换绑」→ 候选列表「选择」→ 确认块 →「确认换绑」 | `run.isPending`；general 上「换绑」禁用 | 同上；失败时清选中 |
| 11 | 回滚 `rollbackTrait` | `POST /api/admin/traits/:id/rollback` `{expectedRevision, targetRevision}` | 「历史」→「回滚到此」（当前 revision 没有）→ 确认块 →「确认」 | `run.isPending` | 成功关面板（原 review-766 P2）+ `invalidateAll` |
| 12 | 配置写 `patchConfig` | `PATCH /api/admin/config` `{changes}` | 语言「保存语言」、任务「保存模型组合」「保存预算」→ 确认 `fieldset` →「确认变更」 | `pending`；确认期间两个编辑 `fieldset` 整体禁用 | 记 `committed_epoch` + `query.refetch()`；失败显示 `role="alert"` 错误 |
| 13 | 配置清除 `resetConfig` | `POST /api/admin/config/reset` `{keys}`（全部变更都是 clear 时才走这里） | 「恢复默认语言」「恢复默认模型」「恢复默认预算」→ 同一个确认 `fieldset` | 同上 | 同上 |

- `invalidateAll`（学科页所有写成功后）：清 CAS 横幅，失效 `['admin-subjects']`、`['admin-subject-traits', id]`、`['admin-trait-journal']`（前缀）、`['admin-traits']`、`['subjects']`。CAS 409（带 `currentRevision`）先失效再置横幅。这些都没动。
- 没有任何乐观更新（原来就没有）。
- 这三页**没有**：新建科目（列表页按 RL5 零写按钮）、自定义 provider 的新增 / 删除、任何凭据录入。客户端里也没有这些方法。
- 写入之外、会丢草稿的切换（原样保留，没有变成方向键可触发）：trait 行的「编辑 / fork / 换绑 / 历史」切换会卸载另一个面板（含未保存草稿），仍是按钮点击；配置页分区切换（`key={section}` 重挂载）仍是按钮点击写 URL，不是 `Segmented`；「编辑 {任务}」在已有编辑器打开时禁用（原样）。

## 密钥与凭据

- 这三页**从来没有**密钥输入框，现在也没有；没有 `type="password"` 字段可保留，也没有新增。
- provider 凭据只显示服务端事实：「凭据：服务端已配置 / 服务端未配置」（`key_present`）、认证状态（`providerStatus`，现在放在色调芯片里：已配置 → positive、认证失败 → critical、其他 → neutral，文字不变）、认证失败时的 HTTP 状态和错误类型，和原文「这里只显示已有结果，不发起认证探针」。服务端契约 `admin-config-contracts.ts` 本身注明「绝无凭据值 / 绝无 secret」。
- 任务编辑器仍写「凭据只在服务端管理」。概览数字块「凭据已配置」仍只是 `key_present` 的计数。
- 发给服务端的内容一个字节都没变（见下面的逻辑证明）。

## 做了什么

- **外壳**：三页都换成批次 A 的 `AdminFrame`（`<UiNextRoot className="adm-page">` + `main.adm-main.un-m3e-bridge` + `ToastHost`），八个管理页现在同一个外壳、同一套面板和表格。配置页原来自带的 `data-un-m3e` 根和 `un-config` 样式表退出；颜色经 `RootShell` 上的 M3 角色和 `.un-m3e-bridge` 读取，同批次 A。
- **页内导航**：`AdminNav` 放在页面最上方。目标和顺序都与原来一致：学科列表是原来的六个（不含配置，和覆盖 / 猜想页同一组，抽成 `ADMIN_LINKS_NO_CONFIG`）；学科详情是原来的六个（第一个是返回，标签「← 学科配置」，后面是运行 / 成本 / 失败 / 覆盖 / 猜想）；配置页是原 `AdminLinks` 的七个（`ADMIN_LINKS`）。
- **学科列表**：一张「全部科目」面板 + 贴边表格（表头 `scope="col"`）。退休行改成文字变淡（原来是整行 55% 透明度）；名称后是 retired 芯片；origin / 通用是中性芯片；版本仍截 40 字并带 `title`；最后一列的「→」换成 chevron 图标链接（`un-hit`），读屏名「打开 {名称}」。
- **学科详情**：页头（小字、标题 = 名称、说明 = id · rev · version）→ 芯片行（origin / retired / 通用模式；为空时不占位）→ CAS 横幅（caution 底，「知道了」）→「科目操作」面板（rename / retire 或 restore / reset 一排小按钮；general 显示锁定说明）→「trait 绑定」面板（六行）。
  - 每行：kind（等宽加粗）、trait id、origin 芯片、owner / seed / rev / 共 N 科（灰字），降级时 caution 芯片（原 hard 黄档）；右侧「编辑 / fork / 换绑 / 历史」四个小按钮，打开时按钮是 secondary-container 底色（`aria-expanded`）。
  - 展开的面板是行下方一块 surface-container-low 圆角区：编辑面板是逐字段的等宽 textarea（字段名作标签，仍包在 `label` 里）；fork / 换绑 / 历史 / 各确认都用同一个 caution 底的确认块，文案原样，按钮「确认 / 取消」在下一行。换绑候选和历史 revision 是列表，等待确认的那一项会高亮。
  - 按钮层级：编辑面板的主保存是唯一的实心按钮；retire / reset / 恢复出厂 / 回滚到此用 critical 文字色（不是实心，也不放大）；确认按钮是普通次要按钮，取消是 ghost。没有任何按钮自动获得焦点，没有新的 Enter 提交（仍然没有 `form`）。
- **配置**：页头（小字「ADMIN · config」、标题「配置」、原说明；「刷新配置快照」带刷新图标放在页头右侧，抓取中禁用）→ 工具条（左：六个分区按钮，胶囊分段的样子但仍是普通按钮 + `aria-current="page"`；右：搜索框，标签「搜索配置」）→ 已保存 / 刷新失败 / 事实未就绪提示（positive 文字 / caution 条，`role` 原样）→ 分区内容。
  - 总览：四个数字块换成 `AdminKpi`；快照编号与说明；「部署固定项」表；「查看学科配置」按钮。
  - 功能开关 / 阈值：「所属模块」下拉（纯视图过滤，原样是原生 `select`）+ 带 caption 的表格。
  - AI 模型：说明 → 任务表（行头 `scope="row"` 是等宽任务名，专用通道显示中性芯片；全局固定是 caution 色）→ 编辑器在该行下方整行展开，surface-container-low 底；两个 `fieldset`（原生 provider 与模型 / 调用预算）+ 确认 `fieldset`，标签仍用 `htmlFor` 关联。→ Provider 与模型目录：每个 provider 一个原生 `details`（chevron 在打开时转正），摘要是名称 + 认证芯片 + 模型数；能力表仍在可键盘滚动的 `section tabIndex=0` 里。
  - 语言：一块面板，当前配置 / 消费（等宽）、说明、下拉、保存 / 恢复默认、确认 `fieldset`。
  - 调度与运行：「调度声明」面板 + 表格；「当前进程运行参数」面板 + 两列 `dl`。
  - 风车花（`Mascot`）不再放在配置页标题旁：八个管理页统一不放装饰。
- **嵌套三元**：新代码没有嵌套三元。原 JSX 里的嵌套三元换成同顺序的小函数：`generalModeCell`（学科列表）、`sourceLabel` / `envModeLabel`（配置项来源 / 生效）、`confirmSummary`（任务编辑器确认文案）、`runnableLabel`（模型可运行性）、`configAreaStatus`（配置页载入 / 出错）。逻辑层原有的嵌套三元（`config-task-editor.tsx` 的 `modelIssue` 与 `commit` 里的 `changes`、`subject-traits.tsx` 的 `saveLabel`、`config-provider-catalog.tsx` 的 `capability`）属于逻辑，按「只换呈现」没有改写。
- **动效**：只在变化时动：按钮 / 链接 / 分区的颜色过渡，输入框焦点描边，`details` 的 chevron 旋转，都读 `--un-t-*`（减少动效时 1ms）。没有入场动画、关键帧或转圈；玻璃只在 `ToastHost`。
- **触控**：ui-next `Button` 自带 `un-hit`；行链接与分区按钮加了 `un-hit`。会换行的写入按钮行（`.adm-acts`，含科目操作、编辑面板、确认块、trait 行右侧按钮）、分区按钮行和 trait 行头在 `pointer: coarse` 下 `row-gap: 16px`，做法同 `knowledge-m3e.css` 的 `.kn-prop-acts`：28px 按钮 + 16px 行距 = 44px，上下两行的点击区不重叠。trait 行四个按钮之间 4px 横向间距。候选 / 历史列表每行上下各 8px，相邻两行的「选择 / 回滚到此」同样正好 44px 不重叠。

## 删除旧样式与旧组件

- 方法同批次 A：严格整词匹配在全部 `.ts` / `.tsx` 里确认 0 使用、且原页面（本片三页的六个文件 + 随之失去使用者的 `Badge.tsx` / `PageHeader.tsx`）用过，再用 `tlp-status/_work/yuk1465/drop_css_classes.py` 删规则。扫描脚本 `tlp-status/_work/yuk1473/class_usage.py`，结果 `tlp-status/_work/yuk1473/admin-b/usage-globals.json`。
- `web/src/globals.css`：7374 → 7319 行，删 3 个类涉及的 10 条规则：
  - `page-head-row`、`page-head-actions`：严格扫描 0 使用。
  - `page-head`：严格扫描还剩 2 处「使用」，人工核对都是 `CoachHub.tsx` / `EffectivenessTrendPanel.tsx` 里的注释，没有任何元素带这个类；唯一产出它的是刚删掉的 `PageHeader`。所以 `.page-head`、`.page-head .meta`、`.page-head h1`、`.page-head .sub` 和 `.sessions-loom` / `.items-loom` 下的 `.page-head` / `.page-head-row` 都一并删掉。「list page-head chrome」那句分区注释改成「list header chrome」。
  - **保留**：`page`、`page.wide`（`PracticeFacePage`、`ColdStart`、`TokenGate` 还在用）、`meta`、`sub`（通用类，别处在用）。
- `src/ui-next/config/config.css`（171 行）整个删掉：`un-config*` 类只有配置页用，现在 0 使用。
- 页内样式：`subjects.tsx`、`subject-traits.tsx` 的全部内联样式常量，`observability-shared.tsx` 的 `AdminLinks`、`AdminLink`、`linkRowStyle`。
- 旧组件：删掉 `src/ui/primitives/Badge.tsx`、`src/ui/primitives/PageHeader.tsx`（全仓库 0 导入）。**保留** `src/ui/primitives/Card.tsx`（`PfShelf`、`PfPaper` 在用）、`Stateful.tsx` / `ErrorState.tsx` / `SkLines.tsx`（今日页、`AiChangesStrip`、`ProfileBand` 在用）。`LoomBadge.tsx` 里一句提到旧 `Badge` 路径的注释没动（I4，且只是历史说明）。
- `config-model.ts` 的 `inputClass` / `tableClass` 现在没有使用者，但该文件不在本片可改范围，留给后续（交协调线记入跟进，本片没有自己开票）。
- **与 `src/ui-next/AGENTS.md` I4 的冲突**：I4 说「never edit `src/ui/`, `web/src/globals.css`」。这一线有书面例外：owner 要求删除全部旧界面（2026-10-20），根 `AGENTS.md` 的 S13 规定「DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除」，方向文档 `:98` 要求「每片消费 M3E 后退出自己的旧样式」，`:100` 要求列出冲突的规则及依据。本片对 `src/ui/` 和 `globals.css` 只做了**删除**（两个失去最后使用者的旧组件、10 条已无元素命中的全局规则和一句注释措辞），没有新增或修改任何全局规则；新样式全部在限定作用域 `[data-ui-next].adm-page` 的 `admin-m3e.css` 里。

## 逻辑未变的证明

原文件先存到仓库外 `tlp-status/_work/yuk1473/admin-b/orig/`。三遍比对，脚本 `tlp-status/_work/yuk1473/strip_logic.cjs`、`jsx_handlers.cjs`、`tlp-status/_work/yuk1473/admin-b/jsx_attrs.cjs`（一键：`admin-b/logic.sh`），结果 `admin-b/logic-diff.txt`、`admin-b/attrs-diff.txt`。

第一遍（去掉 import 和注释、最外层 JSX 换成占位符后的逻辑）剩下的差异：
- `subjects.tsx`：新增 `generalModeCell`（原单元格里 `isGeneral ? — : 通用 ? 芯片 : null`，同顺序）；删内联样式常量。查询、key、60 秒轮询、`link` 帮手签名不变。
- `subject-traits.tsx`：新增 `NAV`（原链接行的六个目标与顺序）；去掉本地 `link` 帮手（同样的 `preventDefault` + `navigate` 在 `AdminNav` 里）；删内联样式常量。`isCasStale`、`errText`、两个查询、`invalidateAll`、`onWriteError`、所有 `useMutation`（`mutationFn` / `onSuccess` / `onError`）、`buildPayload`、草稿初始化、`saveLabel` / `needsConfirm` / `showSharedWrite`、`own` / `shared` 判定、换绑候选过滤逐字不变。
- `config.tsx`：新增 `configAreaStatus`（原 `isPending ? loading : !data ? error : ok`，同顺序）。`save`（全部 clear → `resetConfig`，否则 `patchConfig`；记 epoch；再 `refetch`）、查询及 15 秒轮询、`configSection`、`search` 逐字不变。
- `config-sections.tsx`：新增 `sourceLabel`、`envModeLabel`（同顺序同文案）。
- `config-task-editor.tsx`：新增 `ConfirmKind` 类型与 `confirmSummary`（四段确认文案逐字相同，`budget` 分支同样在渲染时调用 `budgetChanges`，与原来同时机）。`commit`、`modelIssue`、`disabledReason`、各 `useState` 初值不变。
- `config-provider-catalog.tsx`：新增 `runnableLabel`（同三段文案）、`authTone`（只决定芯片色调，文字仍是 `providerStatus`）。
- `observability-shared.tsx`：删 `AdminLink`、`AdminLinks`、`linkRowStyle`。
- `admin-frame.tsx`：新增 `ADMIN_LINKS_NO_CONFIG`；`AdminArea` 新增可选 `inline`（嵌在面板里时不再套一层卡片）。
- `coverage-lattice.tsx`、`conjecture-scores.tsx`：本地 `NAV` 删掉，改用内容相同的 `ADMIN_LINKS_NO_CONFIG`。
- `admin-cost.tsx`、`admin-failures.tsx`：**没有差异**（只改了 JSX 里的标题文字）。

第二遍（JSX 属性里的全部函数 / ref / `on*`，排序后比对）剩下的差异：
- `subject-traits.tsx`：少一行导航链接的 `onClick`（挪进 `AdminNav`）。全部写入按钮的 `onClick` 逐字相同。
- `config.tsx`：多 `actions=JSX`——「刷新配置快照」按钮作为 `AdminHead` 的 `actions` 传入，里面的 `disabled={query.isFetching}` 与 `onClick={() => void query.refetch()}` 与原来相同（人工核对）。
- `observability-shared.tsx`：少 `AdminLink` 的 `onClick`（随组件删除）。
- `admin-frame.tsx`：多 `onRetry=onRetry`（`inline` 分支的 `RetryLine`）。
- 其余文件：**没有差异**。

第三遍（与表单 / 写入有关的属性：`disabled`、`value`、`type`、`id`、`htmlFor`、`min` / `max` / `step`、`rows`、`maxLength`、`placeholder`、`title`、`aria-*` 等，排序后比对）：
- 所有 `disabled`、`value`、`htmlFor`、`id`、`min` / `max` / `step`、`maxLength`、`placeholder`、`rows`、`tabIndex` **没有差异**。
- `subject-traits.tsx`：少 29 个 `type="button"`——原生 `button` 换成 ui-next `Button`，它默认 `type="button"`，没有一个变成 submit；多 4 个 `aria-expanded`（trait 行切换按钮）和面板的 `id` / `title`。
- `subjects.tsx`：页标题、面板 `id` / 标题，行链接的 `aria-label` / `title`。
- `config.tsx`：标题从 `h1` 文字变成 `AdminHead` 的 `title`。
- `config-sections.tsx`：三个 `aria-labelledby` / `id`（语言、调度、运行参数面板），`value=value` 是 `AdminKpi` 的数值 prop，不是表单值。
- `config-task-editor.tsx`、`config-provider-catalog.tsx`：**没有差异**。

没有新增任何 effect、查询、失效或写入。

## 交互变化（键盘、焦点、由哪个元素触发）

- **导航**：从页头里挪到页面最上方，包在 `nav aria-label="管理后台"` 里，当前页 `aria-current="page"`（详情页没有对应项，不标）。标签从英文短名换成侧栏名字。
- **配置页 Tab 顺序**：原来是 分区按钮 → 刷新 → 搜索；现在是 刷新（在页头）→ 分区按钮 → 搜索。分区按钮仍是点击才切换，没有方向键行为。
- **学科列表**：行链接的读屏名从「→」变成「打开 {名称}」。
- **学科详情**：trait 行切换按钮新增 `aria-expanded`；写入失败的错误行新增 `role="alert"`，预检结果新增 `role="status"`，CAS 横幅新增 `role="status"`；原生按钮换成 ui-next `Button`（同样是 `type="button"`，`disabled` 条件不变）；trait 列表从一串 `div` 变成 `ul` / `li`，换绑候选是 `ul`，历史是 `ol`；确认文案从「段落里夹按钮」变成「段落 + 下一行按钮」，按钮顺序不变（确认在前，取消在后）。
- **载入 / 出错**：`Stateful` 换成 `AdminArea`：载入是 `SkeletonLines`（读屏名「subjects 加载中」「trait 绑定加载中」「候选加载中」「历史加载中」「配置加载中」），原来可见的「… 加载中...」文字变成读屏名；出错是 `RetryLine`（原文案 +「重试」，`role="alert"`，仍是 `refetch()`）。换绑 / 历史面板里的载入与出错不再套卡片（`inline`）。
- **配置页按钮尺寸**：原 `config.css` 把按钮改成 44px 高的 M3 胶囊；现在和其余七个管理页一样是 ui-next 默认尺寸（32px；任务表里的「编辑」是 28px），触屏点击区由 `un-hit` 补到 44px。
- **provider 目录**：`details` 的默认三角换成 chevron 图标（`aria-hidden`），仍是原生展开。

## 文案调整

- 页标题统一成侧栏 / 命令面板里的名字（`src/kernel/ui-surfaces.ts`）：「Subjects」→「学科配置」，以及批次 A 留下的「Cost」→「成本」、「Failures」→「失败记录」、「Coverage Lattice」→「供题覆盖」、「Conjecture Scores」→「猜想评分」。运行页标题本来就是中文「AI 任务运行记录」（批次 A 之前就是），没改。学科详情的标题仍是科目名，配置仍是「配置」。
- 新增的标签：面板标题「全部科目」「科目操作」「trait 绑定」，配置页小字「ADMIN · config」，详情页返回链接「← 学科配置」，读屏名见上。
- 其余按钮、确认、说明、错误、空态文案一字未改（包括英文按钮 rename / retire / restore / reset / fork）。

## 审查与验收

- 本机检查：`pnpm typecheck`、`pnpm lint`、`pnpm build` 和完整本地闸门（对比 merge-base）。结果见提交汇报。
- 独立审查重点：上表 13 个写入的 payload、确认、忙时禁用、失效与 CAS 分流；trait 编辑草稿在切换面板时的去留（应与原来相同）；配置页分区切换仍是按钮；没有任何 `type="submit"` 或自动聚焦；没有密钥被渲染或回填。
- 真实页面检查（由协调线负责，独立开发库 `pnpm dev:local`）：三页的载入 / 空 / 出错 / 有数据；亮色 / 暗色；960 / 760 / 640px；任务表与能力表的横向滚动；键盘焦点；触屏下写入按钮行换行后的点击区。可以安全演练的写入与不能演练的写入见提交汇报。
