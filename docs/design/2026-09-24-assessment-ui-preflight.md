# YUK-1038 — 作答面 UI preflight（source-check only）

日期：2026-09-24 · 关联 YUK-1038 · **状态：设计方向已 settle；本文件待 owner 正式批准；不含任何 UI 代码**

相关：[implementation grounding](../planning/2026-09-24-question-assessment-implementation-grounding.md) · [decisions](../planning/2026-09-24-question-assessment-decisions.md)。

## 0. 状态与边界

- 本文件是 **source-check only**：给出设计原文引用、组件类型、交互与文件清单；**不构成质量、运行时或可达性证明**。
- **决策 ID 纠正**：designer 报告曾误标决策 ID；本文件统一为 **D9 manual / D10 media / D11 autosave**。
- 全部策略 **D1–D16 已批准**（不再是旧 pending 项）。**UI preflight 本身仍待 owner 正式批准**；actual eval plan/budget 与 final implementation-ready confirmation 仍待。
- **不创建 ADR / ticket**，待 parent reconcile。
- 本文件**不写任何 UI 代码**；无 route/drawer/embedded quiz 新增。
- 后端媒体依赖仅**枚举**（非 UI writer scope）。

## 1. 逐字设计原文（verbatim；由 read 取得，含路径与行号）

`docs/design/loom-refresh/project/pface-solo.jsx:1–3`：

```
// Loom · 练习面 — 散题作答态.
// 即时反馈（§6.4 着色即判定）· 评级建议可改 · 不服判（异步重判，不阻塞流）·
// 解题会话（苏格拉底分级提示，永不直接给答案，可提交手写图）.
```

`docs/design/loom-refresh/project/pface-paper.jsx:1–3`：

```
// Loom · 练习面 — 卷模式 + 交卷结果 + 复盘.
// §6.4 缓冲反馈的视觉语言：作答全程零语义色（导航 pip 只有「已答」的中性墨点），
// 颜色在交卷瞬间才进场——色彩 = 判定。复盘与结果页共用一套 pfr 骨架。
```

`docs/design/loom-refresh/project/pface-paper.jsx:39`：

```
<span>反馈缓冲：这张卷不给即时对错——交卷后统一判分。和散题的节奏是反着的，刻意的。</span>
```

`docs/design/loom-refresh/project/pface.css:7`：

```
§6.4 即时反馈着色判定；卷模式全程无语义色 — color IS judgment. */
```

`docs/design/loom-refresh/project/pface.css:121`：

```
/* graded states — 即时反馈着色 (§6.4) */
```

`docs/design/loom-refresh/project/pface.css:184`：

```
/* navigator pips — strictly neutral (§6.4) */
```

`docs/design/loom-refresh/project/screen-onboarding.jsx:496–498`（多选可访问控件先例）：

```
<div className="ob-opts" role="group" aria-label="多选">
  {q.options.map((o) => (
    <button key={o.k} className={"ob-opt ob-opt-multi" + (sel.includes(o.k) ? " is-sel" : "")} onClick={() => tog(o.k)} aria-pressed={sel.includes(o.k)}>
```

`docs/design/loom-refresh/project/screen-onboarding.jsx:524`（文本 + 拍照先例）：

```
placeholder={q.kind === "translation" ? "写下你的译文——也可以拍手写稿上传。" : "写下你的作答——也可以拍照上传。"}
```

`docs/design/loom-refresh/project/screen-onboarding.jsx:528–530`：

```
{isImg
  ? <span className="ob-pl-attach"><img src="uploads/draw-7cafddab-274d-4a3a-b03e-a722036e1a59.png" alt="手写稿" /><Icon name="check" size={13} />手写稿已附</span>
  : <Btn variant="ghost" size="sm" icon="camera" onClick={() => onChange("__img")}>拍照上传手写</Btn>}
```

`docs/design/2026-06-08-question-bank-ui/README.md:21–28` 红线（实测记录）：

```
## 红线（实测记录）

- **fade-in 易碎 keyframe**：chat4 实录，modal 入场动画曾把 `opacity:0` 卡死在 frame 0。终稿改为
  「只 animate transform，绝不用 opacity 0→1 门控可见性」。实现照此，不要复活 opacity-gated 入场。
- **写操作（编辑/删除）属 YUK-281**：S1 只读侧只按外形 render 编辑/删除控件并 disabled，不接 PATCH/DELETE。
```

## 2. 组件类型与范围（settled）

- **类型**：共享作答组件为**现有 route 内的 other**；修改现有 **drawer** `PfCoach/HintLadder` 的提示与揭示数据接线（不新增抽屉）；唯一新增 **modal** = `EvidenceLightbox`（focus-trap / Escape / restore focus）。
- **无新 route、无 drawer、无 embedded quiz**。
- **只用现有 tokens/primitives**；新增独立样式 `src/ui/components/response/response.css`（建议类名前缀 `.rs`，复用现有语义 token，不覆盖既有类名）。
- **paper 在 feedback release 之前不着对错色**；**不做 opacity gating**（遵 question-bank 红线）。

## 3. 交互规格

| 能力 | 规格 |
|---|---|
| 单选/多选 | **native choice IDs**、显式 single/multi；空集合 vs missing 区分；选项数不硬编码 4 |
| 配对/排序 | 配对 = 选择 + 键盘；排序 = 可键盘上下移动/序号编辑；**不要求拖拽编辑器** |
| 共享材料 | markdown inline + structured figures 同版渲染；判分与学生所见同版资产 |
| 整页证据附件 | 默认绑定当前 evaluation group，**关联子集可编辑**；不由模型切图归属串用 |
| 计分单元 | **point unit 只计一次**；levels 维度**不伪造数值分母** |
| 判错反馈 | **失败不自动判错**（no auto-wrong on failure） |
| 状态 | **六状态**：草稿未提交 / 已提交待评 / 联合组暂定 / 材料不可读待复核 / 生效 / 被替代 |

## 4. 自动保存（D11）

- **FULL autosave**，不止 3 个面：每一个正式作答面，含 **ProbeAnswers**。当前 `PfSolo.tsx:873–925` 的 `PfCoach` 渲染 `HintLadder`，其 `returnToAnswer`（`HintLadder.tsx:106–109`）返回原作答面，因此这条 tutor UI 的答卷由 PfSolo 草稿覆盖；服务端 solve 提交客户端同样使用统一草稿/提交契约。
- **D16 提示证据必须持久化**：`HintLadder.tsx:57–69` 当前关闭即清本地状态，`:99–104` 看完整解仅改本地state。新契约须把答案帮助/揭示绑定到 issuance 并在服务端留痕，关闭、刷新不能恢复成“独立完成”。完整解在显式揭示授权后按需取得，不随初始公开题面DTO下载；保留现有“非独立完成”确认交互。
- **draft generation / version conflict 可见**；**saved 仅在 server ack 之后**；**keepalive 不是保存证明**；finalization **等待必需的 pending uploads**。
- 反馈缓冲：**paper 持有 group dependencies**；**solo 202 可继续**；**placement 等待自适应结果**。
- 现有 manual / notes / self-confidence / hints 保留，并叠加 D15/D16 的新学习效应。

## 5. 状态与读模型

- outcome **pending 读模型**；**同一 submission 的 appeal 不是新 attempt**。
- 复核/复盘读取 effective selection 并可定位原评分及复核链。

## 6. 新增源文件（17；glob 已验证：均不存在 → NEW）

```
src/ui/components/response/response-types.ts
src/ui/components/response/ResponseSlotField.tsx
src/ui/components/response/ChoiceSetResponse.tsx
src/ui/components/response/TextResponse.tsx
src/ui/components/response/MatchingResponse.tsx
src/ui/components/response/OrderingResponse.tsx
src/ui/components/response/EvidenceComposer.tsx
src/ui/components/response/AttachmentStrip.tsx
src/ui/components/response/AssetEvidencePreview.tsx
src/ui/components/response/StimulusFigure.tsx
src/ui/components/response/SlotResultBadge.tsx
src/ui/components/response/EvaluationGroupPanel.tsx
src/ui/components/response/EvidenceLightbox.tsx
src/ui/components/response/SaveStateChip.tsx
src/ui/components/response/response.css
src/ui/hooks/useJudgeRunPolling.ts
src/ui/hooks/useResponseDraftAutosave.ts
```

## 7. 新增测试（10；glob 已验证：均不存在 → NEW）

```
src/ui/components/response/response-types.unit.test.ts
src/ui/components/response/ChoiceSetResponse.unit.test.tsx
src/ui/components/response/ChoiceSetResponse.a11y.unit.test.tsx
src/ui/components/response/MatchingResponse.a11y.unit.test.tsx
src/ui/components/response/OrderingResponse.a11y.unit.test.tsx
src/ui/components/response/EvidenceComposer.unit.test.tsx
src/ui/components/response/AssetEvidencePreview.unit.test.tsx
src/ui/components/response/SaveStateChip.unit.test.tsx
src/ui/hooks/useJudgeRunPolling.unit.test.ts
src/ui/hooks/useResponseDraftAutosave.unit.test.ts
```

**额外建议测试（proposed 精确路径，可接受）**：

```
src/capabilities/onboarding/ui/ScreenPlacement.autosave.unit.test.tsx
src/capabilities/shell/ui/ProbeAnswers.autosave.unit.test.tsx
```

## 8. 修改源文件（11；glob 已验证：均存在）

```
src/capabilities/practice/ui/PfSolo.tsx
src/capabilities/practice/ui/PfPaper.tsx
src/capabilities/practice/ui/PfRetro.tsx
src/capabilities/practice/ui/practice-api.ts
src/capabilities/practice/ui/DraftReviewPage.tsx
src/capabilities/practice/ui/QuestionDetailPage.tsx
src/capabilities/onboarding/ui/ScreenPlacement.tsx
src/capabilities/shell/ui/ProbeAnswers.tsx
src/ui/components/VisionTab.tsx
src/capabilities/ingestion/ui/RecordPage.tsx
web/src/routes/MistakesPage.tsx
```

**额外必需修改路径（glob 已验证存在）**：

- `src/ui/lib/assets.ts` —— 当前 `uploadAsset` 是**通用 File → POST /api/assets**，但**读路径** `fetchAssetObjectUrl`/`useAssetUrl` 是 **apiFetch + blob + objectURL、无 Range**，且注释以 Vision MVP 为框；扩展到 audio/video 播放与 PDF 下载需要修改该读 hook。**故列入修改清单，不得省略。**
- `src/capabilities/practice/ui/HintLadder.tsx` —— 保留既有视觉结构，接入 issuance 级提示/揭示持久化与按需完整解读取（源码经 codegraph 实读）。

## 9. 现有测试修改（glob 已验证：均存在）

```
src/capabilities/practice/ui/PfSolo.interaction.unit.test.tsx
src/capabilities/practice/ui/PfSolo.a11y.unit.test.ts
src/capabilities/practice/ui/PfSolo.capture.unit.test.ts
src/capabilities/practice/ui/PfSolo.detection.unit.test.ts
src/capabilities/practice/ui/PfPaper.autosave.unit.test.tsx
src/capabilities/practice/ui/PfPaper.capture.unit.test.tsx
src/capabilities/practice/ui/PfPaper.lifecycle.unit.test.tsx
src/capabilities/practice/ui/PfPaper.timing.unit.test.tsx
src/capabilities/practice/ui/PfRetro.actions.unit.test.tsx
src/capabilities/practice/ui/PfRetro.states.unit.test.tsx
src/capabilities/practice/ui/HintLadder.interaction.unit.test.tsx
src/ui/components/VisionTab.a11y.unit.test.tsx
tests/usability/shipped-container.spec.ts
```

## 10. 媒体与后端依赖（枚举；非 UI writer scope）

- `src/capabilities/ingestion/api/assets.ts` —— whitelist / size / magic-bytes（POST `/api/assets`）。
- `src/capabilities/ingestion/server/persist-image-asset.ts` —— 现有 `persistImageAsset` 保留图片；**新通用 persistence owner**（不复用为图片专属语义）。
- `src/capabilities/ingestion/api/asset-content.ts` —— auth/token + ETag；当前 **objectURL、无 Range**；**若需要则加 bounded range/stream**。
- `src/core/limits.ts` —— 共享限制。
- `source_asset` 泛化；**不新建 media store**。
- **不猜测 signed URL**：现行为 apiFetch + blob + objectURL + auth。

### 白名单与限制（proposed，工程上限待演练/运维边界核验；无 rollout phase）

- image：png/jpeg/webp **8MB（现有）**。
- audio：MP3/WAV/OGG/M4A/WebM **25MB（proposed）**。
- video：MP4/WebM **50MB（proposed；不是未来 100 计划 phase）**。
- PDF：**20MB**。
- UTF-8 plaintext/markdown/csv：**1MB**。
- **不要用 text magic-bytes 判定**；改以 **UTF-8/NUL/内容** 检测。**container audio/video 检查实际 tracks**，不只看扩展名。
- **拒绝 HTML / SVG / script / executable**。
- **PDF 初始 DOWNLOAD-ONLY**，**不做 iframe PDF viewer**（owner 已批准上传/下载；取最小安全）。
- audio/video 用控件、image inline、text escaped。
- 需要 **nosniff / disposition / auth / 资产生命周期归属**。
- **不做录音/编辑器/代码执行**；**不承诺 PDF 缩略图**。

## 11. 请求 owner 批准

- 请 owner 批准**一组**：**文件、类型、交互**（§2–§9）。
- 本文件为 **source-check only**，**无质量/运行时声明**。
- **UI preflight 本身仍待 owner 正式批准**；**actual eval plan / budget** 与 **final implementation-ready confirmation** 仍待。
- **不创建 ADR/ticket**，待 parent reconcile。
