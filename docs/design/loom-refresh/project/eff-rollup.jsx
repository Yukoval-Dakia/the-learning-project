// Loom · 成效趋势面 — 科目卷起(规模 / 合成根).
// 首屏 = 按科目卷起 + 只高亮「本期动了的」KC;逐 KC 轨迹是下钻态(点某科才展开)。
// 三个合成根态:未归类桶(孤儿 KC,同级显式)/ 科目整体行(子 KC 未抽出)/ 跨科归一科。
// 科目级卷起把单 KC 的 n=1 噪声平均掉 —— 整科趋势常比任一 KC 更可信,但 n=1 下绝不到 firm。
// ────────────────────────────────────────────────────────────────────────

function effSubjectKCs(series, domainId) {
  return series.filter((k) => (domainId === "__uncat" ? k.effective_domain == null : k.effective_domain === domainId));
}

// 科目级方向 + 置信:从子 KC 派生(噪声平均)。绝不写回,纯读。
function effRollup(kcs) {
  const counts = { rising: 0, holding: 0, falling: 0, insufficient: 0 };
  kcs.forEach((k) => counts[k.direction]++);
  if (!kcs.length) return { direction: "insufficient", confidence: "low", ev: 0, counts };
  const ev = kcs.reduce((s, k) => s + (k.span_evidence || 0), 0);
  const solid = kcs.filter((k) => k.confidence === "firm" || k.confidence === "mid").length;
  let direction;
  if (counts.insufficient >= kcs.length * 0.6) direction = "insufficient";
  else if (counts.rising > counts.falling && counts.rising >= counts.holding) direction = "rising";
  else if (counts.falling > counts.rising && counts.falling >= counts.holding) direction = "falling";
  else direction = "holding";
  const confidence = ev >= 40 && solid >= 3 ? "mid" : "low"; // 整科:证据足才给 mid;n=1 绝不 firm
  return { direction, confidence, ev, counts };
}

// 「本期动了的」紧凑项:只在科目行内高亮涨/退的少数 KC。
function EffMovedKC({ kc, onDrill }) {
  const dir = EFF_DIR[kc.direction];
  const tender = kc.confidence === "low";
  return (
    <button className={"eff-moved is-" + kc.direction + (tender ? " is-tender" : "")} onClick={onDrill} title={kc.delta}>
      <span className="eff-moved-top">
        <span className={"eff-moved-glyph tone-" + dir.tone}>{dir.glyph}</span>
        <span className="eff-moved-name wenyan">{kc.name}</span>
        <EffConfTag kc={kc} mini />
      </span>
      <EffTrajectory kc={kc} w={132} h={34} padY={6} compact />
    </button>
  );
}

// 科目卷起行:整科方向 + 置信 + 「动了的」高亮 + 持平/不足折叠 + 下钻。
function EffSubjectRow({ subject, kcs, onDrill, uncategorized }) {
  const roll = effRollup(kcs);
  const dir = EFF_DIR[roll.direction];
  const moved = kcs.filter((k) => k.direction === "rising" || k.direction === "falling");
  const settled = roll.counts.holding + roll.counts.insufficient;
  const confKc = { confidence: roll.confidence, direction: roll.direction, span_evidence: roll.ev };
  return (
    <div className={"eff-subj" + (uncategorized ? " is-uncat" : "")}>
      <div className="eff-subj-head">
        <button className="eff-subj-name-btn" onClick={() => onDrill(subject.id)}>
          {uncategorized && <span className="eff-subj-uncat-ic"><Icon name="hash" size={15} /></span>}
          <span className="eff-subj-name serif">{subject.name}</span>
          <span className="eff-subj-count">{kcs.length} KC</span>
        </button>
        <span className={"eff-dirchip lg tone-" + dir.tone}>{dir.glyph} 整科相对{dir.label}</span>
        <EffConfTag kc={confKc} />
        <button className="eff-subj-drill" onClick={() => onDrill(subject.id)}>展开逐 KC <Icon name="chevronRight" size={14} /></button>
      </div>
      <p className="eff-subj-note">{subject.note}</p>
      <div className="eff-subj-moved">
        <span className="eff-subj-moved-l meta">本期动了的</span>
        {moved.length
          ? moved.map((k) => <EffMovedKC key={k.id} kc={k} onDrill={() => onDrill(subject.id)} />)
          : <span className="eff-subj-nomove meta">这科本期没有明显涨 / 退的 KC</span>}
        {settled > 0 && (
          <button className="eff-subj-settled" onClick={() => onDrill(subject.id)} title="默认折叠,点开看全部">
            +{roll.counts.holding} 持平 · {roll.counts.insufficient} 数据不足 <span className="eff-subj-settled-x">默认折叠</span>
          </button>
        )}
      </div>
    </div>
  );
}

// 科目整体行:题还堆在科目根、子 KC 没抽出 → 只给一条「整科」轨迹(当科目级渲染)。
function EffSubjectWholeRow({ subject }) {
  const w = subject.whole;
  const dir = EFF_DIR[w.direction];
  const kc = { id: subject.id + "_whole", name: subject.name, points: w.points, direction: w.direction, confidence: w.confidence, span_evidence: w.span_evidence };
  return (
    <div className="eff-subj is-whole">
      <div className="eff-subj-head">
        <span className="eff-subj-name serif">{subject.name}</span>
        <span className="eff-subj-wholetag"><Icon name="layers" size={12} />整科 · 子 KC 未抽出</span>
        <span className={"eff-dirchip lg tone-" + dir.tone}>{dir.glyph} 整科相对{dir.label}</span>
        <span className="eff-conf is-low">低置信 · 别当真</span>
      </div>
      <p className="eff-subj-note">{subject.note}</p>
      <div className="eff-subj-wholeviz">
        <EffTrajectory kc={kc} w={300} h={56} showBands />
        <div className="eff-subj-wholeside">
          <span className="eff-subj-wholedelta">{w.delta}</span>
          <span className="eff-subj-wholehint meta">抽出子 KC 后,这里会裂成逐 KC 的卷起。</span>
        </div>
      </div>
    </div>
  );
}

// 首屏:科目卷起 + 未归类桶(合成根下,各科同级)。
function EffSubjectRollup({ series, onDrill }) {
  const subjects = window.EFFICACY.subjects;
  const uncats = effSubjectKCs(series, "__uncat");
  return (
    <div className="eff-rollup">
      {subjects.map((subj) =>
        subj.whole
          ? <EffSubjectWholeRow key={subj.id} subject={subj} />
          : <EffSubjectRow key={subj.id} subject={subj} kcs={effSubjectKCs(series, subj.id)} onDrill={onDrill} />
      )}
      {uncats.length > 0 && (
        <EffSubjectRow uncategorized
          subject={{ id: "__uncat", name: "未归类", note: "没挂到任何科目的孤儿 KC(domain 空)—— 与各科同级显式渲染,不藏、不硬塞进某科。" }}
          kcs={uncats} onDrill={onDrill} />
      )}
    </div>
  );
}

Object.assign(window, {
  effSubjectKCs, effRollup, EffMovedKC, EffSubjectRow, EffSubjectWholeRow, EffSubjectRollup,
});
