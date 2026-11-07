import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { piDomainMount } from '../../src/ai/pi-tool-mount';
import { agentWorkspaceCapability } from '../../src/capabilities/agent-workspace/manifest';
import { db } from '../../src/db/client';
import { tool_call_log } from '../../src/db/schema';
import { resolveDomainToolNames } from '../../src/kernel/tools/allowlists';
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
  console.log(JSON.stringify(result));
  assert.notEqual(result.isError, true);
  const logs = await db
    .select()
    .from(tool_call_log)
    .where(eq(tool_call_log.task_run_id, taskRunId));
  assert.equal(logs.length, 1);
  console.log('pg-evidence', JSON.stringify(logs));
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
  console.log('output-limit', JSON.stringify(bounded));
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
