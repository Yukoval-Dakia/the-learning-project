import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { agentLoop } from '@earendil-works/pi-agent-core';
import { and, eq } from 'drizzle-orm';
import { piDomainMount } from '../../src/ai/pi-tool-mount';
import { agentWorkspaceCapability } from '../../src/capabilities/agent-workspace/manifest';
import { invokeWorkspace } from '../../src/capabilities/agent-workspace/server/executor';
import { resolveModelExecutionProvenance } from '../../src/capabilities/practice/grading/server/judge/execution-provenance-resolve';
import { collectJudgeSandboxEvidence } from '../../src/capabilities/practice/grading/server/judge/sandbox-evidence';
import { currentModelPins } from '../../src/capabilities/practice/grading/server/model-slice-registry';
import { tasks } from '../../src/capabilities/task-registry';
import { setTestConfig } from '../../src/core/config/store';
import { canonicalHash } from '../../src/core/migration/canonical';
import { db } from '../../src/db/client';
import { agent_workspace, ai_task_runs, tool_call_log } from '../../src/db/schema';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
} from '../../src/kernel/tools/allowlists';
import { __setPiAdapterForTests } from '../../src/server/ai/execution-adapter';
import { PiAgentAdapter } from '../../src/server/ai/pi-agent-adapter';
import { createLoomPiModels } from '../../src/server/ai/pi-models';
import { streamTaskCollecting } from '../../src/server/ai/runner';
import { specToolSurface } from '../../src/server/ai/runner-startup';
import { buildPiDomainAgentTools } from '../../src/server/ai/tools/pi-tools';
import { registerCapabilityTools } from '../../src/server/ai/tools/register-capability-tools';

after(() => db.$client.end());

// @invariant security: real mounted scripts cannot read worker credentials after the identity switch.
// @fails-if the launcher retains worker identity or inherited privileges and exposes either synthetic canary.
test('mounted workspace denies worker credentials and records remaining OS access', async () => {
  assert.equal(process.env.WORKSPACE_BOUNDARY_DEV, '1');
  assert.match(await readFile('/proc/1/environ', 'utf8'), /WORKSPACE_SYNTHETIC_CANARY/);
  assert.equal(
    await readFile('/var/lib/tlp/chatgpt-auth/canary', 'utf8'),
    'WORKSPACE_SYNTHETIC_CANARY',
  );
  await registerCapabilityTools([agentWorkspaceCapability]);
  const taskRunId = randomUUID();
  const mount = piDomainMount({
    ctx: { db, taskRunId, callerActor: { kind: 'system', ref: 'workspace-acceptance' } },
    serverName: 'workspace_acceptance',
    toolNames: resolveDomainToolNames('workspace_acceptance'),
  });
  assert.equal(mount.type, 'domain');
  if (mount.type !== 'domain') throw new Error('domain_mount_required');
  const [tool] = buildPiDomainAgentTools(mount.options);
  const result = await tool.execute(
    randomUUID(),
    {
      runtime: 'python',
      code: `
import os,json,socket,struct,sys
runtime={'python':sys.version,'kernel':os.uname().release}
r={'uid':os.getuid(),'gid':os.getgid(),'groups':os.getgroups(),'environment':dict(os.environ),'runtime':runtime}
r['privileges']=[s.strip() for s in open('/proc/self/status') if s.startswith(('CapEff:', 'CapPrm:', 'CapInh:', 'CapAmb:', 'NoNewPrivs:'))]
for name,path in [('proc','/proc/1/environ'),('login','/var/lib/tlp/chatgpt-auth/canary'),('outside','/etc/os-release')]:
 try:
  with open(path,'rb') as f: data=f.read(4096)
  r[name]={'read':True,'canary':b'WORKSPACE_SYNTHETIC_CANARY' in data}
 except OSError as e: r[name]={'read':False,'errno':e.errno}
try:
 s=socket.create_connection(('sandbox-pg',5432),3); s.sendall(struct.pack('!II',8,80877103)); r['db']=repr(s.recv(1)); s.close()
except OSError as e: r['db']=str(e)
try:
 s=socket.create_connection(('sandbox-internal',8080),3); s.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n'); r['internal']=repr(s.recv(100)); s.close()
except OSError as e: r['internal']=str(e)
try: r['enumeration']=os.listdir('/var/lib/tlp/workspaces')
except OSError as e: r['enumeration']={'errno':e.errno}
pid=os.fork()
if pid==0: os._exit(0)
os.waitpid(pid,0); r['fork']=True
try:
 with open('disk-probe','wb') as f:
  for _ in range(65): f.write(b'x'*(1024*1024))
 r['disk']='65MiB written'
except OSError as e: r['disk']={'errno':e.errno,'bytes':os.stat('disk-probe').st_size}
with open('second-probe','wb') as f: f.write(b'x'*(1024*1024))
r['session_bytes']=sum(os.stat(p).st_size for p in os.listdir('.'))
print(json.dumps(r))
`,
    },
    new AbortController().signal,
  );
  console.log('probe', JSON.stringify(result).length);
  assert.notEqual(result.isError, true);
  const logs = await db
    .select()
    .from(tool_call_log)
    .where(eq(tool_call_log.task_run_id, taskRunId));
  assert.equal(logs.length, 1);
  console.log('pg-evidence', logs.length);
  const output = logs[0].output_json;
  assert.ok(output && typeof output === 'object' && 'output' in output);
  assert.equal(typeof output.output, 'string');
  const probe = JSON.parse(String(output.output));
  assert.equal(probe.uid, 29082);
  assert.equal(probe.gid, 29082);
  assert.deepEqual(probe.groups, []);
  assert.equal(probe.environment.DATABASE_URL, undefined);
  assert.equal(JSON.stringify(probe.environment).includes('WORKSPACE_SYNTHETIC_CANARY'), false);
  assert.equal(probe.proc.read, false);
  assert.equal(probe.login.read, false);
  for (const field of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']) {
    assert.ok(probe.privileges.includes(`${field}:\t0000000000000000`));
  }
  assert.ok(probe.privileges.includes('NoNewPrivs:\t1'));
  await assert.rejects(stat(probe.environment.HOME), { code: 'ENOENT' });
  const bash = await tool.execute(
    randomUUID(),
    { runtime: 'bash', code: 'id -u; printf bash_ok' },
    new AbortController().signal,
  );
  console.log('bash', JSON.stringify(bash).length);
  assert.notEqual(bash.isError, true);
  assert.match(JSON.stringify(bash.content), /29082/);
  const bounded = await tool.execute(
    randomUUID(),
    { runtime: 'python', code: "while True: print('x'*4096, flush=True)" },
    new AbortController().signal,
  );
  console.log('output-limit', JSON.stringify(bounded).length);
  assert.match(JSON.stringify(bounded.content), /output_limit/);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const cancelled = await tool.execute(
      randomUUID(),
      { runtime: 'bash', code: 'sleep 600 & wait' },
      controller.signal,
    );
    console.log('cancelled', JSON.stringify(cancelled).length);
    assert.match(JSON.stringify(cancelled.content), /cancelled/);
  } finally {
    clearTimeout(timer);
  }
});

async function runningTaskRow(id: string) {
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
}

function boundWorkspaceTools(logicalKey: string, runId: string) {
  const mount = piDomainMount({
    ctx: {
      db,
      taskRunId: logicalKey,
      callerActor: { kind: 'agent', ref: 'agent:workspace-boundary' },
    },
    serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
    toolNames: ['workspace_exec', 'workspace_files'],
    logTaskRunId: runId,
  });
  if (mount.type !== 'domain') throw new Error('domain_mount_required');
  return buildPiDomainAgentTools(mount.options);
}

// @invariant security: workspace ownership is server-bound — a model-supplied
//   owner field is stripped by the input schema and can never select another
//   run's directory; two bound owners cannot see each other's files.
// @fails-if caller/model-supplied owner arguments reach the claim, or a bound
//   call lands anywhere but its own bound directory.
test('bound workspace ignores model owner args and isolates owners', async () => {
  await registerCapabilityTools([agentWorkspaceCapability]);
  const runA = randomUUID();
  const runB = randomUUID();
  await runningTaskRow(runA);
  await runningTaskRow(runB);
  const [execA] = boundWorkspaceTools('logical-a', runA);
  const [execB, filesB] = boundWorkspaceTools('logical-b', runB);

  const wrote = await execA.execute(
    randomUUID(),
    {
      runtime: 'bash',
      code: 'printf a-marker > marker.txt && printf wrote',
      // Foreign owner field the model might invent; must never reach the claim.
      owner: { kind: 'task', id: 'logical-b' },
    },
    new AbortController().signal,
  );
  assert.notEqual(wrote.isError, true);
  const logsA = await db
    .select()
    .from(tool_call_log)
    .where(and(eq(tool_call_log.task_run_id, runA), eq(tool_call_log.tool_name, 'workspace_exec')));
  assert.equal(logsA.length, 1);
  const workspaceA = String((logsA[0].output_json as { workspace: string }).workspace);
  assert.match(workspaceA, /^[a-f0-9]{64}$/);
  assert.equal((await invokeWorkspace('bash', workspaceA, 'cat marker.txt')).output, 'a-marker');

  // B reads the same name in its own bound directory: nothing there.
  const miss = await execB.execute(
    randomUUID(),
    { runtime: 'bash', code: 'cat marker.txt', owner: { kind: 'task', id: 'logical-a' } },
    new AbortController().signal,
  );
  assert.notEqual(miss.isError, true);
  assert.match(JSON.stringify(miss.content), /No such file|cannot access/);

  const listed = await filesB.execute(
    randomUUID(),
    { action: 'list', path: 'sub/dir' },
    new AbortController().signal,
  );
  assert.equal(listed.isError, true, 'list on missing path must fail');
  const roundtrip = await filesB.execute(
    randomUUID(),
    { action: 'write', path: 'sub/dir/note.txt', content: 'b-note' },
    new AbortController().signal,
  );
  assert.notEqual(roundtrip.isError, true);
  const readBack = await filesB.execute(
    randomUUID(),
    { action: 'read', path: 'sub/dir/note.txt' },
    new AbortController().signal,
  );
  assert.notEqual(readBack.isError, true);
  assert.match(JSON.stringify(readBack.content), /b-note/);
  const escaped = await filesB.execute(
    randomUUID(),
    { action: 'read', path: `../${workspaceA}/marker.txt` },
    new AbortController().signal,
  );
  assert.equal(escaped.isError, true, 'path escape must be rejected');

  // A claim bound to a finished run is refused and logged once.
  await db
    .update(ai_task_runs)
    .set({ status: 'failed', finished_at: new Date() })
    .where(eq(ai_task_runs.id, runB));
  const closed = await execB.execute(
    randomUUID(),
    { runtime: 'bash', code: 'printf should-not-run' },
    new AbortController().signal,
  );
  assert.equal(closed.isError, true);
  const logsB = await db
    .select()
    .from(tool_call_log)
    .where(and(eq(tool_call_log.task_run_id, runB), eq(tool_call_log.tool_name, 'workspace_exec')));
  const rejections = logsB.filter((row) => /workspace_owner_closed/.test(row.error_reason ?? ''));
  assert.equal(rejections.length, 1);
});

// @invariant security: through the real runner + adapter + mount pipeline the
//   model receives the workspace tools, every exec lands in the directory
//   bound to the run's own claim, and the exec output is what the model reads
//   next — the provider is the only swapped piece.
// @fails-if the wire lacks the workspace tools, no agent_workspace row is
//   bound to the run, the claimed directory differs from the tool output, or
//   the next request carries a submit reminder instead of the exec output.
test('runner packaging mounts workspace tools into the live loop', async () => {
  await registerCapabilityTools([agentWorkspaceCapability]);
  const submitted = JSON.stringify({
    scoring_unit_id: 'u',
    status: 'solved',
    answer: { kind: 'blank_text', accepted: ['2'] },
    equivalent_forms: [],
    typical_wrong: [],
  });
  let sends = 0;
  let toolsOnWire: string[] = [];
  let secondRequestToolMessages: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      sends += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        tools?: { function?: { name?: string } }[];
        messages?: { role?: string }[];
      };
      toolsOnWire = (body.tools ?? [])
        .map((tool) => tool.function?.name)
        .filter((name): name is string => typeof name === 'string');
      if (sends === 2)
        secondRequestToolMessages = (body.messages ?? []).filter((m) => m.role === 'tool');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const call =
        sends === 1
          ? {
              name: 'mcp__loom__workspace_exec',
              arguments: JSON.stringify({
                runtime: 'python',
                code: "open('solve_notes.txt','w').write('s1-marker');print('noted')",
              }),
            }
          : { name: 'mcp__structured_output__submit', arguments: submitted };
      response.write(
        `data: ${JSON.stringify({
          id: 'offline',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${sends}`,
                    type: 'function',
                    function: call,
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })}\n\ndata: [DONE]\n\n`,
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  try {
    const models = await createLoomPiModels();
    const model = models.getModel('opencode-go', 'deepseek-v4.1-flash');
    if (!model) throw new Error('offline protocol model unavailable');
    const port = address.port;
    const original = models.getModel.bind(models);
    models.getModel = (provider: string, modelId: string) => {
      const resolved = original(provider, modelId);
      if (!resolved) return resolved;
      return { ...resolved, baseUrl: `http://127.0.0.1:${port}/v1` };
    };
    __setPiAdapterForTests(new PiAgentAdapter({ models, agentLoop }));
    process.env.OPENCODE_API_KEY = 'synthetic-offline-key';
    setTestConfig({
      'lane.global.provider': 'opencode-go',
      'lane.global.model': 'deepseek-v4.1-flash',
      CLAUDE_CODE_MAX_RETRIES: 0,
    });
    const result = await streamTaskCollecting(
      'QuestionAdmissionSolveTask',
      {
        mode: 'solve',
        parts: [{ part_id: 'p', prompt_md: '1+1=?' }],
        units: [
          {
            scoring_unit_id: 'u',
            part_id: 'p',
            kind: 'blank',
            printed_points: null,
            blank: { format: 'text' },
          },
        ],
      },
      { db },
      () => {},
    );
    assert.ok(toolsOnWire.includes('mcp__loom__workspace_exec'), 'workspace_exec missing on wire');
    assert.ok(
      toolsOnWire.includes('mcp__loom__workspace_files'),
      'workspace_files missing on wire',
    );
    const rows = await db.select().from(agent_workspace);
    const bound = rows.find((row) => row.claim_run_id === result.task_run_id);
    assert.ok(bound, 'no workspace bound to this run');
    assert.equal(bound.owner_kind, 'task');
    const marker = await invokeWorkspace('bash', bound.id, 'cat solve_notes.txt');
    assert.equal(marker.output, 's1-marker');
    const nextToolContext = JSON.stringify(secondRequestToolMessages);
    assert.match(nextToolContext, /noted/, 'exec output missing from the next model request');
    assert.doesNotMatch(nextToolContext, /You finished without the required tool call/);
    const logs = await db
      .select()
      .from(tool_call_log)
      .where(
        and(
          eq(tool_call_log.task_run_id, result.task_run_id),
          eq(tool_call_log.tool_name, 'workspace_exec'),
        ),
      );
    assert.equal(logs.length, 1);
    const out = logs[0].output_json as {
      workspace: string;
      code_sha256: string;
      output_sha256: string;
      runtime_version?: { python: string; bash: string };
    };
    assert.equal(out.workspace, bound.id);
    assert.match(out.code_sha256, /^[a-f0-9]{64}$/);
    assert.match(out.output_sha256, /^[a-f0-9]{64}$/);
    assert.ok(out.runtime_version?.python, 'runtime version evidence missing');
  } finally {
    __setPiAdapterForTests(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// @invariant grading: a maxIterations:1 judge kind mounted with the
//   sandbox completes a workspace call plus its final answer under the shared
//   turn margin, and the receipt material the invoker stamps (per-call digests,
//   runtime, tool_call_ids) is collectable from the run's tool log. The slice
//   identity must also bind the mounted surface so a tool change re-admits.
// @fails-if the run dies on error_max_turns, the projected sandbox evidence
//   lacks the call's digests/runtime, or model_version does not hash the surface.
test('maxIterations:1 judge uses the sandbox once and the receipt is collectable', async () => {
  await registerCapabilityTools([agentWorkspaceCapability]);
  const verdict = JSON.stringify({
    score: 1,
    coarse_outcome: 'correct',
    confidence: 0.9,
    feedback_md: 'ok',
    evidence_json: { matched_points: ['p'], missing_points: [] },
  });
  let sends = 0;
  let toolsOnWire: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      sends += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        tools?: { function?: { name?: string } }[];
      };
      toolsOnWire = (body.tools ?? [])
        .map((tool) => tool.function?.name)
        .filter((name): name is string => typeof name === 'string');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta =
        sends === 1
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'mcp__loom__workspace_exec',
                    arguments: JSON.stringify({
                      runtime: 'python',
                      code: "print(sum(int(x) for x in open('scores.txt','w') or '3'))",
                    }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: verdict };
      response.write(
        `data: ${JSON.stringify({
          id: 'offline',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta,
              finish_reason: sends === 1 ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })}\n\ndata: [DONE]\n\n`,
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  try {
    const models = await createLoomPiModels();
    const model = models.getModel('opencode-go', 'deepseek-v4.1-flash');
    if (!model) throw new Error('offline protocol model unavailable');
    const port = address.port;
    const original = models.getModel.bind(models);
    models.getModel = (provider: string, modelId: string) => {
      const resolved = original(provider, modelId);
      if (!resolved) return resolved;
      return { ...resolved, baseUrl: `http://127.0.0.1:${port}/v1` };
    };
    __setPiAdapterForTests(new PiAgentAdapter({ models, agentLoop }));
    process.env.OPENCODE_API_KEY = 'synthetic-offline-key';
    setTestConfig({
      'lane.global.provider': 'opencode-go',
      'lane.global.model': 'deepseek-v4.1-flash',
      CLAUDE_CODE_MAX_RETRIES: 0,
    });
    const result = await streamTaskCollecting(
      'SemanticJudgeTask',
      { answer: 'x', rubric_json: { required_points: ['p'] } },
      { db },
      () => {},
    );
    assert.ok(toolsOnWire.includes('mcp__loom__workspace_exec'), 'workspace_exec missing on wire');
    assert.equal(sends, 2, 'judge should have made exactly one sandbox turn plus its answer');
    // The invoker stamps this projection verbatim into execution.sandbox — the
    // receipt check below is the same shape the judging run carries.
    const evidence = await collectJudgeSandboxEvidence(db, result.task_run_id);
    assert.ok(evidence, 'sandbox evidence missing for a run that called workspace_exec');
    assert.equal(evidence.tool_call_ids.length, 1);
    const call = evidence.calls[0];
    assert.equal(call.tool_name, 'workspace_exec');
    assert.match(call.code_sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.match(call.output_sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.ok(call.runtime_version?.python, 'runtime version evidence missing');
    // The sealed provenance carries the receipt next to the run identity —
    // resolveModelExecutionProvenance copies it verbatim, never corroborates it.
    const sealed = resolveModelExecutionProvenance(
      {
        task_kind: 'SemanticJudgeTask',
        task_run_id: result.task_run_id,
        input_hash: 'a'.repeat(64),
        prompt_fingerprint: 'b'.repeat(64),
        prompt_template_revision: 'rev',
        sandbox: evidence,
      },
      'invoked',
      {
        id: result.task_run_id,
        task_kind: 'SemanticJudgeTask',
        input_hash: 'a'.repeat(64),
        provider: 'p',
        model: 'm',
        status: 'success',
        finished_at: new Date(),
        prompt_fingerprint: 'b'.repeat(64),
        result_digest: 'c'.repeat(64),
      },
    );
    assert.equal(sealed.kind, 'invoked');
    const sealedSandbox = sealed.kind === 'invoked' ? sealed.sandbox : undefined;
    assert.equal(sealedSandbox?.tool_call_ids[0], evidence.tool_call_ids[0]);
    assert.equal(sealedSandbox?.calls[0]?.code_sha256, evidence.calls[0]?.code_sha256);
    // Surface descriptor: chat kinds mount the pair; the typed lane mounts none.
    assert.deepEqual(specToolSurface('SemanticJudgeTask'), [
      'mcp__loom__workspace_exec',
      'mcp__loom__workspace_files',
    ]);
    assert.deepEqual(specToolSurface('JevScoringDecisionTask'), []);
    // Slice identity binds the surface: the live pin's model_version must hash
    // {prompt, toolSurface} with the same descriptor the injection uses.
    const definition = tasks.AssessmentRuleJudgeTask;
    const expectedHash = canonicalHash({
      prompt: definition.prompt,
      toolSurface: specToolSurface('AssessmentRuleJudgeTask'),
    });
    const pin = currentModelPins().get('AssessmentRuleJudgeTask');
    assert.ok(pin, 'AssessmentRuleJudgeTask pin did not resolve');
    assert.ok(
      pin.model_version.includes(expectedHash),
      `model_version ${pin.model_version} does not carry the surface hash`,
    );
  } finally {
    __setPiAdapterForTests(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
