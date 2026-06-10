// Loom · Copilot tool_use 卡片展示 — specs + page

/* ── result renderers ───────────────────────────────────── */
const NodeRow = ({ icon, label, meta, score }) => (
  <div className="r-node">
    <span className="nico"><Icon name={icon} size={16} /></span>
    <span className="nbody"><div className="nlabel">{label}</div><div className="nmeta">{meta}</div></span>
    {score && <span className="nscore">{score}</span>}
  </div>
);

const MistakeRow = ({ q, wy, chain }) => (
  <div className="r-mistake">
    <div className="mq">{wy ? <span className="wenyan">{wy}</span> : null} {q}</div>
    <div className="chain">
      <span className="ev">attempt</span><span className="arrow">→</span>
      <span className="ev">judge</span><span className="arrow">→</span>
      <span className="cause">{chain}</span>
    </div>
  </div>
);

/* ════════ the complete tool vocabulary ════════ */
const TOOLS = [
  {
    fn: "search_knowledge", icon: "search", status: "done", replayable: true,
    args: { query: "之 的用法", scope: "tree+mesh", k: 5 },
    meta: { model: "Haiku", cost: 0.004, latency: "380ms", conf: 0.91, caused: "e_4471" },
    result: (
      <div>
        <p className="result-lead">命中 <b>3</b> 个知识节点 · <b>4</b> 条 mesh 边</p>
        <div className="r-list">
          <NodeRow icon="knowledge" label="虚词「之」" meta="k_xuci_zhi · tree" score="0.94" />
          <NodeRow icon="knowledge" label="主谓之间取消独立性" meta="k_zhuwei · mesh" score="0.88" />
          <NodeRow icon="knowledge" label="定语后置标志" meta="k_dingyu_hz · mesh" score="0.81" />
        </div>
      </div>
    ),
  },
  {
    fn: "query_mistakes", icon: "mistakes", status: "done", replayable: true,
    args: { where: "action='attempt' AND outcome='failure'", subject: "之", window: "7d" },
    meta: { model: "Haiku", cost: 0.006, latency: "540ms", caused: "e_4471" },
    result: (
      <div>
        <p className="result-lead">近 7 天 <b>3</b> 条相关错题，归因如下</p>
        <MistakeRow wy="蚓无爪牙之利" q="「之」释为「的」" chain="定语后置·漏标" />
        <MistakeRow wy="师道之不传也久矣" q="「之」误作代词" chain="主谓之间·混淆" />
      </div>
    ),
  },
  {
    fn: "propose_variant", icon: "layers", status: "waiting", tone: "coral",
    args: { source_q: "q_142", focus: "主谓之间", count: 2 },
    meta: { model: "Sonnet", cost: 0.18, latency: "2.1s", conf: 0.84, caused: "e_4480" },
    actionHint: "AI 提议 2 张变体题",
    actions: [
      { label: "接受 2 张", variant: "good", icon: "plus", kind: "accept", ev: "e_4491 · propose→accept", done: "已写入 2 张卡片 · 进入今日队列" },
      { label: "忽略", variant: "quiet", icon: "close", kind: "dismiss", ev: "e_4492 · dismiss", done: "已忽略此提议" },
    ],
    result: (
      <div>
        <div className="r-variant">
          <div className="vtop"><span className="vtag">variant · 主谓之间</span><span className="vnew">NEW</span></div>
          <div className="vq">「师道之不传也久矣」中「之」的作用是？</div>
          <div className="va">答案：取消句子独立性，主谓之间</div>
        </div>
        <div className="r-variant">
          <div className="vtop"><span className="vtag">variant · 主谓之间</span><span className="vnew">NEW</span></div>
          <div className="vq">「臣之壮也，犹不如人」断句与「之」义</div>
          <div className="va">答案：主谓之间，取消独立性</div>
        </div>
      </div>
    ),
  },
  {
    fn: "explain", icon: "book", status: "done", tone: "info", replayable: true,
    args: { target: "「之」", context: "蚓无爪牙之利" },
    meta: { model: "Sonnet", cost: 0.09, latency: "1.4s", conf: 0.88, caused: "e_4471" },
    result: (
      <div className="r-explain">
        <p>此处「之」是 <b>定语后置的标志</b>，不译。</p>
        <p>正常语序为「<span className="wy">蚓无利之爪牙</span>」，「利」是「爪牙」的定语，后置以强调，「之」起提宾、连接作用。</p>
      </div>
    ),
  },
  {
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
  },
  {
    fn: "propose_edge", icon: "link", status: "waiting", tone: "info",
    args: { from: "k_xuci_zhi", to: "k_dingyu_hz", relation: "is_marker_of" },
    meta: { model: "Sonnet", cost: 0.05, latency: "0.9s", conf: 0.78, caused: "e_4488" },
    actionHint: "AI 提议一条 mesh 边",
    actions: [
      { label: "接受", variant: "good", icon: "check", kind: "accept", ev: "e_4493 · edge→accept", done: "已建立 is_marker_of 关系" },
      { label: "改关系", variant: "ghost", icon: "reverse", kind: "accept", ev: "e_4494 · edge→retype", done: "已转入关系编辑" },
      { label: "忽略", variant: "quiet", icon: "close", kind: "dismiss", ev: "e_4495 · dismiss", done: "已忽略此关系" },
    ],
    result: (
      <div className="r-edge">
        <span className="enode">虚词「之」</span>
        <span className="rel"><span className="glyph">↳</span>is_marker_of</span>
        <span className="enode">定语后置</span>
      </div>
    ),
  },
  {
    fn: "write_note", icon: "pencil", status: "waiting", tone: "coral",
    args: { node: "k_xuci_zhi", op: "append" },
    meta: { model: "Sonnet", cost: 0.07, latency: "1.1s", conf: 0.86, caused: "e_4486" },
    actionHint: "AI 起草了一段笔记追加",
    actions: [
      { label: "接受改动", variant: "good", icon: "check", kind: "accept", ev: "e_4496 · note→accept", done: "已追加到 k_xuci_zhi 笔记" },
      { label: "忽略", variant: "quiet", icon: "close", kind: "dismiss", ev: "e_4497 · dismiss", done: "已丢弃草稿" },
    ],
    result: (
      <div className="r-diff">
        <div className="dl ctx">「之」的六类用法</div>
        <div className="dl ctx">1. 代词 2. 助词「的」…</div>
        <div className="dl add">5. 主谓之间，取消句子独立性</div>
        <div className="dl add">6. 定语后置 / 宾语前置的标志</div>
      </div>
    ),
  },
  {
    fn: "ocr_extract", icon: "camera", status: "run", replayable: true,
    args: { image: "exam_0530.jpg", pages: 1, job: "j_ocr_88" },
    meta: { model: "Sonnet vision · SSE", cost: 0.21, latency: "streaming", caused: "e_4470" },
    running: (
      <div className="r-stream">
        正在识别第 1 页…<br />
        已提取 <b>5</b> / 8 题<span className="cursor" />
      </div>
    ),
    result: (
      <div className="r-ocr">
        <div className="oitem"><span className="oi">q1</span><span className="ot">解释「使快弹数曲」的「快」</span></div>
        <div className="oitem"><span className="oi">q2</span><span className="ot">翻译「卒相与欢，为刎颈之交」</span></div>
        <div className="oitem"><span className="oi">q3</span><span className="ot">「之」字用法辨析（四句）</span></div>
      </div>
    ),
  },
];

/* ════════ same tool across all 5 states ════════ */
const baseQuery = {
  fn: "query_mistakes", icon: "mistakes",
  args: { where: "action='attempt' AND outcome='failure'", window: "7d" },
};
const STATE_CARDS = [
  { ...baseQuery, status: "run", running: <DefaultSkeleton />, meta: { model: "Haiku", cost: 0.006, latency: "…", caused: "e_4471" } },
  { ...baseQuery, status: "done",
    meta: { model: "Haiku", cost: 0.006, latency: "540ms", caused: "e_4471" },
    result: (<div><p className="result-lead">命中 <b>3</b> 条错题</p><MistakeRow wy="蚓无爪牙之利" q="「之」释为「的」" chain="定语后置·漏标" /></div>) },
  { ...baseQuery, status: "empty",
    emptyView: (<div className="r-empty"><span className="ei"><Icon name="checkCircle" size={26} /></span><div className="et">近 7 天没有相关错题</div><div className="es">太好了，这个知识点稳住了。</div></div>) },
  { ...baseQuery, status: "error",
    errorView: (<div className="r-error"><span className="eic"><Icon name="alert" size={18} /></span><div><div className="etxt">查询超时，事件库未响应。</div><div className="ecode">ETIMEDOUT · pg-boss · 已自动重排重试</div></div></div>) },
  { ...baseQuery, status: "waiting", tone: "coral",
    meta: { model: "Haiku", cost: 0.006, latency: "540ms", conf: 0.82, caused: "e_4471" },
    actionHint: "查到 1 条，要排进今天吗？",
    actions: [
      { label: "排进今日", variant: "good", icon: "plus", kind: "accept", ev: "e_4490 · enqueue", done: "已加入今日复习队列" },
      { label: "稍后", variant: "quiet", icon: "close", kind: "dismiss", ev: "e_4491 · skip", done: "已跳过" },
    ],
    result: (<div><p className="result-lead">命中 <b>1</b> 条待处理错题</p><MistakeRow wy="师道之不传也久矣" q="「之」误作代词" chain="主谓之间·混淆" /></div>) },
];
const STATE_LABELS = ["运行中 · streaming", "完成 · 结构化结果", "无结果 · gently human", "失败 · 自动重试", "待批准 · 你来定夺"];

/* ── anatomy legend rows ────────────────────────────────── */
const ANATOMY = [
  { tag: "header", d: <span><b>工具名 + actor + 状态</b>。函数名用 mono，<code>agent</code> 标签说明是 AI 在调用，右侧状态胶囊随生命周期变色。</span> },
  { tag: "args", d: <span><b>调用参数</b>，函数签名式呈现；点 <code>args</code> 可展开原始 JSON。查询类工具直接把 <code>where</code> 子句摊给你看。</span> },
  { tag: "result", d: <span><b>结构化结果</b>，每种工具有自己的版式：节点列表、归因链、变体卡、排程格、mesh 边、笔记 diff。</span> },
  { tag: "ribbon", d: <span><b>成本透明</b>：模型 · <code>$0.00x</code> · 耗时 · 置信度 · <code>caused_by</code> 事件链。确定性工具成本为 <code>$0.000</code>。</span> },
  { tag: "actions", d: <span><b>你是审批人</b>：接受 / 忽略 / 改关系，永不静默自动化；每个动作都落一条新 event。</span> },
];

function App() {
  return (
    <div className="stage">
      <div className="wrap">
        <header className="show-head">
          <div className="brandline"><BrandMark size={28} /><span className="name">Loom</span></div>
          <div className="eyebrow">COPILOT · <b>tool_use</b> cards · agent with tools <b>+</b> a cost, not a chatbot</div>
          <h1>Copilot 的工具卡片</h1>
          <p className="lede">Copilot 调用工具时，每一次 <code>tool_use</code> 都是抽屉里的一等卡片——它查了什么、花了多少钱、有多确信、由哪条事件触发，以及需要你拍板什么，全部摊开。下面是完整的卡片词汇表。</p>
        </header>

        <div className="legend">
          <span className="lg"><StatusPill status="run" /></span>
          <span className="lg"><StatusPill status="done" /></span>
          <span className="lg"><StatusPill status="empty" /></span>
          <span className="lg"><StatusPill status="error" /></span>
          <span className="lg"><StatusPill status="waiting" /></span>
        </div>

        {/* anatomy */}
        <section className="sec" style={{ marginTop: "var(--s-10)" }}>
          <div className="sec-label"><h2 className="serif">解剖</h2><span className="rule" /><span className="n">anatomy</span></div>
          <div className="anatomy">
            <ToolCard spec={TOOLS[0]} />
            <div className="anatomy-legend">
              {ANATOMY.map((a) => (
                <div className="li" key={a.tag}><span className="tag">{a.tag}</span><div className="ld">{a.d}</div></div>
              ))}
            </div>
          </div>
        </section>

        {/* states */}
        <section className="sec">
          <div className="sec-label"><h2 className="serif">五种状态</h2><span className="rule" /><span className="n">one tool · 5 states</span></div>
          <p className="sec-note">同一个 <code>query_mistakes</code> 调用，在生命周期里呈现的五种面貌。空状态温和不煽情，失败会自动重排重试，需要批准时把决定权交还给你。</p>
          <div className="gallery">
            {STATE_CARDS.map((s, i) => (
              <div key={i}>
                <div className="eyebrow" style={{ marginBottom: "var(--s-2)" }}>{STATE_LABELS[i]}</div>
                <ToolCard spec={s} />
              </div>
            ))}
          </div>
        </section>

        {/* full vocabulary */}
        <section className="sec">
          <div className="sec-label"><h2 className="serif">工具全集</h2><span className="rule" /><span className="n">{TOOLS.length} tools</span></div>
          <p className="sec-note">Copilot 能调用的全部工具，各自的真实结果版式。带 <b>重放</b> 的卡片可点右上角看 运行→完成 的过渡；带 <b>待你批准</b> 的卡片，接受 / 忽略按钮会真的落事件。</p>
          <div className="gallery">
            {TOOLS.map((t) => <ToolCard key={t.fn} spec={t} />)}
          </div>
        </section>

        <footer style={{ marginTop: "var(--s-16)", paddingTop: "var(--s-6)", borderTop: "1px solid var(--line)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", color: "var(--ink-5)" }}>
          loom · tool_use cards · adr-0006 event-sourced · warm-paper, single-coral
        </footer>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
