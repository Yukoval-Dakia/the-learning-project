# 首次使用 · 定位（/placement）：M3E 呈现

YUK-1473 · 2026-11-03 · 交付阶段：第一天能用（删旧界面第 5 页，首次使用四页之三）

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:95`（§5「其余真实页面」）：「其后 notes/knowledge/coach/profile/admin 等按原功能票、真实修改面逐页圈定」；`:98`「以后每片消费 M3E 后退出自己的旧样式」；`:100`「作用域、无全局污染、同源资源、无业务规则等承重限制保留」。
   - `docs/design/2026-06-20-cold-start-day-one-design.md` §2（第一天新用户旅程）：设定目标后进入定位练习，答完生成画像。
   - 协调裁定（2026-11-03 03:29）：「只换呈现，保存、判分、会话逻辑以及 src/ui/components/response/* 一律不动 … 如果换外壳时发现必须动保存相关的 hook 或者调用顺序才能接上，就停在那里 … 不新增 useEffect。」
2. 组件类型：page（`/placement`），无新路由、弹窗或抽屉。
3. 文件：新建本文件；修改 `src/capabilities/onboarding/ui/ScreenPlacement.tsx`（呈现）、`onboarding-m3e.css`（新增定位样式）、`onboarding.css`（删除定位分节）。

## 做了什么

- **外壳与状态**：`LoomCard` / `Btn` / `LoomIcon` / `EmptyState` / `ErrorState` / `SkLines` / `ObSteps` 与全局 `page` / `eyebrow` / `serif` / `badge` / `fade-key` 等类，换成 ui-next 的 `Button`、`Chip`、`RetryLine`、`SkeletonLines`、`OnboardingSteps` 和 lucide 图标。没有题时的各种状态（没目标、在准备、准备失败、不确定、已结束、未计入），用本地的两个呈现组件 `PlacementState` / `PlacementError` 统一成 M3E：图标、标题、一句话、出路按钮。
- **作答卡片**：外层从 `LoomCard` 换成带面板底色的 `div`，`attachCard`（离开页面补存、退出前保存）仍挂在这个根节点上。题面 `MathMarkdown`、`AssetEvidencePreview`、`SaveStateChip`、`ResponseSlotField`、`EvidenceComposer` 原样渲染，props 一个没变。
- **进度条**：八格进度改用 `data-state`；原来的嵌套三元改成小函数 `segState`（审查清单禁止嵌套三元）。
- **删除旧样式**：`onboarding.css` 的整个定位分节删除（46 条规则，含早已无人使用的 `ob-opt*` / `ob-pl-answer` 等原型遗留），以及只被它使用的 `@keyframes ob-spin` 和孤儿注释。删除前用严格类名边界在全部 `.ts` / `.tsx` 中确认 0 处使用。`fade-key` 笔记页还在用，`globals.css` 不动。

## 逻辑未变的证明

把新旧文件都去掉 import、注释和 JSX 返回块后逐行比对，差异只有三处，全是新增的呈现辅助：`PlacementState` / `PlacementError` 两个小组件、`upload` / `recheck` 两个按钮工厂里 `Btn` 换成 `Button`、`segState`。会话开启与恢复（`attachScreen`、`initialRequest`）、`finish` / `transition` / `applySelection` / `loadNext` / `releaseHeld` / `recheck` / `leaveProbe`、草稿 `persist`（含链式保存与 8 秒等待上限）、`useResponseDraftAutosave`、`usePagehideTransition`、`useJudgeRunPolling`、`commit` / `release` / `recover`：逐字不变。没有新增 effect。

## 文案调整

- 去掉英文眉标「PLACEMENT · θ̂ · FSRS live」。
- 「答到 cap 或收敛即止」改为「答满或已经足够判断时就停」。

## 审查与验收（协调裁定）

- 首审给非 Claude 模型，重点查数据丢失：自动保存时机与防抖、pagehide 补存、判分轮询中断后能否恢复、暂留题放行有没有重复提交或覆盖草稿；逐个保存路径对照 main 上的旧组件，确认调用点、参数和顺序没变。
- 真实页面检查（8788 dev，独立开发库）：答一题 → 刷新 → 草稿还在 → 提交 → 判分出结果；答到一半关标签页 → 重新打开 → 草稿还在；判分轮询期间刷新 → 结果正常回来。截图放进 PR 说明。
