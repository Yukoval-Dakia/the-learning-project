# 今日页面接续与学习画像依据（YUK-1473 / YUK-1587）

组件类型 page。本轮沿唯一 UI writer / Astra high default / M3E；产品树 `tlp-ui-practice-studio-20261030`，起点 `2a4d79c9cd07245b643361869c5f50f19c8d7861`、clean。没有修改架构树、后端、transport、恢复、测试或模型。

## 设计 preflight

`docs/design/2026-10-30-teaching-and-generative-ui.md:16`：
> 其它页面依次：练习列表/今日 → 题库/详情 → 录入/用途/费用 → 知识/笔记/收件箱 → 教学其它入口/管理。每片覆盖真实页面及状态，不用统一换token当全部完成。新结构复用headless业务owner，不复制旧DOM当cleanroom。

YUK-1587 已获采纳的验收草案：
> 学习者状态类数字都能追溯到证据，并能发起挑战或纠错
> 证据不足时显示证据描述和「初步」标记，不显示精确百分比

因此选择将 1587 的今日入口合入正在做的 `/today`；1563 配置面板余项排入设置页，不重复其 2149 后端。两票原 Grok/Opus 归属文字被本轮协调授权覆盖，不换模型/新派人。

写集：TodayPage.tsx、blocks/KpiRow.tsx、blocks/ProfileBand.tsx；新增 `src/ui-next/today/TodayHeader.tsx`、`today.css`；删除仅 TodayPage 消费的旧 `blocks/LoomHero.tsx`（已核引用）；本文。业务子面继续复用，不以 CSS 改色核销其完整重写。

页面回答“今天继续什么，判断有什么依据？”：标题/常用动作 → 原教学交班（降级旗标仍在 brief 前）→ 真实工作台计数 → 画像证据 → 原学习意图 → 可行动任务 → 进行中/待裁决 → 学习笔记及过去七天。没有虚构趋势/百分比/学习成效；计数沿原聚合，任务沿 due>0 和 proposals 条件。主导航仍沿现役 StudioShell，冷启动仍完整返回原 ColdStart。

## 实现与边界

- 今日新标题、原风车花及练习/录入/伙伴入口；任务与计数改原生 button，原去向不变。M3E 有作用域 tokens，窄屏计数两列、内容单列，focus-visible；没有新增 useEffect、依赖、演示数据或路由。
- `workbench-summary`、agent notes、placement-profile 的 query key/读取者/启用条件保持。原成本、TeachingBrief、夜间交班、probe、proposal、AiChanges undo、Sessions、WeekHeat 保留原 owner 及装载/错误边界。保 today-page/today-loom scope，避免破坏这些仍在使用的子面样式；这些子面不是本轮全量 cleanroom 改写。旧 banner 无 live consumer，同片删除。
- due scope 按原已批 UI `3884337ae72956e5efba4ce0fb2c2f421ab5c1bc` 的意义兼容：有 `actionable_queue_sample` 显示“本批可复习”，缺字段保旧缓存文案；derived task 仍仅 due_count>0 显示。当前分支生成类型早于架构新字段，使用属性存在性收窄，不编辑生成 DTO/伪造新接口。与架构最终集成若碰同 hunk，须保这两层语义。
- ProfileBand 仍取原服务端 weakest 的前 3 项，不重新排序/推导最弱，不将本地 preview 求和冒充 total/evidencedCount。原概率 band 改为证据摘要；所有当前预览标“初步”，不根据计数猜校准或已掌握，不把零证据当不会。`evidence_count` 仅“证据记录数”，绝不“独立做对题数”；缺字段显示未提供，不补 0。低置信明确说明不代表不会。
- 原生 details 可展开说明依据来源与当前缺项；知识点按钮使用已有 `/knowledge/:id`（原 KnowledgeDetailPage 有活动记录链）。不是按 ID 精确定位某条 judgment 的证据回放，不冒称每条原始证据已完整关联。
- 异议调用原 `openCopilot(prefill, {send:false})`：上下文来自被点击 KC/goal/证据记录数，纯输入框草稿，学习者补充并发送；没有自动发送、业务 mutation 或自动调分。仅交“发起讨论”入口，不声称原异议已被系统采纳、执行纠错或形成回执。
- 画像 refetch 失败且有 cache 时保留旧记录并明示更新失败；首次失败仍 error/retry，不当零证据。空知识树与无可展示证据各保录入/练习入口。

## 1584/1585 已完成与读面余项的区别

本轮实读原票：1584/1585 均 Done，不再以旧依赖阻塞 UI。固定 origin/main 已含 `f56ed9f58` / `76bba37f8` 的判断合同。
但本地与固定 main 的 `onboarding/ui/profile-api.ts` 均只给 ProfileKc 的 evidence_count、概率/区间、low_confidence、success/fail 等字段，未给 ability_claim/evidence_age、judgment version/as_of 或原始证据引用。不能仅因核心完成就在前端假造这些字段。

本片安全展示现有事实；下一个精确接缝由原 placement profile reader owner 通过现有端点暴露同源公开判断及证据引用（或确认由已有知识点读面承接）。UI 不重复核心推断，不自建阈值、不以查询每个 KC 的方式拼一个新判断，不改后端。本事实记录到原1587，不再开重复票或把已完成1584/1585重开。

1587 未完范围：`ScreenProfile` 完整画像、知识页/题目页等其余状态数字，同一判断版本/时间/证据的逐项追溯，后续真正纠错的原 owner 操作和回执；当前 challenge 草稿不等于闭环。1563 仍待配置面板消费 auth.auth_failed/http/error_type 和能力字段；本轮未写 provider/config 面。

## 验证

只执行本机 typecheck/lint/build 与 scoped Biome/diff-check，日志 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1473/today-evidence-20261101/`。首次 scoped Biome 提示 div aria-label 无角色，已改有命名的 section。测试 0 改/0 跑；DB/provider/paid/browser/runtime/部署 NOT_RUN。没有新review、没有转借06d或2215审查，没有 push/CI/merge，不报GO。明暗/窄屏/键盘/真实展开/草稿手交与原异议执行均未实测，不以静态源码宣布1587 Done。

下一 UI 工作仍续今日各业务子面的完整视觉与状态收口，再按原队列进入题库/详情；1587跨页随真实页面逐片推进，1563到配置页消费现成合同。

最终 typecheck/lint/build 均 exit 0，scoped Biome/diff-check 0。lint 保留 165 warnings。首轮三门也为 0；后续恢复原子面的 today-loom scope 并删除无 consumer 的旧 LoomHero 后，再次三门全 0，保留 checks.json 与 checks-final.json 两轮日志。产品源码验证之后仅补本段结果。测试与运行权限未扩大。
