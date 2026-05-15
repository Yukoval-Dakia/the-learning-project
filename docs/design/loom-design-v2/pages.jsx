/* Loom v2 — all 6 routes + Copilot drawer.
   Everything reads from window.EVENTS / window.QUESTIONS / window.KNOWLEDGE.
   Updates write to React state — no backend. */

const { useState, useMemo, useEffect, useRef } = React;

// ════════════════════════════════════════════════════════════
//   /today — Learning Orchestrator
//   ───────────────────────────────────────────────────────────
//   • KPI strip (4 metrics derived from event filters)
//   • Proposal inbox preview (nightly Dreaming session)
//   • Three lanes: A Review · B Learning Intent · C Coach
//   • Cost ribbon
// ════════════════════════════════════════════════════════════
const TodayScreen = ({ db, nav, setProposalStatus, proposalStatus, lanesMode }) => {
  const { byId, childrenOf } = useMemo(() => indexEvents(db.events), [db.events]);

  // KPI derivations — all from events table (event-driven views)
  const mistakesPending = db.events.filter(e =>
    e.action === 'attempt' && e.outcome === 'failure' &&
    !db.events.find(j => j.caused_by_event_id === e.id && j.action === 'judge')
  ).length;
  const reviewedToday = db.events.filter(e => e.action === 'review' && e.created_at > NOW - DAY).length;
  const dueNow = 6; // FSRS projected — would be a query
  const aiProposalsLast24h = db.events.filter(e =>
    e.actor_kind === 'agent' && e.action === 'propose' && e.created_at > NOW - DAY &&
    !proposalStatus[e.id]
  ).length;
  const aiGenerated24h = db.events.filter(e =>
    e.actor_kind === 'agent' && e.action === 'generate' && e.created_at > NOW - DAY &&
    !proposalStatus[e.id]
  ).length;

  // Nightly dreaming session summary
  const dreamSession = db.sessions.s_dream_last_night;
  const dreamEvents = db.events.filter(e => e.session_id === 's_dream_last_night');
  const dreamProposals = dreamEvents.filter(e =>
    (e.action === 'propose' || e.action === 'generate') && !proposalStatus[e.id]
  );
  const dreamCost = dreamEvents.reduce((s, e) => s + (e.cost_micro_usd || 0), 0) / 1e6;

  // Recent agent activity (last 24h)
  const recentAgentEvents = db.events
    .filter(e => e.actor_kind === 'agent' && e.created_at > NOW - DAY)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 5);

  return (
    <main className="page wide">
      <PageHeader
        eyebrow="TODAY · 2026-05-15 · phase 1c"
        title="今日"
        sub="昨晚 Dreaming agent 跑过；下面是它想让你看的几件事，再加你自己排的复习队列。">
        <Button variant="secondary" icon="refresh" onClick={() => nav('today')}>刷新</Button>
        <Button variant="primary" icon="pen" onClick={() => nav('record')}>录入</Button>
      </PageHeader>

      {/* KPI strip — pure event-filter projections */}
      <div className="kpi-strip">
        <div className="kpi">
          <div className="kpi-label">复习 · 待办</div>
          <div className="kpi-num">{dueNow}<small> 题</small></div>
          <div className="kpi-trend">events action=review · due&lt;=now</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">错题 · 待归因</div>
          <div className="kpi-num">{mistakesPending}<small> 条</small></div>
          <div className="kpi-trend">attempt:failure 无 judge 子事件</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">AI 提议 · 24h</div>
          <div className="kpi-num">{aiProposalsLast24h + aiGenerated24h}<small> 条</small></div>
          <div className="kpi-trend up">{aiProposalsLast24h} 知识 · {aiGenerated24h} 内容</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">已复习 · 今日</div>
          <div className="kpi-num">{reviewedToday}<small> 题</small></div>
          <div className="kpi-trend">events action=review created_at&gt;=今日</div>
        </div>
      </div>

      {/* Dreaming inbox preview — §6.2 distributed but with today surface */}
      {dreamProposals.length > 0 && (
        <div className="inbox-strip">
          <div className="inbox-text">
            <div className="src"><ActorBadge actorKind="cron" actorRef="nightly_dreaming" /> · {relTime(dreamSession.started_at)}启动 · {((dreamSession.ended_at - dreamSession.started_at) / 60).toFixed(0)} 分钟 · ${dreamCost.toFixed(3)}</div>
            <h3>昨晚 AI 提议了 {dreamProposals.length} 条，要看吗？</h3>
            <div className="breakdown">
              <div><b>{dreamProposals.filter(e => e.action === 'generate' && e.payload.artifact_kind === 'variant').length}</b><span>变式</span></div>
              <div><b>{dreamProposals.filter(e => e.action === 'generate' && e.payload.artifact_kind === 'quiz').length}</b><span>小测</span></div>
              <div><b>{dreamProposals.filter(e => e.action === 'propose').length}</b><span>新知识节点</span></div>
            </div>
          </div>
          <div className="row gap-md">
            <Button variant="secondary" onClick={() => nav('mistakes')}>分散审批</Button>
            <Button variant="primary" iconRight="arrowR" onClick={() => nav('inbox')}>集中审批</Button>
          </div>
        </div>
      )}

      {/* Three orchestrator lanes */}
      <div className="lanes">
        <Lane
          eyebrow="LANE A"
          title="复习队列 (FSRS)"
          badge={<Badge tone="coral">{dueNow} 到期</Badge>}>
          <div className="lane-item">
            <div className="top">
              <Icon name="clock" size={11} /><span>q3 · 过期 1h</span>
              <span className="spacer" /><Badge tone="again">again</Badge>
            </div>
            <div className="body">「青，取之于蓝，而青于蓝」中两个"于"的用法？</div>
          </div>
          <div className="lane-item">
            <div className="top">
              <Icon name="clock" size={11} /><span>q1 · 现在</span>
              <span className="spacer" /><Badge tone="hard">hard</Badge>
            </div>
            <div className="body">"之"在「古之学者必有师」中的用法是？</div>
          </div>
          <div className="lane-item">
            <div className="top">
              <Icon name="clock" size={11} /><span>q2 · 现在</span>
              <span className="spacer" /><Badge tone="hard">hard</Badge>
            </div>
            <div className="body">翻译：「师者，所以传道受业解惑也」。</div>
          </div>
          <Button variant="primary" iconRight="arrowR" onClick={() => nav('review')} style={{ marginTop: 6 }}>开始复习</Button>
        </Lane>

        <Lane
          eyebrow="LANE B"
          title="学习意图"
          badge={lanesMode === 'show-disabled'
            ? <Badge tone="neutral" dot dotStatic>stub</Badge>
            : <Badge tone="neutral">{db.items.filter(i => i.status !== 'done').length} 项</Badge>}
          stub={lanesMode === 'show-disabled'}>
          {lanesMode === 'show-disabled' ? (
            <div className="lane-empty">
              <p style={{margin:0,color:'var(--ink-4)',fontSize:13.5,lineHeight:1.55}}>
                数据来源待定：当前 learning_item 表 与 event 流解耦，应显示 AI 推荐
                的「下一步该学什么」。Phase 1c.2 接入。
              </p>
              <code className="meta-mono" style={{display:'block',marginTop:8}}>events WHERE action='propose' AND subject_kind='learning_item' (placeholder)</code>
            </div>
          ) : (
            <>
              {db.items.filter(i => i.status !== 'done').slice(0, 3).map(it => (
                <div className="lane-item" key={it.id}>
                  <div className="top">
                    {it.source === 'agent' ? <ActorBadge actorKind="agent" actorRef="dreaming" compact /> : <ActorBadge actorKind="user" compact />}
                    <span>·</span>
                    <StatusBadge status={it.status} />
                  </div>
                  <div className="body">{it.title}</div>
                </div>
              ))}
            </>
          )}
        </Lane>

        <Lane
          eyebrow="LANE C"
          title="AI Coach · 最近活动"
          badge={<Badge tone="info">{recentAgentEvents.length}</Badge>}>
          {recentAgentEvents.map(ev => (
            <div className="lane-item" key={ev.id}>
              <div className="top">
                <ActorBadge actorKind="agent" actorRef={ev.actor_ref} compact />
                <span>{ACTION_LABEL[ev.action] || ev.action}</span>
                <span className="spacer" />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-4)' }}>{relTime(ev.created_at)}</span>
              </div>
              <div className="body" style={{ fontSize: 13.5 }}>{describeEvent(ev)}</div>
            </div>
          ))}
        </Lane>
      </div>

      {/* Cost ribbon */}
      <CostRibbon
        today={0.51}
        budget={5.0}
        breakdown={[
          { label: 'dreaming', value: 0.49 },
          { label: 'attribution', value: 0.013 },
          { label: 'copilot', value: 0.004 },
        ]}
      />
    </main>
  );
};

// ════════════════════════════════════════════════════════════
//   /mistakes — attempt+failure events with AI children
//   §6.1 default B: inline <details> EventChain
//   §6.2 distributed: per-event proposal cards
// ════════════════════════════════════════════════════════════
const MistakesScreen = ({ db, nav, proposalStatus, setProposalStatus }) => {
  const { byId, childrenOf } = useMemo(() => indexEvents(db.events), [db.events]);

  // events WHERE action='attempt' AND outcome='failure' AND subject_kind='question'
  const attempts = db.events
    .filter(e => e.action === 'attempt' && e.outcome === 'failure' && e.subject_kind === 'question')
    .sort((a, b) => b.created_at - a.created_at);

  return (
    <main className="page">
      <PageHeader
        eyebrow="MISTAKES · events action=attempt outcome=failure"
        title="错题"
        sub="每一条错题下方是 AI 沿 caused_by 链生成的归因 + 变式 + 笔记。接受 / 忽略 写一条 action=rate 事件。">
        <Button variant="secondary" icon="search">筛选</Button>
        <Button variant="primary" icon="plus" onClick={() => nav('record')}>录入</Button>
      </PageHeader>

      <ol className="card-list" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {attempts.map(att => {
          const q = db.questions[att.subject_id];
          if (!q) return null;
          const judge = db.events.find(e => e.caused_by_event_id === att.id && e.action === 'judge');
          const childEvents = (childrenOf[att.id] || [])
            .concat(judge ? (childrenOf[judge.id] || []) : []);
          const aiChildren = childEvents.filter(e =>
            (e.action === 'generate' || e.action === 'propose') && e.actor_kind === 'agent'
          );
          const pendingSec = NOW - att.created_at;

          return (
            <li key={att.id} className="event-card">
              <header className="ec-head">
                <div>
                  <p className="prompt">{q.prompt_md}</p>
                </div>
                <div className="right">
                  <CauseBadge cause={judge?.payload?.cause} pendingSinceSec={!judge ? pendingSec : null} />
                  <Badge tone="neutral">FSRS · learning</Badge>
                </div>
              </header>

              <div className="ec-meta">
                <code>{att.id}</code>
                <span>·</span>
                <span>q={att.subject_id}</span>
                <span>·</span>
                <span>{relTime(att.created_at)}</span>
                {q.source && <><span>·</span><span>{q.source.doc} · {q.source.page}</span></>}
                <span className="spacer" />
                {q.knowledge_ids?.map(kid => (
                  <a key={kid} href="#knowledge" onClick={(e) => { e.preventDefault(); nav('knowledge'); }}>
                    #{db.knowledge.find(k => k.id === kid)?.name || kid}
                  </a>
                ))}
              </div>

              <div className="ec-attempt">
                <div className="lbl">你的答</div>
                <div className="you">{att.payload.answer_md}</div>
                <div className="lbl" style={{ marginTop: 4 }}>参考</div>
                <div className="ref">{q.reference_md}</div>
              </div>

              {judge && (
                <div className="ec-judge">
                  <div className="label">
                    <ActorBadge actorKind="agent" actorRef="attribution" compact />
                    <span>归因 · {judge.payload.cause.primary} ({Math.round(judge.payload.cause.confidence * 100)}%)</span>
                    <span style={{flex:1}} />
                    <span style={{opacity:0.7}}>{judge.task_run_id} · ${(judge.cost_micro_usd/1e6).toFixed(4)}</span>
                  </div>
                  <div className="body">{judge.payload.cause.ai_analysis_md}</div>
                  <EventChain eventId={judge.id} eventsById={byId} label="完整推理链" />
                </div>
              )}

              {aiChildren.length > 0 && (
                <div className="ec-children">
                  <div className="ec-children-head">
                    <span>AI 在 caused_by 链上提议了 {aiChildren.length} 条</span>
                    <span>· events WHERE caused_by_event_id IN ({att.id}, {judge?.id || '...'})</span>
                  </div>
                  {aiChildren.map(child => (
                    <ProposalCard
                      key={child.id}
                      event={child}
                      eventsById={byId}
                      status={proposalStatus[child.id]}
                      onAccept={(e) => setProposalStatus(s => ({ ...s, [e.id]: 'accept' }))}
                      onDismiss={(e) => setProposalStatus(s => ({ ...s, [e.id]: 'dismiss' }))}
                    />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </main>
  );
};

// ════════════════════════════════════════════════════════════
//   /review — FSRS rating + cause display + chain drill
// ════════════════════════════════════════════════════════════
const ReviewScreen = ({ db, nav }) => {
  const { byId } = useMemo(() => indexEvents(db.events), [db.events]);

  const queue = [
    { qid: 'q3', mistakeAtt: 'e_20' },
    { qid: 'q1', mistakeAtt: 'e_01' },
    { qid: 'q2', mistakeAtt: 'e_10' },
  ];
  const [idx, setIdx] = useState(0);
  const [showRef, setShowRef] = useState(false);
  const [answer, setAnswer] = useState('');

  const cur = queue[idx];
  const q = db.questions[cur.qid];
  const att = db.events.find(e => e.id === cur.mistakeAtt);
  const judge = att && db.events.find(e => e.caused_by_event_id === att.id && e.action === 'judge');

  const rate = (r) => {
    setAnswer('');
    setShowRef(false);
    setIdx(i => Math.min(queue.length - 1, i + 1));
  };

  return (
    <main className="page prose">
      <PageHeader
        eyebrow={`REVIEW · session=s_review_now · ${idx + 1} / ${queue.length}`}
        title="复习"
        sub="按下 1 / 2 / 3 写一条 action=review 事件，FSRS 状态投影表同事务更新。" />

      <section className="review-stage">
        <div className="progress">
          <span>{idx + 1} / {queue.length} · FSRS · {q.knowledge_ids[0]}</span>
          <span>last seen {att ? relTime(att.created_at) : '—'}</span>
        </div>

        <div className="qbody" dangerouslySetInnerHTML={{
          __html: q.prompt_md.replace(/「([^」]+)」/g, '<em>「$1」</em>')
        }} />

        {att && (
          <div style={{
            background: 'var(--paper-sunk)',
            borderRadius: 'var(--r-2)',
            padding: '10px 14px',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--ink-4)',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Icon name="alert" size={13} />
              <span style={{ whiteSpace: 'nowrap' }}>上次（{relTime(att.created_at)}）答错</span>
              <span style={{ flex: 1 }} />
              {judge && <CauseBadge cause={judge.payload.cause} />}
            </div>
            <div style={{ color: 'var(--again-ink)', fontFamily: 'var(--font-wenyan)', fontSize: 14, lineHeight: 1.55 }}>
              「{att.payload.answer_md}」
            </div>
          </div>
        )}

        <div className="lbl" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-4)', letterSpacing: '0.04em', marginTop: 8 }}>
          你的答案
        </div>
        <textarea
          placeholder="不看参考，先答……"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)} />

        <details className="ref-reveal" open={showRef} onToggle={(e) => setShowRef(e.target.open)}>
          <summary>参考答 ▾</summary>
          <div className="ref-text">{q.reference_md}</div>
        </details>

        {judge && (
          <>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-4)', letterSpacing: '0.04em' }}>
              上次归因 · 沿 caused_by_event_id
            </div>
            <EventChain eventId={judge.id} eventsById={byId} label="查看 AI 推理（3 events）" />
          </>
        )}

        <div className="rating-row">
          <button className="btn-rating again" onClick={() => rate('again')}>
            <span>不会</span>
            <kbd>1</kbd>
          </button>
          <button className="btn-rating hard" onClick={() => rate('hard')}>
            <span>模糊</span>
            <kbd>2</kbd>
          </button>
          <button className="btn-rating good" onClick={() => rate('good')}>
            <span>会了</span>
            <kbd>3</kbd>
          </button>
        </div>
      </section>

      {idx >= queue.length - 1 && (
        <p style={{ textAlign: 'center', color: 'var(--ink-4)', marginTop: 28, fontSize: 14 }}>
          今天没有要复习的，太好了。
        </p>
      )}
    </main>
  );
};

// ════════════════════════════════════════════════════════════
//   /record — 3-tab unified ingestion + SSE feed
//   ADR-0008 LearningSession(type='ingestion') · Sub 0c SSE
// ════════════════════════════════════════════════════════════
const RecordScreen = ({ db, nav }) => {
  const [tab, setTab] = useState('vision_paper');
  const ingestEvents = db.events
    .filter(e => e.session_id === 's_ingest_now')
    .sort((a, b) => a.created_at - b.created_at);

  const session = db.sessions.s_ingest_now;

  return (
    <main className="page">
      <PageHeader
        eyebrow="RECORD · session=s_ingest_now · LearningSession(type='ingestion')"
        title="录入"
        sub="同一 learning_session 包三种入口；extraction 是异步 job，进度走 SSE。"
        >
        <Button variant="ghost" icon="cog">设置</Button>
      </PageHeader>

      <div className="seg-row">
        <button className={`seg ${tab === 'manual' ? 'is-on' : ''}`} onClick={() => setTab('manual')}>手输</button>
        <button className={`seg ${tab === 'vision_single' ? 'is-on' : ''}`} onClick={() => setTab('vision_single')}>拍单题</button>
        <button className={`seg ${tab === 'vision_paper' ? 'is-on' : ''}`} onClick={() => setTab('vision_paper')}>拍试卷</button>
      </div>

      {tab === 'vision_paper' && (
        <>
          <div className="dropzone">
            <Icon name="upload" size={32} />
            <div style={{ fontSize: 15, color: 'var(--ink-2)', fontWeight: 500 }}>
              拖照片到此处 · 或 <a href="#">点这里上传</a>
            </div>
            <div className="hint">JPEG / PNG · 单次最多 20 页 · 走 Tencent Mark Agent（确定性 OCR）</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Button variant="secondary" icon="camera">用手机拍</Button>
              <Button variant="primary" icon="upload">浏览文件</Button>
            </div>
          </div>

          <div className="section">
            <h2>当前 session</h2>
            <div className="meta">id=s_ingest_now · status={session.status} · started {relTime(session.started_at)}</div>
          </div>

          {/* SSE progress feed — Sub 0c */}
          <section className="sse-feed">
            <div className="head">
              <h4>{session.title}</h4>
              <div className="conn">
                <span className="dot" />
                SSE · /api/ingestion/s_ingest_now/events
              </div>
            </div>
            <div className="sse-rows">
              {ingestEvents.map(ev => (
                <div key={ev.id} className={`sse-row ${ev.outcome === 'success' ? 'success' : ev.outcome === 'failure' ? 'fail' : ''}`}>
                  <span className="t">{new Date(ev.created_at * 1000).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                  <span className="msg">
                    <ActorBadge actorKind={ev.actor_kind} actorRef={ev.actor_ref} compact /> {' '}
                    {ev.action === 'import' && <>上传 <code>{ev.payload.filename}</code> ({(ev.payload.size_kb / 1024).toFixed(1)} MB)</>}
                    {ev.action === 'extract' && <>抽取完成 · layout=<code>{ev.payload.layout_quality}</code> · {ev.payload.structured_block_ids.length} blocks</>}
                  </span>
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-4)' }}>{ev.id}</code>
                </div>
              ))}
              <div className="sse-row">
                <span className="t">--:--:--</span>
                <span className="msg" style={{ color: 'var(--ink-4)' }}>
                  <Badge tone="hard" dot>SSE</Badge> 等待 judge / extract 后续事件…
                </span>
                <code style={{ color: 'var(--ink-5)' }}>...</code>
              </div>
            </div>
          </section>

          {/* layout_quality bad → rescue strip */}
          <div className="section">
            <h2>抽取质量</h2>
          </div>
          <div className="quality-strip">
            <Icon name="alert" size={22} />
            <div className="qtxt">
              <h5>layout_quality = partial · cloze 5 空但 sub 只检出 3 个</h5>
              <p>Tencent Mark Agent 在第 12 题（古文填空）切错——切空数 ≠ 实际题数。手动改 / Vision rescue 二选一。</p>
            </div>
            <div className="rescue">
              <Button variant="secondary" size="sm" icon="pen">手动改</Button>
              <Button variant="info" size="sm" icon="zap">Vision Tier 2 (haiku · $0.02)</Button>
              <Button variant="coral" size="sm" icon="brain">Vision Tier 3 (sonnet · $0.18)</Button>
            </div>
          </div>

          {/* extraction_evidence preview */}
          <div className="section">
            <h2>extraction_evidence · block #12</h2>
            <div className="meta">structured.source = tencent_ocr · evidence-only, 不作系统真相</div>
          </div>
          <div className="evidence-grid">
            <div className="evidence-card">
              <div className="head">handwriting · 用户错答</div>
              <div className="v">青取之于蓝<br/>而青于蓝</div>
            </div>
            <div className="evidence-card">
              <div className="head">tencent_grading · IsCorrect = false</div>
              <div className="v">RightAnswer：来源(从) / 比较(比)<br/>KnowledgePoints: 「于」用法</div>
            </div>
          </div>
        </>
      )}

      {tab === 'vision_single' && (
        <div className="dropzone">
          <Icon name="camera" size={32} />
          <div style={{ fontSize: 15, color: 'var(--ink-2)', fontWeight: 500 }}>
            拍一题就好。摄像头取景，按下大按钮直接送 Vision Tier 1。
          </div>
          <div className="hint">单题直接走 Vision；不经 Tencent Mark Agent</div>
          <Button variant="primary" icon="camera" style={{ marginTop: 12, padding: '14px 32px', fontSize: 16 }}>拍照</Button>
        </div>
      )}

      {tab === 'manual' && (
        <Card pad="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-2)', display: 'block', marginBottom: 6 }}>题面</label>
              <textarea
                style={{ width: '100%', minHeight: 80, border: '1px solid var(--line)', borderRadius: 'var(--r-2)', padding: '10px 12px', fontFamily: 'var(--font-wenyan)', fontSize: 15 }}
                placeholder="例：「之」在「古之学者必有师」中的用法是？" />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-2)', display: 'block', marginBottom: 6 }}>你的错答</label>
              <textarea
                style={{ width: '100%', minHeight: 60, border: '1px solid var(--line)', borderRadius: 'var(--r-2)', padding: '10px 12px', fontFamily: 'var(--font-wenyan)', fontSize: 15 }}
                placeholder="代词，指代「学者」。" />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-2)', display: 'block', marginBottom: 6 }}>参考</label>
              <textarea
                style={{ width: '100%', minHeight: 60, border: '1px solid var(--line)', borderRadius: 'var(--r-2)', padding: '10px 12px', fontFamily: 'var(--font-wenyan)', fontSize: 15 }}
                placeholder="结构助词，定语标志，相当于「的」。" />
            </div>
            <div className="row">
              <Button variant="primary" icon="plus">写入 event(action=attempt, outcome=failure)</Button>
              <Button variant="ghost">取消</Button>
            </div>
          </div>
        </Card>
      )}
    </main>
  );
};

// ════════════════════════════════════════════════════════════
//   /knowledge — tree + per-node AI activity + proposals
// ════════════════════════════════════════════════════════════
const KnowledgeScreen = ({ db, nav, proposalStatus, setProposalStatus }) => {
  const { byId } = useMemo(() => indexEvents(db.events), [db.events]);

  // For each knowledge node: count events whose subject is this node OR
  // whose payload references it
  const nodeActivity = useMemo(() => {
    const m = {};
    for (const ev of db.events) {
      const refs = new Set();
      if (ev.subject_kind === 'knowledge') refs.add(ev.subject_id);
      const refIds = ev.payload?.cause?.referenced_knowledge_ids ||
                     ev.payload?.referenced_knowledge_ids || [];
      refIds.forEach(id => refs.add(id));
      for (const id of refs) {
        m[id] ||= { recent: [] };
        m[id].recent.push(ev);
      }
    }
    return m;
  }, [db.events]);

  // Pending knowledge proposals
  const knowledgeProposals = db.events
    .filter(e => e.action === 'propose' && e.subject_kind === 'knowledge' && !proposalStatus[e.id]);
  const proposalsByParent = {};
  for (const p of knowledgeProposals) {
    const k = p.payload?.parent_id;
    (proposalsByParent[k] ||= []).push(p);
  }

  return (
    <main className="page wide">
      <PageHeader
        eyebrow="KNOWLEDGE · subject_kind=knowledge · 9 nodes"
        title="知识"
        sub="树视图。节点右侧是 AI 在此节点的最近活动；底色发红的节点有未审批的提议。">
        <Button variant="secondary" icon="search">搜索</Button>
        <Button variant="primary" icon="plus">新建节点</Button>
      </PageHeader>

      <div className="tree">
        {db.knowledge.filter(k => !k.proposed).map(k => {
          const acts = nodeActivity[k.id]?.recent || [];
          const hasProposal = !!proposalsByParent[k.id];
          return (
            <React.Fragment key={k.id}>
              <div className={`tree-node ${hasProposal ? 'has-proposal' : ''}`} data-depth={k.depth}>
                <div className="name">
                  <span className="indent" />
                  {k.depth > 0 && <span style={{ color: 'var(--ink-4)' }}>↳</span>}
                  <span>{k.name}</span>
                  <code style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--font-mono)', marginLeft: 4 }}>{k.id}</code>
                </div>
                <div className="activity">
                  {acts.length > 0 && <span>{acts.length} 事件</span>}
                  {acts.filter(e => e.actor_kind === 'agent').length > 0 && (
                    <ActorBadge actorKind="agent" compact />
                  )}
                </div>
                <div className="actions">
                  <Button variant="ghost" size="sm" icon="plus">新增子节点</Button>
                  <Button variant="ghost" size="sm" icon="chev" />
                </div>
              </div>
              {proposalsByParent[k.id]?.map(p => (
                <div className="tree-proposals" key={p.id}>
                  <div className="tprow">
                    <div className="left">
                      <ActorBadge actorKind="agent" actorRef={p.actor_ref} />
                      <span>提议加子节点：<b>{p.payload.name}</b></span>
                      <span className="meta">· {relTime(p.created_at)}</span>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <Button variant="good" size="sm" icon="check"
                        onClick={() => setProposalStatus(s => ({ ...s, [p.id]: 'accept' }))}>接受</Button>
                      <Button variant="ghost" size="sm" icon="x"
                        onClick={() => setProposalStatus(s => ({ ...s, [p.id]: 'dismiss' }))}>忽略</Button>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--ink-2)', paddingLeft: 22, lineHeight: 1.5 }}>
                    {p.payload.reasoning}
                  </div>
                  <div style={{ paddingLeft: 22 }}>
                    <EventChain eventId={p.id} eventsById={byId} label="为什么提议这个？" />
                  </div>
                </div>
              ))}
            </React.Fragment>
          );
        })}
      </div>

      <CostRibbon today={0.51} budget={5.0} />
    </main>
  );
};

// ════════════════════════════════════════════════════════════
//   /learning-items — parked TODO list, decoupled from event
// ════════════════════════════════════════════════════════════
const ItemsScreen = ({ db, nav, setDb }) => {
  const toggle = (id) => {
    setDb(d => ({
      ...d,
      items: d.items.map(it => it.id === id
        ? { ...it, status: it.status === 'done' ? 'pending' : 'done', completed_at: it.status === 'done' ? null : NOW }
        : it),
    }));
  };
  return (
    <main className="page prose">
      <PageHeader
        eyebrow="LEARNING ITEMS · table=learning_item (decoupled from event)"
        title="学习项"
        sub="用户 / AI 声明的学习意图（TODO / Goal 层）。与发生过的事件解耦——这一层 ADR-0006 v2 不动。">
        <Button variant="primary" icon="plus">新增学习项</Button>
      </PageHeader>

      <div className="li-list">
        {db.items.map(it => (
          <div className={`li ${it.status === 'done' ? 'done' : ''}`} key={it.id}>
            <span className="check" onClick={() => toggle(it.id)}>
              {it.status === 'done' && <Icon name="check" size={12} />}
            </span>
            <div>
              <div className="title">{it.title}</div>
              <div className="meta">
                {it.source === 'agent' ? <><ActorBadge actorKind="agent" actorRef={it.proposed_by} compact /> · </> : null}
                <span>{it.id}</span>
                <span> · v{it.version}</span>
                <span> · {relTime(it.created_at)}</span>
              </div>
            </div>
            <StatusBadge status={it.status} />
          </div>
        ))}
      </div>
    </main>
  );
};

// ════════════════════════════════════════════════════════════
//   /inbox — central proposal inbox (§6.2 alt route)
//   shown only when tweak.inbox = 'central-route'
// ════════════════════════════════════════════════════════════
const InboxScreen = ({ db, nav, proposalStatus, setProposalStatus }) => {
  const { byId } = useMemo(() => indexEvents(db.events), [db.events]);
  const proposals = db.events
    .filter(e =>
      ((e.action === 'propose') ||
       (e.action === 'generate' && e.actor_kind === 'agent')) &&
      !proposalStatus[e.id] &&
      e.created_at > NOW - DAY
    )
    .sort((a, b) => b.created_at - a.created_at);

  const totalCost = proposals.reduce((s, e) => s + (e.cost_micro_usd || 0), 0) / 1e6;

  return (
    <main className="page">
      <PageHeader
        eyebrow="INBOX · 24h · events action IN (propose, generate) · 未 rate"
        title="AI 提议收件箱"
        sub="集中决断。每一行你 accept / dismiss 一次，写入一条 action=rate 事件，下次不再露面。">
        <Button variant="ghost" onClick={() => nav('today')} icon="arrowL">回今日</Button>
        <Button variant="secondary">全部忽略</Button>
      </PageHeader>

      <div className="meta" style={{ marginBottom: 16, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink-4)' }}>
        {proposals.length} 条待审 · 累计成本 ${totalCost.toFixed(3)} · 大部分来自夜间 Dreaming session
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {proposals.length === 0 && (
          <div className="empty">
            <div className="big">收件箱空了</div>
            <div>下次夜间 Dreaming 在 03:00 跑。</div>
          </div>
        )}
        {proposals.map(ev => (
          <ProposalCard
            key={ev.id}
            event={ev}
            eventsById={byId}
            status={proposalStatus[ev.id]}
            onAccept={(e) => setProposalStatus(s => ({ ...s, [e.id]: 'accept' }))}
            onDismiss={(e) => setProposalStatus(s => ({ ...s, [e.id]: 'dismiss' }))}
          />
        ))}
      </div>
    </main>
  );
};

// ════════════════════════════════════════════════════════════
//   Copilot drawer — D-tier dialogue
//   ADR-0008 修订: type='conversation' session of events
// ════════════════════════════════════════════════════════════
const COPILOT_SCRIPT = [
  {
    actor: 'user',
    action: 'experimental:ask_copilot',
    text: '把"之"和"其"放一起对我考一下吧',
  },
  {
    actor: 'agent',
    action: 'experimental:explain',
    text: '好。我打三组判断题——每组两个句子，一个用"之"一个用"其"。你选哪个是助词、哪个是代词。\n\n准备好就说"开始"。',
    cost: 4100,
  },
  {
    actor: 'user',
    action: 'experimental:ask_copilot',
    text: '开始',
  },
  {
    actor: 'agent',
    action: 'generate',
    text: '第 1 组：A. 古之学者必有师　B. 其为人也孝悌',
    proposal: {
      title: '生成 · 5 题小测 · 之 vs 其',
      kind: 'quiz',
      body_md: '判断每句加点字是助词还是代词。共 5 组，每组 2 句。',
    },
    cost: 11200,
  },
];

const CopilotDrawer = ({ db, onClose, contextRoute, contextEntity, setProposalStatus }) => {
  const [feed, setFeed] = useState(() => db.copilotEvents);
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const [scriptIdx, setScriptIdx] = useState(0);
  const feedRef = useRef(null);
  const { byId } = useMemo(() => indexEvents(db.events.concat(feed)), [db.events, feed]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [feed, typing]);

  const sendUser = (text) => {
    const newEv = {
      id: `ec_u_${Date.now()}`, session_id: 's_copilot',
      actor_kind: 'user', actor_ref: 'self',
      action: 'experimental:ask_copilot',
      subject_kind: 'event', subject_id: contextEntity || 's_copilot',
      payload: { text },
      caused_by_event_id: contextEntity || null,
      created_at: Math.floor(Date.now() / 1000),
    };
    setFeed(f => [...f, newEv]);
    setDraft('');
    setTyping(true);
    // Try LLM, fall back to scripted reply
    runAgentReply(text);
  };

  const runAgentReply = async (userText) => {
    let reply = null;
    let proposal = null;
    let cost = 0;

    // Try Claude
    try {
      const systemPrompt = `你是 Loom 的 Copilot——一个文言文学习助手。回复保持简短（2-4 句），中文为主，技术性强、不寒暄、不用 emoji。Loom 的核心：用户做错题 → AI 归因 → 生成变式 / 笔记。当前上下文：${contextRoute || 'home'}，关联 ${contextEntity || '无'}。`;
      const promptMessages = [
        { role: 'user', content: `[历史对话:]\n${feed.slice(-4).map(e => {
          const who = e.actor_kind === 'user' ? '用户' : 'Copilot';
          const t = e.payload?.text || e.payload?.text_md || '';
          return `${who}: ${t}`;
        }).join('\n')}\n\n用户最新: ${userText}\n\n以 Copilot 身份回复。` }
      ];
      reply = await Promise.race([
        window.claude.complete({ messages: promptMessages, system: systemPrompt }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
      cost = 4200;
    } catch (err) {
      // Fall back to scripted next reply
      const script = COPILOT_SCRIPT[scriptIdx % COPILOT_SCRIPT.length];
      reply = script.text;
      proposal = script.proposal || null;
      cost = script.cost || 3800;
      setScriptIdx(i => i + 1);
    }

    await new Promise(r => setTimeout(r, 600));
    const replyEv = {
      id: `ec_a_${Date.now()}`, session_id: 's_copilot',
      actor_kind: 'agent', actor_ref: 'copilot',
      action: 'experimental:explain',
      subject_kind: 'event', subject_id: 's_copilot', outcome: 'success',
      payload: { text_md: reply },
      caused_by_event_id: feed.length ? feed[feed.length - 1].id : null,
      task_run_id: `t_c${Date.now() % 1000}`, cost_micro_usd: cost,
      created_at: Math.floor(Date.now() / 1000),
    };
    setFeed(f => [...f, replyEv]);

    if (proposal) {
      const propEv = {
        id: `ec_g_${Date.now() + 1}`, session_id: 's_copilot',
        actor_kind: 'agent', actor_ref: 'copilot',
        action: 'generate',
        subject_kind: 'artifact', subject_id: `a_gen_${Date.now()}`, outcome: 'success',
        payload: { artifact_kind: proposal.kind, title: proposal.title, body_md: proposal.body_md },
        caused_by_event_id: replyEv.id,
        task_run_id: `t_g${Date.now() % 1000}`, cost_micro_usd: 11800,
        created_at: Math.floor(Date.now() / 1000),
      };
      setFeed(f => [...f, propEv]);
    }
    setTyping(false);
  };

  const totalCost = feed.reduce((s, e) => s + (e.cost_micro_usd || 0), 0) / 1e6;

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <div className="title">
          <Icon name="bot" size={18} color="var(--coral)" />
          <h3>Copilot</h3>
        </div>
        {contextEntity && (
          <span className="context-chip" title={`context = ${contextEntity}`}>
            <Icon name="link" size={11} /> {contextEntity}
          </span>
        )}
        <Button variant="ghost" icon="x" onClick={onClose} aria-label="关闭" />
      </header>

      <div className="drawer-feed" ref={feedRef}>
        <div className="meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-4)', letterSpacing: '0.04em', textAlign: 'center' }}>
          ── learning_session(type='conversation', id=s_copilot) ──
        </div>
        {feed.map((ev) => {
          const isUser = ev.actor_kind === 'user';
          const text = ev.payload?.text || ev.payload?.text_md || '';
          const isProposal = ev.action === 'generate';
          return (
            <div className={`msg ${isUser ? 'user' : 'agent'}`} key={ev.id}>
              <div className="actor-line">
                <ActorBadge actorKind={ev.actor_kind} actorRef={ev.actor_ref} compact />
                <span>{ACTION_LABEL[ev.action] || ev.action}</span>
                {ev.cost_micro_usd && <span>· ${(ev.cost_micro_usd / 1e6).toFixed(4)}</span>}
              </div>
              {isProposal ? (
                <div className="msg-proposal">
                  <div className="head">AI · {ARTIFACT_LABEL_MAP[ev.payload.artifact_kind] || ev.payload.artifact_kind} · {ev.payload.title}</div>
                  <div className="body">{ev.payload.body_md}</div>
                  <div className="actions">
                    <Button variant="good" size="sm" icon="check" onClick={() => setProposalStatus(s => ({ ...s, [ev.id]: 'accept' }))}>接受</Button>
                    <Button variant="ghost" size="sm" icon="x" onClick={() => setProposalStatus(s => ({ ...s, [ev.id]: 'dismiss' }))}>忽略</Button>
                    <span style={{ flex: 1 }} />
                    <EventChain eventId={ev.id} eventsById={byId} label="推理" />
                  </div>
                </div>
              ) : (
                <div className="body" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
              )}
            </div>
          );
        })}
        {typing && (
          <div className="msg agent">
            <div className="actor-line">
              <ActorBadge actorKind="agent" actorRef="copilot" compact />
              <span>归因中...</span>
            </div>
            <div className="body drawer-typing">
              <span className="dot" />
              <span className="dot" style={{ animationDelay: '0.2s' }} />
              <span className="dot" style={{ animationDelay: '0.4s' }} />
            </div>
          </div>
        )}
      </div>

      <div className="drawer-suggestions">
        <button className="suggest-chip" onClick={() => sendUser('再讲一下"之"在主谓之间取消独立性的用法')}>再讲深一点</button>
        <button className="suggest-chip" onClick={() => sendUser('给我出一道类似的变式')}>出变式</button>
        <button className="suggest-chip" onClick={() => sendUser('把要点写成笔记收藏')}>收成笔记</button>
      </div>

      <div className="drawer-foot">
        <div className="composer">
          <textarea
            placeholder="问 Copilot（写一条 event(action=experimental:ask_copilot)）"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (draft.trim()) sendUser(draft);
              }
            }}
            rows={2} />
          <Button variant="primary" icon="send" onClick={() => draft.trim() && sendUser(draft)}>发送</Button>
        </div>
        <div className="cost-line">
          <span>session 累计 ${totalCost.toFixed(4)}</span>
          <span>{feed.length} events · {(typing ? 'judging' : 'idle')}</span>
        </div>
      </div>
    </aside>
  );
};

const ARTIFACT_LABEL_MAP = { variant: '变式', note: '笔记', quiz: '小测', summary: '总结' };

Object.assign(window, {
  TodayScreen, MistakesScreen, ReviewScreen, RecordScreen,
  KnowledgeScreen, ItemsScreen, InboxScreen, CopilotDrawer,
});
