# 校准成熟度面板 · 设计 brief（给 claude.ai/design）

- **date**: 2026-06-19
- **用途**: 贴进 claude.ai/design 的 loom-refresh 项目当设计 brief；视觉稿出来后我按 Loom Design System New(195b1262) 的 tokens slice-by-slice 实现。
- **配套**: 更详的功能 handoff 见 `2026-06-19-calibration-maturity-panel-handoff.md`；后端 read-model + endpoint 已 merge（PR #475，YUK-348）。

---

**Screen: 校准成熟度(Calibration Maturity) — admin/observability 面**

**它属于哪**: 单人 AI 学习工具里的一个管理/可观测屏，和现有 `screen-admin` 的 logs/cost/jobs 同族。按 Loom 视觉语言出稿。

**owner 想干什么(这屏存在的理由)**: 这工具的「掌握度」是慢热的——n=1 下每个知识点一开始都在「冷启」(估计不可信)，随 owner 持续作答才逐个「firm up(变可信)」。owner 想亲眼看着数据变准: 哪些知识点已可信、哪些还嫩、整张知识图的成熟进度，以及哪些点因从没练过、一直是冷启盲区(看到就能去补练)。把「数据什么时候更准」从抽象解释变成可看、可驱动行为的一屏。

**这屏拿得到的数据**(`GET /api/observability/calibration-maturity`，已实现):
- 整图聚合: `total_kcs`、`cold_start_count`、`firm_count`、`pct_firm`(firm 占比)、`median_theta_se`
- 每个知识点一行: `name`、`evidence_count`(累计作答证据数)、`theta_se`(θ̂ 标准误，越小越可信，冷启=1.0)、`confidence`(该点题目平均标定置信度，可能为空)、`track`(标定轨道，可能为空)、`cold_start`(布尔: firm ⟺ 有作答 且 evidence≥4 且 precision>1)

**功能上必须让 owner 一眼/几步内做到**(布局自定):
1. 整图 firm-up 进度——整张图多少比例已 firm vs 还冷启。
2. 逐知识点成熟度——浏览/排序每个点的证据量 / θ̂ SE / 冷启状态。
3. 冷启盲区——突出「从没练过(evidence=0)」的点。
4.(可选)从盲区点跳去练它的入口。

**一条硬语义约束(不是视觉、不能违反)**: 冷启 / 低置信的知识点绝不能显示成精确数字(不要「掌握度 = 78%」)。呈现口径是「可信 / 不可信 + 相对位置/排序」，不是精确百分比(依据 ADR-0035: 慢热期只信相对排序)。没练过的点展示上必须看得出「这还不知道」。

**不在范围**: 纯读、纯展示——不改掌握度计算(后端 B1)，不做写操作(第 4 条最多是导航链接)。

**风格**: 全权交给设计——布局/配色/组件/信息密度按 Loom 语言定。
