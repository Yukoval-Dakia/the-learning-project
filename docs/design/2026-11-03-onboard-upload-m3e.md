# 首次使用 · 备料（/onboarding/upload）：M3E 重写

YUK-1473 · 2026-11-03 · 交付阶段：第一天能用（删旧界面第 4 页，首次使用四页之二）

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:95`（§5「其余真实页面」）：「其后 notes/knowledge/coach/profile/admin 等按原功能票、真实修改面逐页圈定」；`:98`「以后每片消费 M3E 后退出自己的旧样式」；`:100`「作用域、无全局污染、同源资源、无业务规则等承重限制保留。… 具体实施需列出发生冲突的规则及依据，不静默扩大路径权限。」
   - 同文件 `:108`：「**Ingestion**：保留原上传、识别、agent、手工录入、classic 显式复核 … 识别和 paid 操作保持显式触发。」
   - 页面内既有合同（`OnboardRecord.tsx` 头注释）：本屏只上传并抽题，不做逐题复核；完成态只如实说「N 题已抽出」，不说「已启用」；`goal` / `leanings` / `pace` 原样带到定位页。
2. 组件类型：page（`/onboarding/upload`），无新路由、弹窗或抽屉。
3. 文件：
   - 新建：`src/capabilities/onboarding/ui/upload-choices.tsx`、`usage-receipt.tsx`；本文件。
   - 改名：`welcome.css` → `onboarding-m3e.css`（首次使用各页共用）。
   - 修改：`OnboardRecord.tsx`（呈现）、`WelcomePage.tsx`（样式文件名、面板改显式类）、`onboarding.css`、`web/src/globals.css`（删除死规则）、`scripts/audit-learner-copy.ts`（文件路径）。
   - 删除：`src/ui/components/UploadSubjectPicker.tsx`、`UploadUsagePicker.tsx`、`UsageReceiptLine.tsx`。

## 做了什么

- **呈现重写**：旧的 `LoomCard` / `LoomIcon` / `Btn` 与全局 `page` / `page-head` / `eyebrow` / `dropzone` 等类，换成 ui-next 的 `Button`、`ChipToggle`、`OnboardingSteps` 和 lucide 图标。上传区、文件列表、抽题进度、底部的「下一步」条都用 M3 角色。进度列表加了 `aria-live="polite"`，读屏用户能听到进度变化；出错提示带 `role="alert"`。
- **三个共享组件随唯一使用方搬家**：学科选择、资料用途、隐私回执原来在 `src/ui/components`，只有本页在用。逻辑逐字搬到 onboarding（已用脚本核对：过滤、选择 hook、请求字段映射、选项文案、回执文案与查询一致），只换呈现：学科用 `ChipToggle`，资料用途保留原生单选框、做成 M3E 选项卡片。
- **删除旧样式**：`onboarding.css` 删除只属于本页的 26 条规则（包括本页和设定页共用、现在已无人使用的 `ob-inline-err`）；`globals.css` 删除只属于上传区与这三个组件的 21 条规则。删除前用严格类名边界在全部 `.ts` / `.tsx` / `.html` 里确认 0 处使用。定位页仍在用的 `ob-spin` 动画保留。
- **面板显式化**：首次使用页面里「哪一块要面板底色」改用显式 `un-ob-panel` 类，不再靠 `:not(:last-child)` 推断；设定页同步。

## 不变

文件选择规则（PDF / DOCX 只能单选、图片最多 5 张）、上传 → 展开 → 建会话 → 抽题的调用顺序与参数、防重入锁、离开页面后不再写状态、SSE 终态判定、进度行的计算与文案、出错重试、`goal` / `leanings` / `pace` 透传到定位页：全部不变。没有新增 effect。

## 文案调整

学习者界面上不再出现接口细节：去掉「抽题进度走 SSE」「SSE · GET /api/ingestion/[id]/events · 抽题进度逐条推送」「event=ingestion.done」和英文眉标「RECORD · onboarding」。进行中改为「进度会自动更新，不用刷新页面。」，完成后显示隐私回执。其余句子只把破折号和间隔号改成中文标点，意思不变。

## 与 `src/ui-next/AGENTS.md` 的冲突

该文件 I4 写着「never edit `src/ui/`」「never edit `web/src/globals.css`」。本片删除了 `src/ui/components` 下三个文件和 `globals.css` 里 21 条规则。依据：Owner 2026-10-20「旧界面全部删除」和 2026-11-03 的解耦目标；根 `AGENTS.md`「S13 DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除」；以及 M3E 文档 `:98`「每片消费 M3E 后退出自己的旧样式」。删除的都是本页唯一使用、已逐个核对为 0 引用的对象；没有改动 `src/ui` 或 `globals.css` 里任何仍在使用的内容。

## 验收边界

- 本地：typecheck、lint、build、CI 三组 audit。
- 未做：真实浏览器的亮暗、窄屏、键盘与读屏观察；没有真实上传文件走一遍抽题（会触发 OCR / provider 调用，不在本片授权内）。
