import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { buildMemoryEventIngestHandler } from '../../src/capabilities/agency/server/memory/triggers';
import { invokeWorkspace } from '../../src/capabilities/agent-workspace/server/executor';
import {
  type WorkspaceOwner,
  finalizeWorkspaceDeletion,
  readWorkspace,
  requestWorkspaceDeletion,
  withWorkspace,
} from '../../src/capabilities/agent-workspace/server/lifecycle';
import {
  poolBytes,
  runtimeIdentity,
  volumeIdentity,
  workspaceBytes,
} from '../../src/capabilities/agent-workspace/server/storage';
import { sweepAgentWorkspaces } from '../../src/capabilities/agent-workspace/server/sweep';
import {
  createCopilotConversation,
  markCopilotConversationDeleted,
  requestCopilotConversationDeletion,
} from '../../src/capabilities/copilot/server/conversation-lifecycle';
import { settleCopilotRunIfSessionDeleted } from '../../src/capabilities/copilot/server/copilot-run-settlement';
import { COPILOT_RUN_TABLE } from '../../src/capabilities/copilot/server/copilot-run-status';
import { reserveCopilotDurableAcceptance } from '../../src/capabilities/copilot/server/durable-dispatch';
import { installCopilotJobStreamGate } from '../../src/capabilities/copilot/server/stream-gate';
import { db } from '../../src/db/client';
import {
  agent_workspace,
  ai_task_runs,
  learning_session,
  tool_operation,
} from '../../src/db/schema';
import { jobStreamGate } from '../../src/kernel/job-event-stream';

after(() => db.$client.end());

const root = '/var/lib/tlp/workspaces';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error('wait_for_timeout');
}

async function liveConversation(): Promise<string> {
  const { sessionId } = await createCopilotConversation(db);
  return sessionId;
}

async function expiredConversation(): Promise<string> {
  const sessionId = await liveConversation();
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await db
    .update(learning_session)
    .set({ created_at: old, started_at: old })
    .where(eq(learning_session.id, sessionId));
  return sessionId;
}

async function writeMarker(owner: WorkspaceOwner, marker: string): Promise<string> {
  return withWorkspace(db, owner, 'write', async (id) => {
    const result = await invokeWorkspace(
      'bash',
      id,
      `printf %s '${marker}' > marker.txt && printf ok`,
    );
    assert.equal(result.exitCode, 0, result.output);
    return id;
  });
}

async function markerContent(id: string): Promise<string> {
  const result = await invokeWorkspace('bash', id, 'cat marker.txt 2>/dev/null || printf GONE');
  return result.output.trim();
}

async function dirExists(id: string): Promise<boolean> {
  return stat(`${root}/${id}`).then(
    () => true,
    () => false,
  );
}

const triggers = [
  {
    name: 'conversation hard delete',
    owner: async (): Promise<WorkspaceOwner> => {
      const id = await liveConversation();
      return { kind: 'conversation', id };
    },
    fire: async (owner: WorkspaceOwner) => {
      const result = await requestCopilotConversationDeletion(db, owner.id);
      assert.equal(result.status, 'deleted');
      await sweepAgentWorkspaces(db);
    },
  },
  {
    name: 'conversation 30-day expiry',
    owner: async (): Promise<WorkspaceOwner> => {
      const id = await expiredConversation();
      return { kind: 'conversation', id };
    },
    fire: async () => {
      await sweepAgentWorkspaces(db);
    },
  },
  {
    name: 'completed background task',
    owner: async (): Promise<WorkspaceOwner> => {
      const id = `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await db.insert(ai_task_runs).values({
        id,
        task_kind: 'workspace_acceptance',
        provider: 'test',
        model: 'test',
        input_hash: 'x',
        status: 'running',
        started_at: new Date(),
        usage_json: { inputTokens: 0, outputTokens: 0 },
      });
      return { kind: 'task', id };
    },
    fire: async (owner: WorkspaceOwner) => {
      await db
        .update(ai_task_runs)
        .set({ status: 'failed', finished_at: new Date() })
        .where(eq(ai_task_runs.id, owner.id));
      await sweepAgentWorkspaces(db);
    },
  },
];

for (const variant of triggers) {
  // @invariant data: a committed delete removes only its owner's bound
  //   directory; a live owner's workspace and files survive every trigger.
  // @fails-if the delete path resolves a directory by anything except the
  //   row's bound id, the sweep revokes a live owner on a stale fact, or
  //   tombstone/FS ordering lets one owner's delete cascade into another's
  //   files.
  test(`deleted workspace never touches a live owner's files (${variant.name})`, async () => {
    const doomed = await variant.owner();
    const doomedId = await writeMarker(doomed, 'doomed');
    const liveOwner: WorkspaceOwner = { kind: 'conversation', id: await liveConversation() };
    const liveId = await writeMarker(liveOwner, 'alive');
    assert.notEqual(doomedId, liveId);

    await variant.fire(doomed);
    await finalizeWorkspaceDeletion(db, doomed);
    await sweepAgentWorkspaces(db);

    const doomedRow = await readWorkspace(db, doomed);
    assert.equal(doomedRow, null);
    assert.equal(await dirExists(doomedId), false);

    const liveRow = await readWorkspace(db, liveOwner);
    assert.equal(liveRow?.state, 'active');
    assert.equal(await dirExists(liveId), true);
    assert.equal(await markerContent(liveId), 'alive');
  });
}

// @invariant concurrency: a delete committed while an execution holds the
//   lease revokes that execution and only removes the directory after the
//   claim drains; the filesystem is never deleted underneath a running process.
// @fails-if finalize removes the directory while the claimant runtime is alive,
//   the claim watchdog fails to abort a revoked execution, or the holder's
//   release CAS can clear another claim's token.
test('delete racing an in-flight execution revokes first, deletes after drain', async () => {
  const owner: WorkspaceOwner = { kind: 'conversation', id: await liveConversation() };
  let execId = '';
  const exec = withWorkspace(db, owner, 'write', async (id, signal) => {
    execId = id;
    return invokeWorkspace(
      'bash',
      id,
      'printf started > marker.txt; sleep 30; printf survived >> marker.txt',
      signal,
    );
  });
  // Wait on the real signal — the claim committed and the bash payload
  // actually started — before the delete lands, never on a fixed clock.
  await waitFor(async () => execId !== '');
  await waitFor(async () => (await markerContent(execId)) === 'started');

  const ownerConv = owner.id;
  const result = await requestCopilotConversationDeletion(db, ownerConv);
  assert.equal(result.status, 'deleted');
  await requestWorkspaceDeletion(db, owner, 'deleted');

  // The claimant (this process) is still alive: finalize must fail closed and
  // leave the row visible, not remove the directory mid-flight.
  const pending = await finalizeWorkspaceDeletion(db, owner);
  assert.equal(pending?.state, 'revoking');
  assert.match(pending?.last_error ?? '', /workspace_execution_not_drained/);
  assert.equal(await dirExists(execId), true);

  const execResult = await exec;
  assert.equal(execResult.stopped, true);
  assert.equal(execResult.stopReason, 'cancelled');

  const done = await finalizeWorkspaceDeletion(db, owner);
  assert.equal(done?.state ?? 'deleted', 'deleted');
  assert.equal(await dirExists(execId), false);
});

// @invariant data: a delete whose filesystem outcome is unprovable stays
//   tombstoned with a durable error instead of guessing, and retry converges
//   it once the volume truth is visible again.
// @fails-if finalize deletes a row whose bound volume is absent, clears
//   last_error before the directory is actually gone, or marks deleted without
//   a real removal.
test('failed or unverifiable delete stays visible and retryable', async () => {
  const owner: WorkspaceOwner = { kind: 'conversation', id: await liveConversation() };
  const id = await writeMarker(owner, 'victim');
  await requestCopilotConversationDeletion(db, owner.id);
  await requestWorkspaceDeletion(db, owner, 'deleted');

  // Bind the row to a foreign volume: removal on this volume cannot prove the
  // directory is the bound one, so the row must stay tombstoned, not deleted.
  await db
    .update(agent_workspace)
    .set({ volume_id: 'f'.repeat(64) })
    .where(eq(agent_workspace.id, id));
  const blocked = await finalizeWorkspaceDeletion(db, owner);
  assert.equal(blocked?.state, 'tombstoned');
  assert.match(blocked?.last_error ?? '', /workspace_remote_volume/);
  assert.equal(await dirExists(id), true);

  await db
    .update(agent_workspace)
    .set({ volume_id: await volumeIdentity() })
    .where(eq(agent_workspace.id, id));
  const done = await finalizeWorkspaceDeletion(db, owner);
  assert.equal(done?.state ?? 'deleted', 'deleted');
  assert.equal(done?.last_error ?? null, null);
  assert.equal(await dirExists(id), false);
});

const staleClaims = [
  {
    name: 'expired lease under a foreign hostname',
    runtime: () => Promise.resolve('otherhost:foreign-boot:1:1'),
    leaseMs: -1000,
    expect: 'reclaim' as const,
  },
  {
    name: 'lost release on this host, expired lease',
    // Same host+pid alive but the renewal stopped — the release CAS never
    // landed and the holder can no longer renew; expiry is the reclaim proof.
    runtime: () => runtimeIdentity(),
    leaseMs: -1000,
    expect: 'reclaim' as const,
  },
  {
    name: 'live lease under a foreign hostname',
    // Hostname alone proves nothing: while the lease is still renewed the
    // claim stays held, so this host must fail closed instead of stealing it.
    runtime: () => Promise.resolve('otherhost:foreign-boot:1:1'),
    leaseMs: 60_000,
    expect: 'busy' as const,
  },
];

for (const variant of staleClaims) {
  // @invariant concurrency: a claim outlives its holder only while its
  //   heartbeat lease is renewed; reclaim requires a death proof or lease
  //   expiry, never a hostname guess.
  // @fails-if reclaim keys on runtime hostname, a live lease is stolen, or a
  //   stale token with no reclaim path wedges the workspace forever.
  test(`stale claim reclaims only on proof (${variant.name})`, async () => {
    const owner: WorkspaceOwner = { kind: 'conversation', id: await liveConversation() };
    const id = await writeMarker(owner, 'claimed');
    await db
      .update(agent_workspace)
      .set({
        execution_token: 'stale',
        execution_runtime: await variant.runtime(),
        execution_lease_until: new Date(Date.now() + variant.leaseMs),
      })
      .where(eq(agent_workspace.id, id));

    if (variant.expect === 'busy') {
      await assert.rejects(
        withWorkspace(db, owner, 'write', async () => 'unreachable'),
        /workspace_busy/,
      );
      return;
    }
    const recovered = await withWorkspace(db, owner, 'write', async (dirId) => {
      assert.equal(dirId, id);
      return markerContent(dirId);
    });
    assert.equal(recovered, 'claimed');
  });
}

// @invariant concurrency: a conversation delete racing run admission either
//   admits the run before the revoke commit (it is then cancelled and settled)
//   or rejects it at the queue-lock gate — no run is left unsettleable.
// @fails-if reserve writes acceptance evidence on a deleting session, the
//   tombstone commits while a run is still open, or pickup executes a run
//   behind the tombstone instead of settling it.
test('conversation delete settles admitted runs and rejects new sends', async () => {
  const sessionA = await liveConversation();
  const accepted = await reserveCopilotDurableAcceptance(db, {
    sessionId: sessionA,
    userMessage: 'queued before the delete',
    inputHash: `h-${sessionA}`,
    queuedPayload: { session_id: sessionA },
  });
  assert.equal(accepted.outcome, 'created');
  const runId = accepted.acceptance.runId;

  // A tool operation the run owns is still running: the revoke can only
  // request cancellation, so the conversation stays `deleting` — the
  // tombstone must not commit while work is in flight.
  const opId = `op-${runId}`;
  await db.insert(tool_operation).values({
    id: opId,
    session_id: sessionA,
    task_run_id: `copilot_run_tool_${runId}`,
    tool_name: 'workspace_exec',
    effect: 'write',
    status: 'running',
    process_id: 'boundary-suite',
    input_hash: 'a'.repeat(64),
    input_json: {},
    lease_expires_at: new Date(Date.now() + 60_000),
  });
  const deleting = await requestCopilotConversationDeletion(db, sessionA);
  assert.equal(deleting.status, 'deleting');
  assert.equal(await markCopilotConversationDeleted(db, sessionA), false);

  // The in-flight operation drains; the worker pickup gate settles the run
  // through the shared pre-start terminal — only then may the tombstone commit.
  await db
    .update(tool_operation)
    .set({ status: 'succeeded', settled_at: new Date() })
    .where(eq(tool_operation.id, opId));
  const gate = await settleCopilotRunIfSessionDeleted(db, runId, sessionA);
  assert.equal(gate.outcome, 'deleted');
  assert.equal(await markCopilotConversationDeleted(db, sessionA), true);

  // A send arriving after the revoke commit is rejected at the queue-lock
  // gate — it can never produce an unsettleable run.
  const sessionB = await liveConversation();
  const deleted = await requestCopilotConversationDeletion(db, sessionB);
  assert.equal(deleted.status, 'deleted');
  await assert.rejects(
    reserveCopilotDurableAcceptance(db, {
      sessionId: sessionB,
      userMessage: 'sent after the delete',
      inputHash: `h-${sessionB}`,
      queuedPayload: { session_id: sessionB },
    }),
    /deleted/i,
  );
});

installCopilotJobStreamGate();

const revokedSurfaces = [
  {
    name: 'job-events SSE replay channel',
    check: async (_sessionId: string, runId: string, deleted: boolean) => {
      const gate = jobStreamGate(COPILOT_RUN_TABLE);
      assert.ok(gate);
      assert.equal(await gate(db, runId), !deleted);
    },
  },
  {
    name: 'memory extraction ingest',
    check: async (_sessionId: string, runId: string, deleted: boolean) => {
      let reached = false;
      const spy = {
        findByEventId: async () => ({ results: [] }),
        addEventMemoryOnce: async (
          _row: unknown,
          _ctx: unknown,
          beforeProviderAdd?: () => Promise<void>,
        ) => {
          reached = true;
          await beforeProviderAdd?.();
          return { result: { results: [] }, resolution: 'provider_result' as const };
        },
      };
      const handler = buildMemoryEventIngestHandler(
        db,
        { send: async () => null },
        {
          memoryClient: spy as never,
        },
      );
      await handler([{ data: { event_id: runId } }]);
      assert.equal(reached, !deleted);
    },
  },
];

for (const surface of revokedSurfaces) {
  // @invariant security: every read/derive surface of a deleted conversation
  //   revokes at the same durable boundary — a channel that served a live
  //   session denies it after the tombstone, and queued ingest never reaches
  //   the provider.
  // @fails-if replay admits a run id whose session is deleting, ingest loads
  //   a tombstoned event, or a live control no longer reaches the surface.
  test(`deleted conversation revokes its surface (${surface.name})`, async () => {
    const sessionId = await liveConversation();
    const accepted = await reserveCopilotDurableAcceptance(db, {
      sessionId,
      userMessage: 'surface control event',
      inputHash: `h-${sessionId}-${surface.name}`,
      queuedPayload: { session_id: sessionId },
    });
    assert.equal(accepted.outcome, 'created');
    const runId = accepted.acceptance.runId;

    await surface.check(sessionId, runId, false);
    const deleting = await requestCopilotConversationDeletion(db, sessionId);
    if (deleting.status === 'deleting') {
      await settleCopilotRunIfSessionDeleted(db, runId, sessionId);
      await markCopilotConversationDeleted(db, sessionId);
    }
    await surface.check(sessionId, runId, true);
  });
}

const damages = [
  {
    name: 'chmod 0 on the workspace root',
    damage: 'chmod 0 .',
    after: async (id: string) => {
      assert.equal(typeof (await workspaceBytes(id)), 'number');
    },
  },
  {
    name: 'chmod 0 on a nested directory',
    damage: 'mkdir -p a/b/c && printf deep > a/b/c/d.txt && chmod 0 a/b/c',
    after: async (id: string) => {
      assert.equal(typeof (await workspaceBytes(id)), 'number');
    },
  },
  {
    name: 'a tree deeper than a recursive walker descends',
    damage:
      'p=.; i=0; while [ $i -lt 1500 ]; do p=$p/x; i=$((i+1)); done; mkdir -p "$p" && printf deep > "$p"/f.txt',
    after: async (id: string) => {
      assert.equal(typeof (await workspaceBytes(id)), 'number');
    },
  },
  {
    name: 'planted junk at the pool root',
    damage: 'printf junk > ../junk_ws_test && printf x > ../zz_noexist_hex',
    after: async () => {
      const pool = await poolBytes();
      assert.ok(pool.anomalies.includes('junk_ws_test'));
      assert.ok(pool.anomalies.includes('zz_noexist_hex'));
      const { unlink } = await import('node:fs/promises');
      await unlink(`${root}/junk_ws_test`);
      await unlink(`${root}/zz_noexist_hex`);
    },
  },
];

for (const variant of damages) {
  // @invariant security: one owner's filesystem damage is isolated to that
  //   owner — accounting self-heals permission damage, deletion still
  //   converges, and a planted or undescendable entry can never wedge pool
  //   quota or a tombstone for everyone else.
  // @fails-if a damaged workspace makes poolBytes fail closed, the sweep
  //   throws on one bad row, or removal cannot finish on a healed tree.
  test(`sandbox damage stays isolated (${variant.name})`, async () => {
    const owner: WorkspaceOwner = { kind: 'conversation', id: await liveConversation() };
    const doomedId = await writeMarker(owner, 'doomed');
    const liveOwner: WorkspaceOwner = { kind: 'conversation', id: await liveConversation() };
    const liveId = await writeMarker(liveOwner, 'alive');

    const damaged = await invokeWorkspace('bash', doomedId, variant.damage);
    assert.equal(damaged.exitCode, 0, damaged.output);
    await variant.after(doomedId);

    await requestCopilotConversationDeletion(db, owner.id);
    await requestWorkspaceDeletion(db, owner, 'deleted');
    const done = await finalizeWorkspaceDeletion(db, owner);
    assert.equal(done?.state ?? 'deleted', 'deleted');
    assert.equal(await dirExists(doomedId), false);

    // The pool and the other owner are untouched by the damage.
    await sweepAgentWorkspaces(db);
    assert.equal(await dirExists(liveId), true);
    assert.equal(await markerContent(liveId), 'alive');
  });
}
