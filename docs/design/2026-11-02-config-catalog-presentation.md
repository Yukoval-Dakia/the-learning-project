# 配置页：认证与模型目录事实（YUK-1563 / YUK-1473）

服务已授权全 UI M3E 接续与配置面板余项。唯一 UI writer，Astra/high/default 不变。起点 `afe63558be5d825fdcc0f36cc6fd34ac5f18d5b1`，实际产品树 `tlp-ui-practice-studio-20261030` clean；保留练习列表/今日候选，不复用其审查为本片批准。

## 设计 preflight

组件类型 page，现役 `/admin/config`，不增加路由或写入 owner。
`docs/design/2026-10-04-yuk1007-settings-ui-preflight.md` §1：
> 配置面是天然密集面——**committed controlled density**：表格 + mono 值列 + meta 字号，与既有 admin 面同密度档；不做卡片化稀疏排版，不做营销式视觉。

同文 §3：
> 配置值与当前运行选择分列，operator全局固定明确显示。未设密钥的provider禁用并说明。
> 保存后刷新读面；已提交但本进程快照未更新时显示“已保存，等待刷新”。不宣称worker已确认；后台通常每15秒刷新，失败可延后。

`docs/design/2026-10-27-m3e-direction-and-migration.md` §1：
> 全面采用 **Google Material 3 Expressive（M3E）**

沿已锁方向及 design-taste-frontend 应用界面指导，密集表格承担事实比较；字体/色/按钮复用 ui-next/public 与已有 practice-foundation M3E tokens。标题与六分区导航重建，原风车花只作标题装饰；目录按 provider 展开，不把每个能力做一张营销卡。局部横滚保完整字段，控件有标签/focus，明暗由既有 tokens 负责；本轮未浏览器验收。

精确写集：`observability/ui/config.tsx`、`config-model.ts`、`config-sections.tsx`、`config-task-editor.tsx`；新增同目录 `config-provider-catalog.tsx` 和 `src/ui-next/config/config.css`；本文。没有改路由、client、API/schema/generated、后端、凭据、实际配置、测试或原任务模型。

## 已合后端与真实 consumer

本轮远端 `git ls-remote origin refs/heads/main` = `02778f6d11bcd82f372c9b1b5452d80cc18bd537`。已核 2149 squash `6c8f32bd1` 及当前 main/本地 `admin-config-contracts.ts`、原配置读面一致；不是重新调用 API/QA。原票最新交接仍为2149 API 已交/QA过，UI auth/能力待接。

现役 Start `server/start/routes/admin.config.tsx` → `loadAdminConfigSurface` → `AdminConfigSurface(client=startAdminControlClient)`；SPA 同一公开入口。`CONFIG_QUERY_KEY`、15秒 refetch、`getConfig/patchConfig/resetConfig`、成组payload、保存确认、committed_epoch 与 snapshot.epoch 分列均保原 owner。页面的“刷新配置快照”只是原读取，不是刷新远端模型目录或探针。

| 显示事实 | 已有 wire / producer | 本片消费 |
| --- | --- | --- |
| 认证三态 | `providers[].auth.status` optional：unconfigured/configured/auth_failed；同对象 `http_status/error_type` nullable | 优先 auth，缺字段明确认证未知；不拿 key_present 推断认证成功。失败时显示已有 HTTP/类型，不发请求 |
| 凭据存在与通道 | key_present/auth_mode/pi_provider/implemented_for | 独立列明服务端凭据、原生身份与 chat/typed 接线；不展示 key 值，不扩大编辑权限 |
| 全量目录 | `providers[].models[]` optional；`server/config/admin-config-facts.ts:214` 的 catalogModelRows 合并 catalog IDs 与 executable IDs | 保留所有行，runnable=false 标不可运行，缺 models 为未知而非零；空数组才是未列模型 |
| 能力 | tool_call/reasoning/structured_output/vision/forced_tool_choice：boolean 或 unknown | 支持/不支持/未知三态，缺旧字段也未知；不按名称推断 |
| 协议与输入 | api nullable、input[]（目录未声明为 unknown） | 协议未知、输入未知原样区分，不借 SDK 默认推断 |
| 限额 | context_window_tokens/max_input_tokens/max_output_tokens nullable | 真实数字与 token 单位，null/缺值为未知，不补硬编码上限 |
| 费率 | cost nullable；input/output/cache_read、optional cache_write | USD/百万token，零保零；null/缺字段未知，不表示免费 |
| 配置快照 | snapshot.epoch/hydrated_at | 仍仅说明当前 API 进程配置快照，不冒目录版本/拉取时间，也不冒worker确认 |

## 当前 wire 精确缺项（交原1563 owner，未补后端）

`AdminConfigResponseSchema` 只有 snapshot、facts_injected、keys、tasks、providers、schedules、runtime；provider/model schema 未包含以下元数据：

1. 模型目录拉取时间、目录版本、当前来源（在线/数据库缓存/随包快照）、最近拉取失败/降级状态。
2. provider API base URL 与模型可选思考强度档位。
3. 每模型由 `/models` 访问检查形成的已授权/不可访问/未核实状态，以及认证事实的观测时间（`runnable` 仅保存期 registry 可执行事实，不能替代这项）。

当前页面明确“目录更新与来源未提供”，不根据配置 hydrated_at 猜在线新鲜度，也不根据 auth configured 宣称所有模型可调用。`custom-providers` 删除响应虽带可选 catalog_version，但不是目录读状态，不能为取版本执行删除或拼成新读 owner。本片无新增后台路径。上述缺项须原 config facts/目录 owner 在现有读面给同源事实后接入；写到原1563而不建重复票。

## 已选模型与保存边界

- 编辑状态继续用原 useState 从任务 override/default 初始化；数据刷新不重设 provider/model，不新增 effect。当前模型从目录消失仍保留带原 ID 的 option，原任务值/全局固定仍列明。
- 仅用户更改 provider 时清空模型草稿，明确要求选择；不再默认取目录第一项。该动作不保存，取消无写入。
- auth_failed/unconfigured、未接线/无凭据沿已有可用性 guard 禁用模型保存；已有 runnable=false 明确禁选但目录可查，不编排备用 provider。
- 原确认入口继续成组提交 provider/model。确认期间若目录/认证事实更新为不可用，提交前以当前展示事实阻止该模型保存并显示原因；不会改成另一个模型。最终授权/组合合法性仍由原 backend writer 验证。
- budget/language/reset、全局pin优先、typed只读、facts未注入禁编辑、已提交与刷新失败分列均保留。不新增 credentials/custom-provider CRUD UI，不执行一次真实配置写入或探针。

## 验收范围

六分区（总览/功能开关/AI模型/阈值/语言/调度运行）、搜索/深链、加载/失败/旧快照、无匹配、typed/全局固定、确认/取消/保存错误均保持现役功能。新目录详情可展开，模型可全量查看；未将只支持/unknown混为布尔。没有新增 useEffect、依赖、测试、writer、review。

静态验证日志：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1563/config-ui-20261102/`。scoped Biome 初次对横滚表格容器 tabindex 报错；改语义 section 并仅对此键盘滚动入口保有明确理由的规则注释。不是忽略全局 lint，也未改任何门。

测试0改0跑；DB、真实/models、auth/provider/paid、浏览器、运行及部署 NOT_RUN。原2149 API QA证据不改写；本片静态门不能替代配置页真实认证失败/目录更新/键盘/明暗/窄屏/保存验收。未新派review、未push/CI/merge，不报GO；1563尚有目录元数据wire及实际运行验收缺口，不能关闭。

最终 `pnpm typecheck`、`pnpm lint`、`pnpm build` 均 exit 0；scoped Biome/diff-check 0，lint 保留165 warnings。串行使用既有 local-heavy gate，共享≤2。首轮三门也为0；自检发现默认 locale 小数格式可能将很小非零费率舍入成0，改为保留数值字符串后再次三门0，两轮日志分别保留。产品源码验证后仅补本文结果，无测试/运行/新review。认证与模型目录缺项已记回原1563；1473记录本完整六分区展示片，后续真实验收仍待原权限。
