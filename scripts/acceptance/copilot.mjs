import { join } from 'node:path';
import { emptyIdentity } from './day-one.mjs';
import { ROOT, api, pause, readJson, report, save, sha, sql, success } from './lib.mjs';

export async function copilot(ctx, crisis = false) {
  const set = await readJson(join(ROOT, 'copilot.json'));
  const tasks = crisis ? set.crisis : set.tasks;
  if (!ctx.live)
    return report(
      ctx,
      crisis ? 'crisis' : 'copilot',
      {},
      {
        dry_run: true,
        task_ids: tasks.map((t) => t.id),
        paid: false,
        rubric: 'rubric.json; all scores remain null until human/LLM-judge review',
        isolation: crisis
          ? 'Fresh dedicated synthetic TEST database, dedicated sessions, mandatory separate cleanup'
          : 'Dedicated TEST with imported gold and documented synthetic history',
        guard: { max_tool_rounds: crisis ? 4 : 20, max_turn_ms: 180000 },
      },
    );
  if (crisis) await emptyIdentity(ctx);
  const sessions = {};
  const rows = [];
  await save(ctx.out, 'cleanup-required.json', {
    required: crisis,
    status: crisis ? 'PENDING' : 'not_crisis',
    database: ctx.config.deployment.database,
  });
  for (const t of tasks) {
    if (!sessions[t.session]) {
      const created = success(await api(ctx, 'POST', '/api/copilot/sessions'));
      sessions[t.session] = created.session.id;
      ctx.sessions.push(created.session.id);
      await save(ctx.out, 'sessions.json', ctx.sessions);
    }
    const sid = sessions[t.session];
    const started = performance.now();
    const accepted = success(
      await api(
        ctx,
        'POST',
        '/api/copilot/chat',
        { session_id: sid, user_message: t.prompt, triggered_by: 'chat', durable: true },
        { headers: { 'Idempotency-Key': `${ctx.id}-${t.id}` } },
      ),
    );
    const row = {
      id: t.id,
      session_id: sid,
      run_id: accepted.run_id,
      prompt: t.prompt,
      input_digest: sha(t.prompt),
      output: null,
      output_digest: null,
      scores: null,
      audit_scores: t.audit_scores ?? null,
      status: 'accepted',
      tool_rounds: 0,
    };
    rows.push(row);
    await save(ctx.out, 'copilot-progress.json', rows);
    while (performance.now() - started < 180000) {
      const snapshot = success(
        await api(ctx, 'GET', `/api/copilot/turns?session_id=${sid}&limit=100`),
      );
      const reply = snapshot.turns.find((x) => x.role === 'ai' && x.run_id === accepted.run_id);
      const rounds = await sql(
        ctx,
        'select coalesce(max(iteration)+1,0) as n from tool_call_log where task_run_id=$1',
        [`copilot_run_tool_${accepted.run_id}`],
      );
      row.tool_rounds = Number(rounds[0].n);
      if (reply) {
        Object.assign(row, {
          output: reply,
          output_digest: sha(reply),
          ms: performance.now() - started,
          status: 'reply_delivered',
        });
        break;
      }
      const active = snapshot.active_runs.some((x) => x.run_id === accepted.run_id);
      if (!active) {
        row.status = 'ended_without_reply';
        break;
      }
      if (row.tool_rounds > (crisis ? 4 : 20)) {
        row.status = 'guard_limit';
        break;
      }
      await pause(1000);
    }
    if (row.status === 'accepted' || row.status === 'guard_limit') {
      row.cancel = await api(ctx, 'POST', `/api/copilot/runs/${accepted.run_id}/cancel`, {});
      row.status = 'guard_cancel_requested';
    }
    row.ms ??= performance.now() - started;
    await save(ctx.out, 'copilot-progress.json', rows);
    // Do not enqueue followups behind an unsettled cancelled turn.
    if (row.status !== 'reply_delivered') break;
  }
  const rubric = await readJson(join(ROOT, 'rubric.json'));
  await save(ctx.out, 'scoring-sheet.json', {
    run_id: ctx.id,
    judge: null,
    rubric_version: rubric.version,
    rows: tasks.map((t) => ({
      id: t.id,
      scores: Object.fromEntries(
        (crisis ? rubric.crisis_dimensions : rubric.dimensions).map((d) => [d.id, null]),
      ),
      evidence: [],
      rationale: null,
      audit_scores: t.audit_scores ?? null,
    })),
    wording_pass_fail: false,
  });
  await report(
    ctx,
    crisis ? 'crisis' : 'copilot',
    {
      copilot_replies: crisis ? null : rows.filter((r) => r.status === 'reply_delivered').length,
      crisis_replies: crisis ? rows.filter((r) => r.status === 'reply_delivered').length : null,
    },
    {
      rows,
      skipped: tasks.filter((t) => !rows.some((r) => r.id === t.id)).map((t) => t.id),
      cleanup: crisis
        ? 'REQUIRED; run cleanup after worker tail is quiesced under deployment mutex'
        : null,
      semantic_verdict: 'UNSCORED',
    },
  );
  if (crisis)
    await save(ctx.out, 'cleanup-required.json', {
      required: true,
      status: 'PENDING',
      database: ctx.config.deployment.database,
      sessions: ctx.sessions,
      started: ctx.started,
    });
}
