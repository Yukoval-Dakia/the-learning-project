// Loom — Today screen. Surfaces the Learning Orchestrator (control plane).
// Phase 2A "Review Orchestrator" answers: 今天应该复习什么，为什么？
// Phase 2B Learning Intent + Phase 3 Global Coach are stubbed as upcoming lanes.

const PhaseTag = ({ children }) => <span className="phase-tag">{children}</span>;

const OrchestratorPanel = ({ db, nav }) => {
  const dueMistakes = db.mistakes.filter(m => m.fsrs_state && m.fsrs_state.due * 1000 < Date.now());
  const concepts = dueMistakes.filter(m => m.cause?.primary_category === "concept").length;
  const knowGaps = dueMistakes.filter(m => m.cause?.primary_category === "knowledge_gap").length;
  const expressn = dueMistakes.filter(m => m.cause?.primary_category === "expression").length;

  return (
    <section className="orch">
      <header className="orch-head">
        <div>
          <div className="meta">Learning Orchestrator · Control Plane</div>
          <h2>今日学习安排</h2>
        </div>
        <PhaseTag>Phase 2A · planned</PhaseTag>
      </header>

      <p className="lede">
        Orchestrator 读取 FSRS 到期、错因分布、薄弱知识点，决定一个可解释、可拒绝的安排。
        硬数据由你的复习行为产生；它只写 <code>PlanStep</code> 和 reason。
      </p>

      <ol className="lane-list">
        <li className="lane lane-a">
          <div className="lane-head">
            <span className="meta-mono">A · Review</span>
            <PhaseTag>Phase 2A</PhaseTag>
          </div>
          <h3>复习 {dueMistakes.length} 道错题</h3>
          <p className="reason">
            <b>为什么：</b>{concepts > 0 && `${concepts} 道 concept 错因（最高权重）· `}
            {knowGaps > 0 && `${knowGaps} 道 knowledge_gap · `}
            {expressn > 0 && `${expressn} 道 expression`}
            {dueMistakes.length === 0 && "今日 FSRS 队列为空。"}
          </p>
          <div className="lane-actions">
            <Button variant="primary" onClick={() => nav("review")} disabled={dueMistakes.length === 0}>
              开始 review_session →
            </Button>
            <Button variant="ghost" onClick={() => nav("mistakes")}>看选题理由</Button>
          </div>
        </li>

        <li className="lane lane-b">
          <div className="lane-head">
            <span className="meta-mono">B · Learning Intent</span>
            <PhaseTag>Phase 2B · spec</PhaseTag>
          </div>
          <h3>新内容：尚无意图</h3>
          <p className="reason">
            <b>下一步：</b>声明「我想学 X」→ 自动拆 hub + atomic LearningItem，触发
            <code>NoteGenerateTask</code> + embedded check。
          </p>
          <div className="lane-actions">
            <Button variant="secondary" disabled>+ 我想学…（未实现）</Button>
          </div>
        </li>

        <li className="lane lane-c">
          <div className="lane-head">
            <span className="meta-mono">C · Coach</span>
            <PhaseTag>Phase 3 · spec</PhaseTag>
          </div>
          <h3>每日教练 · 周复盘</h3>
          <p className="reason">
            横跨 A/B/计划/复盘/维护，给一个可拒绝的安排。依赖 A/B 的行为数据落地后启动。
          </p>
          <div className="lane-actions">
            <Button variant="secondary" disabled>查看本周报告（未实现）</Button>
          </div>
        </li>
      </ol>

      <details className="orch-details">
        <summary>Task Dispatcher · 已注册任务</summary>
        <ul className="task-grid">
          {[
            ["AttributionTask",       "shipped"],
            ["VisionExtractTask",     "shipped"],
            ["FSRSReviewTask",        "in-flight · Sub 4A"],
            ["QuizGenTask",           "Phase 2"],
            ["QuizVerifyTask",        "Phase 2"],
            ["VariantGenTask",        "Phase 2"],
            ["VariantVerifyTask",     "Phase 2"],
            ["NoteGenerateTask",      "Phase 2"],
            ["NoteVerifyTask",        "Phase 2"],
            ["SourceRetrievalTask",   "Phase 2"],
            ["BlockAssemblyTask",     "Phase 2"],
            ["WeeklyReportTask",      "Phase 2"],
          ].map(([name, status]) => (
            <li key={name}>
              <span className="t-name">{name}</span>
              <span className="t-status">{status}</span>
            </li>
          ))}
        </ul>
      </details>

      <footer className="orch-foot meta">
        Cost guard · CostLedger 今日 $0.21 / $5 · ToolCallLog 47 calls · 详见 <a href="#" onClick={(e) => { e.preventDefault(); nav("inspect"); }}>/_/inspect</a>
      </footer>
    </section>
  );
};

const TodayScreen = ({ db, nav }) => {
  const dueCount = db.mistakes.filter(m => m.fsrs_state && m.fsrs_state.due * 1000 < Date.now()).length;
  const pendingAttr = db.mistakes.filter(m => !m.cause).length;
  return (
    <main className="page wide">
      <PageHeader title="Loom" eyebrow="/today · 编织三股线" />
      <div className="kpi-strip">
        <div><span className="big-num">{dueCount}</span><span className="meta">FSRS 到期</span></div>
        <div><span className="big-num">{pendingAttr}</span><span className="meta">归因中</span></div>
        <div><span className="big-num">{db.items.filter(i => i.status !== "done").length}</span><span className="meta">学习项</span></div>
        <div><span className="big-num">{db.knowledge.length}</span><span className="meta">知识点</span></div>
      </div>
      <OrchestratorPanel db={db} nav={nav} />
    </main>
  );
};

Object.assign(window, { TodayScreen });
