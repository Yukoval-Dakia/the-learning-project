# DOCX 图文完整性：逐题确认与草稿保留

第一天能用 / YUK-1404，同一 Draft PR #1703。原卷提取证据仍只绑定 d481 / Mac 01:57Z；
文档 head 5b740ef8 的 [CI Gate 38194688279](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/38194688279) 已通过。
本轮按 owner 后续授权实现确定性的后端切片，不扩 UI、不改发题准入，不调用 provider。

## 本轮实现与边界

- 原 DOCX、转换副本、完整 Markdown 摘要及有序页面/媒体 ID 与 SHA 存入现有 source_document.provenance.docx_integrity。
  逐块保存 image_association、prompt_missing、missing_media；空题干旁取消归属的候选媒体仍保留证据，不用锚点证明归属。
- GET blocks 返回证据与 block version；现有 import / operations 接收可选 docx_confirmations。
  每项只解决一个 issue，绑定原件 digest、当前草稿版本、最终题面/题型/来源块/图引用/页框的 canonical hash、
  实际登记的页面与候选/最终媒体 SHA。确认页框必须写入最终 page_spans；每个候选媒体均须被显式核对。
  这是有来源的人工声明，不是后端自动识图，也不能通过任意备注字符串或 reviewed 状态清除问题。
- 在既有 session/题块锁与手动导入事务内校验，确认记录与正式题写入原子提交。
  修改 final_prompt_md 或沿现有 updatePrompt 编辑仍然可用；只改文字不能清除源问题，旧版本确认失效。
  合并沿 merged_from_block_ids 保留疑点，缺来源媒体必须恢复/重提取；不以清空图引用绕过。
- 普通文字题可从 DOCX text partial 状态直接导入；只有被选中的图文题需逐项确认。
  DOCX text 未选草稿全部保留，session 保持 partial/reviewed，直到最后一批完成才 imported；不再静默 ignored。
  其他入口仍保留原状态与忽略规则。新手工图卡须带 source_block_ids，不能用无来源的卡片取代未决题。
- 纯图片题须补齐非占位题面并分别确认题面/图归属；题号和整图引用本身不能生成占位正式题。
  本轮不生成公开 FigureRef、不新增裁图/OCR、不硬编码学校题号/坐标；缺乏原始元数据的历史图文草稿需重新提取。

人工坐标只作为当前来源页的复核证据，不能当生产通用解析算法。PDF drawing 位置自动提取、
已收到 Mac 四组脱敏证据（见下）；Q32 归属、纯图片题内容补齐及实际录入资产绑定仍待完成。

## Mac 四图脱敏证据（后续收到）

[逐图结构记录](evidence/2026-10-12-yuk1404-docx-mac-image-mapping.json)来自父任务转交，未读取原卷或像素。
同一 designed_node.pdf / LibreOffice 7.4.7.2：image2 视觉明确属于 Q13，XML 锚在 Q12；
image4 为 Q31 下方题干/设问（题号在图外）；image3 候选 Q32 但仍 unresolved，29×30 的 image1 位置/用途未决。
image3/4 的 XML 与视觉顺序相反，Q32 标签又在两图之后；不能以排序自动归题。
坐标只保留在验收记录，不写生产代码。PDFKit 题号框是字体选择框，并非精确字形边界。
原件/媒体 SHA 与实际录入的页面 PNG SHA 尚待补充；PDF SHA 本身不能通过页面资产校验。
以上不是完整题面确认、正式入库或判分证据。

## 本地最小验证

只扩展并运行既有一条真实 Postgres 导入事务 case；没有新增案例/矩阵。
同 case 覆盖 partial 普通文字编辑入库、reviewed 不能绕过、空题面拒绝、现有编辑不能清除疑点、
错误页面 SHA 拒绝、只确认图片仍缺题面时拒绝、旧草稿版本拒绝、逐项确认后成功，失败前后无忽略/部分写入。
最终 6 个合成草稿中正式题 3、剩余 draft 3、ignored 0；来源 Markdown 与四媒体映射保全。
正式题均 withheld / unverified_rules / container_only，admitted 为 0。
Typecheck、lint、build 通过；lint 仅现有仓库 warnings。无需付费即可复现。

[结构化证据](evidence/2026-10-12-yuk1404-docx-integrity.json)与[日志](evidence/2026-10-12-yuk1404-docx-integrity.tar.gz)
绑定产品文件摘要。合成声明只验证事务契约，绝不等于学校卷图文确认；先前独立审查也不冒称覆盖本轮 delta，未启第三审。

| 验收层 | 本轮本地合成链 | 学校原卷 |
| --- | --- | --- |
| 完整提取 | 原 case 6 块均保留 | d481：Q1–32 各一次 |
| 图片引用 | 四媒体/候选关联保留；确认检查通过 | 四媒体保全，视觉归属待验 |
| 题型/选项 | 原 case 两套 ABCD；没有重做 #1658 | d481：Q1–30 各 ABCD；正式题型/choices 待验 |
| 草稿确认 | 逐问题三条有来源确认；失败仍保留草稿 | 未验收 |
| 正式入库 | 3 题；另 3 draft，0 ignored | 未验收 |
| 可答题状态 | 0 admitted；未改准入 | 未验收 |

## d481 基线：partial 原先实际挡住什么

以下是静态源码结论，不是新的原卷入库实跑。

| 边界 | 当前行为 | 含义 |
| --- | --- | --- |
| 自动入库 | `auto-enroll.ts:206` 的 enroll 模式只接 extracted，partial 被跳过 | 初始 partial 有实际阻断作用 |
| 手动导入 | `import-completion.ts:56` 调用带锁守卫；`session/ingestion.ts:32,567` 只接 extracted/reviewed | partial 直接导入被拒绝，已有 DB 回归已覆盖 |
| 标记已复核 | `session/ingestion.ts:526` 只检查状态并置 reviewed，不校验每张图/题面 | 点击或调用 markReviewed 并不证明问题已经解决 |
| reviewed 后导入 | `import-schema.ts:40` 只要求 final_prompt_md 长度至少 1；`import-completion.ts:142` 验证图属于 session，而非属于正确题 | 错挂但合法的 asset ID 可通过；纯图片题派生的 `31. ` 也能满足非空字符串，不代表题面完整 |
| 未选草稿 | `import-completion.ts:509` 起将剩余 draft 全部置 ignored，然后 session imported | 不能宣称当前支持“只导入好题，其余自然留作草稿” |
| 发题 | `assessment-issuance.ts:450,475` 要求 admitted 且通过自动可判检查；当前导入默认 withheld | 当前未准入题不能发；capture receipt 不等于向学习者发题 |

因此 partial 不是纯提示，但它是 session 级复核前保护，不是逐题图文正确性保证。
已有 `serving-admission.ts:169` 的材料检查可拒绝显式“如图”等指代却无已核验图的情况；
它不会识别“这张完整图片其实属于隔壁题”，也不以 ingestion warnings 为准入证据。
本切片在录入/导入侧补证据约束，不改这些准入核心。

## 什么证据能支持绑定

XML 中的出现顺序和所在段落只能说明文本锚点。浮动对象可相对页面、边距、段落等基准定位；
必须知道定位基准及 offset/align，不能直接把 paragraph/run 顺序当视觉顺序。
这来自 [OpenXML anchor 定义](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.wordprocessing.anchor?view=openxml-3.0.1)
及 [positionH 的 relativeFrom 规则](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.wordprocessing.horizontalposition?view=openxml-3.0.1)。

最小可靠绑定需要同时具备：

1. **原件身份**：固定输入/转换副本 digest，drawing 所在 part、段落/run 序号、rId 与原媒体 SHA；重复引用保留为多个 occurrence，不因同一 SHA 合并位置。
2. **实际可见位置**：同次 PDF 的 digest、页面尺寸/旋转/CropBox、图像可见区域和目标题区域；统一换算到已有左上原点 0–1 BBox。XML offset 不能跳过排版就当 PDF 坐标。
3. **唯一目标与确认**：页面上可见的题号/题目区域与图关联唯一，且在同份渲染物上人工确认；只“距离最近”或同一文本锚点不足以确认。记录确认者、时间、source/block version 与证据 digest，内容/布局变化使旧确认失效。

Q12/13 需要用实际页面区域判断，不能机械地从 Q12 移到 Q13 后就称正确。
Q31/32 需要分别识别两张图的可见位置与其中题号；共锚和反序尤其不能用数组下标绑定。
如果一张图包含整道题，它是尚待识读的题面材料，不应伪装成已结构化的空白题。

## 给 Mac 的只读脱敏小清单

仅四个 drawing 及它们邻近的题目区域，不导出全文、图片像素、姓名、目录或外部资源 URL。
不要求安装工具；已有工具取不到的字段写 null，并标为“需人工确认”。

| 交付 | 最少字段 |
| --- | --- |
| 版本一行 | d481、原 DOCX/转换副本/PDF digest、实际 LibreOffice/Pandoc 版本；标明视觉依据是同次 LibreOffice PDF 还是另一个 Word/PDF 导出 |
| drawing 四行 | 脱敏 drawing ID；part + paragraph/run index；邻近前后题号；inline/anchor；rId→media SHA/像素尺寸；`simplePos`、`positionH/V.relativeFrom` 与 offset/align、`extent`；存在时补 wrap、旋转/翻转、srcRect 裁切及相关 section 页尺寸/边距。只给属性，不给段落文字/图片描述 |
| 视觉位置表 | 各 occurrence 的 page_index、页面尺寸/旋转/CropBox、归一化图 bbox；Q11–14 与 Q30–32 中相关题号/题面区域 bbox、是否跨栏。注明哪些题号来自 PDF 文字层，哪些在图片里由人确认 |
| 四图确认结论 | 每张图目标题号或 unresolved；是否整题图片、是否有作答/个人信息（仅布尔）；同锚两图的可见顺序；确认所依据的 PDF digest。保留来源关系，不能只返回重新排好的图片数组 |

若 Mac 已有 `pdftotext -bbox-layout`，可以在本机得到文字层坐标并只汇总题号框；
图片内文字不在 PDF 文字层时，不把空返回当作题目不存在。图框可在现有页面图上人工标注。
原媒体 SHA 用于确认来源身份；PDF 可能重编码图像，不能要求 PDF 内对象字节与 DOCX 媒体 SHA 相同。

## 现成能力与缺口

| 可复用 | 当前限制及本切片做法 |
| --- | --- |
| `docx/convert.ts` 的有界 Pandoc/LibreOffice 转换 | 已有 PDF，不重复做一条转换链；保留原件和转换副本的身份，沿现有 ZIP/XML 预检限制提取 drawing manifest |
| `docx/persist-page-evidence.ts` → `pdf-render.ts` | 已免费渲染并存页面图；目前只返 assetIds/pageCount，需保留独立、有序的 page manifest、尺寸和 PDF digest，不能以混有媒体的 session.source_asset_ids 长度当页数 |
| 已安装 `@hyzyla/pdfium` | 可 getText、枚举/渲染图像对象；当前公开 types/绑定没有字符框和对象框 API，不能声称应用已有完整坐标提取。首刀用本地人工坐标，后续才评估薄适配 |
| `crop.ts` 的 Sharp 归一化裁图 | 已有裁剪算法，但当前只 put `figures/<id>.png`，没有相应 source_asset/SHA 登记；若产出正式 FigureRef，必须在既有裁图写口补齐身份与持久化契约，不能仅上传就声称图已可发布 |
| `figure_attach.ts` / FigureRef | 有正确页上的唯一包含判定、manual/high/low、bbox、target ID 与公开图保护；DOCX 当前没有真实题框，不能套用占位整页框推断归属 |
| `block-structured-edit.ts:711` / reassign_figure | 有事务、版本与事件；现在只移动同一 block 已有 FigureRef，不能首次创建 DOCX 图，也不能跨 Q12/Q13 两个独立块移动。需在既有编辑服务内小范围扩展，不能另写裸 SQL 绕过投影 |

底层 PDFium C API 确有[字符位置](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_text.h)
与[对象边界](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_edit.h)接口，说明无需 OCR 也能读取 PDF 已有位置；
这不等于当前 JS wrapper 已暴露它们。单纯图片不会因此变成文字，首刀不引入新的模型或 WASM 构建。

另须注意：`persistImageAsset` 用 `assets/<sha>` + 新 ID，而当前 `figuresForQuestion` 要求页面派生图 ID、
`figures/<id>.png` 与可核验 SHA；不能把两个写口无条件互换来绕过公开图保护。

## 最初方案（历史；本轮以以上已实施范围为准）

1. **先存可追溯证据。** 在现有 DOCX producer/session writer 中保存有界 drawing manifest、独立 page manifest、未解决图文问题；
   优先承载于现有 source_document.provenance 的 typed 扩展，且当次就有导入 consumer。图片与纯图片题继续保留，
   不将 XML 锚点自动升级为高置信度 FigureRef。现有 `page_spans=[page0,fullpage]` 只是占位，确认后才写真实位置。
2. **把四图确认接进现有草稿编辑。** 基于 Mac 的同份 PDF 坐标和明确目标，按 source/block version 校验，
   复用块锁、生命周期事件及重投影，原子更新来源/目标的图引用和确认凭据；未知或冲突保持 unresolved。
   如需生成裁图，复用 Sharp 并补既有 writer 的真实 source_asset/SHA 登记，不放松用途/可见性检查。
3. **补 DOCX 专属导入检查。** 在 `completeIngestionImport` 现有锁和事务内，检查尚未解决的图归属、纯图片题面缺失、
   确认版本/digest 及真实页面范围；`markReviewed` 不能替代这些证据。不要从警告文案正则推断解决状态。
   最初建议整批拒绝，后续 owner 已明确要求普通文字题可先导入；本轮改为逐题校验、保留未选草稿与 session 非终态。
4. **纯图片题保持真实状态。** 确认图片归属只能完成材料定位；在题干/选项等还未由本地人工补齐或获准识读之前，
   Q31/32 仍是保留原件的待处理草稿，不能用题号、占位文字或整页截图冒充完整正式题。此处不自动调用付费 rescue。

验收仍用现有 DB 边界 case，收敛为“未决→markReviewed 仍拒绝→证据解决后才允许”的一个事务场景，
并检查拒绝时草稿没有被 ignored；无需新矩阵。Mac 沿现有入口只增加四图、目标题与保留材料的逐项对账。
原卷完整提取、图引用、题型/选项、草稿确认、正式入库、可答题六项继续分开计数；不修改 admission 核心或伪造 admitted。

最小外部依赖就是上述 Mac 四行 drawing + 相关页坐标/人工确认。目前没有需要付费才能推进的步骤。
