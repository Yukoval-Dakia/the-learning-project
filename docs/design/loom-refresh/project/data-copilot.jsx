// Loom · Copilot 全屏工作台 — 多会话数据 + tool_use 结果渲染件.
// Each session is a chat thread with messages; ai messages can carry a
// tool_use spec (fn · args · result · cost ribbon · approval actions).

/* ── result renderers (prefixed to avoid global clashes) ── */
const CopNodeRow = ({ icon, label, meta, score }) => (
  <div className="r-node">
    <span className="nico"><Icon name={icon} size={16} /></span>
    <span className="nbody"><div className="nlabel">{label}</div><div className="nmeta">{meta}</div></span>
    {score && <span className="nscore">{score}</span>}
  </div>
);
const CopMistakeRow = ({ wy, q, chain }) => (
  <div className="r-mistake">
    <div className="mq">{wy ? <span className="wenyan">{wy}</span> : null} {q}</div>
    <div className="chain">
      <span className="ev">attempt</span><span className="arrow">→</span>
      <span className="ev">judge</span><span className="arrow">→</span>
      <span className="cause">{chain}</span>
    </div>
  </div>
);

/* model options for the composer selector */
const COP_MODELS = [
  { id: "haiku",  name: "Haiku",  hint: "快 · ~$0.005/条", tone: "good" },
  { id: "sonnet", name: "Sonnet", hint: "强 · ~$0.18/条",  tone: "coral" },
];
Object.assign(window, { CopNodeRow, CopMistakeRow, COP_MODELS });

/* ── sessions ─────────────────────────────────────────────── */
DATA.copilotSessions = [
  {
    id: "s_zhi", title: "「之」用法答疑 · 主谓取独", group: "today", time: "14:32",
    model: "sonnet", cost: 0.214, msgN: 6, pinned: true,
    preview: "已检索 3 个节点、归因 3 条错题，并起草了 2 张变体题待你批准。",
    messages: [
      { role: "user", text: "「之」字今天又错了，帮我理一下用法，顺便看看最近的相关错题。" },
      { role: "ai", text: "先检索知识图谱，再拉最近 7 天的错题归因。",
        tool: {
          fn: "search_knowledge", icon: "search", status: "done", replayable: true,
          args: { query: "之 的用法", scope: "tree+mesh", k: 5 },
          meta: { model: "Haiku", cost: 0.004, latency: "380ms", conf: 0.91, caused: "e_4471" },
          result: (
            <div>
              <p className="result-lead">命中 <b>3</b> 个知识节点 · <b>4</b> 条 mesh 边</p>
              <div className="r-list">
                <CopNodeRow icon="knowledge" label="虚词「之」" meta="k_xuci_zhi · tree" score="0.94" />
                <CopNodeRow icon="knowledge" label="主谓之间取消独立性" meta="k_zhi_subj · mesh" score="0.88" />
                <CopNodeRow icon="knowledge" label="定语后置标志" meta="k_dingyu_hz · mesh" score="0.81" />
              </div>
            </div>
          ),
        } },
      { role: "ai", text: "「之」的四类核心用法已聚合好。要不要我顺带把相关错题也拉出来？" },
      { role: "user", text: "好，「师道之不传也久矣」这种属于哪类？最近错了几次？" },
      { role: "ai", text: "这句的「之」用于主谓之间、取消句子独立性。最近 7 天的归因：",
        tool: {
          fn: "query_mistakes", icon: "mistakes", status: "done", replayable: true,
          args: { where: "action='attempt' AND outcome='failure'", subject: "之", window: "7d" },
          meta: { model: "Haiku", cost: 0.006, latency: "540ms", caused: "e_4471" },
          result: (
            <div>
              <p className="result-lead">近 7 天 <b>3</b> 条相关错题，归因如下</p>
              <CopMistakeRow wy="师道之不传也久矣" q="「之」误作代词" chain="主谓之间·混淆" />
              <CopMistakeRow wy="蚓无爪牙之利" q="「之」释为「的」" chain="定语后置·漏标" />
            </div>
          ),
        } },
      { role: "ai", text: "看起来「主谓之间」这一类最薄弱。我可以基于它生成 2 张针对性变体题，要吗？",
        tool: {
          fn: "propose_variant", icon: "layers", status: "waiting", tone: "coral",
          args: { source_q: "q_zhi_root", focus: "主谓之间", count: 2 },
          meta: { model: "Sonnet", cost: 0.18, latency: "2.1s", conf: 0.84, caused: "e_4480" },
          actionHint: "AI 提议 2 张变体题",
          actions: [
            { label: "接受 2 张", variant: "good", icon: "plus", kind: "accept", ev: "e_4491 · propose→accept", done: "已写入 2 张卡片 · 进入今日队列" },
            { label: "忽略", variant: "ghost", icon: "close", kind: "dismiss", ev: "e_4492 · dismiss", done: "已忽略此提议" },
          ],
          result: (
            <div>
              <div className="r-variant">
                <div className="vtop"><span className="vtag">variant · 主谓之间</span><span className="vnew">NEW</span></div>
                <div className="vq">「臣之壮也，犹不如人」中「之」的语法功能是？</div>
                <div className="va">答案：主谓之间，取消句子独立性</div>
              </div>
              <div className="r-variant">
                <div className="vtop"><span className="vtag">variant · 主谓之间</span><span className="vnew">NEW</span></div>
                <div className="vq">填空：「师道之不传也久矣」中「之」用于 ＿ 之间。</div>
                <div className="va">答案：主谓</div>
              </div>
            </div>
          ),
        } },
    ],
  },
  {
    id: "s_judge", title: "判断句式 · 生成同型变体", group: "today", time: "11:08",
    model: "sonnet", cost: 0.18, msgN: 2, pinned: false,
    preview: "AI 提议一条 is_marker_of mesh 边，待你批准。",
    messages: [
      { role: "user", text: "判断句和「之」定语后置能不能在知识图谱里连起来？" },
      { role: "ai", text: "我建议补一条 mesh 边，把「之」标记为定语后置的标志词：",
        tool: {
          fn: "propose_edge", icon: "link", status: "waiting", tone: "info",
          args: { from: "k_xuci_zhi", to: "k_dingyu_hz", relation: "is_marker_of" },
          meta: { model: "Sonnet", cost: 0.05, latency: "0.9s", conf: 0.78, caused: "e_4488" },
          actionHint: "AI 提议一条 mesh 边",
          actions: [
            { label: "接受", variant: "good", icon: "check", kind: "accept", ev: "e_4493 · edge→accept", done: "已建立 is_marker_of 关系" },
            { label: "改关系", variant: "ghost", icon: "reverse", kind: "accept", ev: "e_4494 · retype", done: "已转入关系编辑" },
            { label: "忽略", variant: "ghost", icon: "close", kind: "dismiss", ev: "e_4495 · dismiss", done: "已忽略此关系" },
          ],
          result: (
            <div className="r-edge">
              <span className="enode">虚词「之」</span>
              <span className="rel"><span className="glyph">↳</span>is_marker_of</span>
              <span className="enode">定语后置</span>
            </div>
          ),
        } },
    ],
  },
  {
    id: "s_ocr", title: "试卷录入 · exam_0608.jpg", group: "today", time: "09:14",
    model: "sonnet", cost: 0.21, msgN: 2, pinned: false,
    preview: "OCR 已从 8 题中提取 5 题，仍在识别…",
    messages: [
      { role: "user", text: "我拍了一张期中卷，帮我把题目都录进来。" },
      { role: "ai", text: "正在跑视觉 OCR，结果会通过 SSE 实时流回来：",
        tool: {
          fn: "ocr_extract", icon: "camera", status: "done", replayable: true,
          args: { image: "exam_0608.jpg", pages: 1, job: "j_ocr_88" },
          meta: { model: "Sonnet vision · SSE", cost: 0.21, latency: "3.4s", caused: "e_4470" },
          result: (
            <div className="r-ocr">
              <div className="oitem"><span className="oi">q1</span><span className="ot">解释「使快弹数曲」的「快」</span></div>
              <div className="oitem"><span className="oi">q2</span><span className="ot">翻译「卒相与欢，为刎颈之交」</span></div>
              <div className="oitem"><span className="oi">q3</span><span className="ot">「之」字用法辨析（四句）</span></div>
            </div>
          ),
        } },
    ],
  },
  {
    id: "s_eng", title: "英语完形 · 错因复盘", group: "yesterday", time: "昨天 20:41",
    model: "haiku", cost: 0.012, msgN: 4, pinned: false,
    preview: "时态题连续错 2 次，已上调复习权重。",
    messages: [
      { role: "user", text: "英语完形老在时态那里丢分，查一下。" },
      { role: "ai", text: "拉了完形相关的错题：",
        tool: {
          fn: "query_mistakes", icon: "mistakes", status: "done", replayable: true,
          args: { where: "subject_kind='question' AND tag='eng_cloze'", window: "14d" },
          meta: { model: "Haiku", cost: 0.006, latency: "410ms", caused: "e_4402" },
          result: (
            <div>
              <p className="result-lead">近 14 天 <b>2</b> 条，集中在时态一致</p>
              <CopMistakeRow q="woke up … and ___ the air → 误选 breathing" chain="并列时态·一致" />
            </div>
          ),
        } },
      { role: "user", text: "那帮我排进复习。" },
      { role: "ai", text: "已把「并列结构时态一致」排入明天的队列，间隔 1 天。" },
    ],
  },
  {
    id: "s_fsrs", title: "复习节奏怎么排更稳", group: "yesterday", time: "昨天 08:03",
    model: "haiku", cost: 0.000, msgN: 2, pinned: false,
    preview: "schedule_fsrs：明天 9:00 到期，间隔 1d。",
    messages: [
      { role: "user", text: "我把「之·用法」评了「不会」，下次什么时候复习？" },
      { role: "ai", text: "FSRS 是确定性计算，不花钱：",
        tool: {
          fn: "schedule_fsrs", icon: "review", status: "done", tone: "good",
          args: { node: "k_xuci_zhi", rating: "again" },
          meta: { model: "deterministic", cost: 0, latency: "12ms", caused: "e_4485" },
          result: (
            <div className="r-sched">
              <div className="cell"><div className="lbl">DUE</div><div className="big">明天<span className="u">9:00</span></div></div>
              <div className="cell"><div className="lbl">INTERVAL</div><div className="big">1<span className="u">d</span></div></div>
              <div className="cell"><div className="lbl">STABILITY</div><div className="big">2.3<span className="u">d</span></div></div>
            </div>
          ),
        } },
    ],
  },
  {
    id: "s_math", title: "导数大题第 (3) 问讲解", group: "earlier", time: "12 月 4 日",
    model: "sonnet", cost: 0.09, msgN: 2, pinned: false,
    preview: "闭区间最值：比较极值与端点，最大值 3。",
    messages: [
      { role: "user", text: "导数那道大题第 (3) 问我没思路，闭区间最值怎么求？" },
      { role: "ai", text: "闭区间上的最值，只需比较「极值点」与「两端点」的函数值：",
        tool: {
          fn: "explain", icon: "book", status: "done", tone: "info", replayable: true,
          args: { target: "闭区间最值", context: "f(x)=x^3-3x+1, [-2,2]" },
          meta: { model: "Sonnet", cost: 0.09, latency: "1.4s", conf: 0.9, caused: "e_4466" },
          result: (
            <div className="r-explain">
              <p>先求 <b>f'(x)=3x²−3</b>，零点 x=±1（候选极值点）。</p>
              <p>比较 f(−2)=−1, f(−1)=3, f(1)=−1, f(2)=3，故区间最大值为 <b>3</b>、最小值为 <b>−1</b>。</p>
            </div>
          ),
        } },
    ],
  },
];

/* group labels + ordering */
const COP_GROUPS = [["today", "今天"], ["yesterday", "昨天"], ["earlier", "更早"]];
function copSessions() { return DATA.copilotSessions; }
Object.assign(window, { COP_GROUPS, copSessions });
