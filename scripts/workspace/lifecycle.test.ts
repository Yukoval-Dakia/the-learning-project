import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { invokeWorkspace } from '../../src/capabilities/agent-workspace/server/executor';
import {
  type WorkspaceOwner,
  finalizeWorkspaceDeletion,
  readWorkspace,
  requestWorkspaceDeletion,
  withWorkspace,
} from '../../src/capabilities/agent-workspace/server/lifecycle';
import { volumeIdentity } from '../../src/capabilities/agent-workspace/server/storage';
import { sweepAgentWorkspaces } from '../../src/capabilities/agent-workspace/server/sweep';
import {
  createCopilotConversation,
  requestCopilotConversationDeletion,
} from '../../src/capabilities/copilot/server/conversation-lifecycle';
import { db } from '../../src/db/client';
import { agent_workspace, ai_task_runs, learning_session } from '../../src/db/schema';

after(() => db.$client.end());

const root = '/var/lib/tlp/workspaces';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // Let the claim commit and the exec start before the delete lands.
  await sleep(1500);
  assert.ok(execId);

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
