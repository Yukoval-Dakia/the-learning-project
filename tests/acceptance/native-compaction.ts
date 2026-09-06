/** Bounded native SDK quality experiment, not production/queue E2E. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import type { CopilotRunInput } from '../../src/capabilities/copilot/server/copilot-run-input';
import {
  compileCopilotModelInput,
  compileCopilotSessionContext,
} from '../../src/capabilities/copilot/server/live-turn-context';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const offline = process.argv.includes('--offline');
const limitIndex = process.argv.indexOf('--cost-limit-usd');
const limit = limitIndex < 0 ? 0 : Number(process.argv[limitIndex + 1]);
if (!offline && (process.env.ACTUAL_PROVIDER_ACCEPTANCE !== '1' || !(limit > 0 && limit <= 2)))
  throw new Error('Explicit paid gate and --cost-limit-usd >0, <=2 required');
let key = '';
if (!offline) {
  const file = process.env.ACTUAL_PROVIDER_ENV_FILE;
  if (!file) throw new Error('Explicit credential file required');
  config({ path: file, override: false, quiet: true });
  key = process.env.XIAOMI_API_KEY ?? '';
  if (!key) throw new Error('XIAOMI_API_KEY absent');
}
const model = 'mimo-v2.5-pro';
const fixture = {
  alpha: {
    id: 'K-A17',
    subject: 'physics',
    mastery: 0.42,
    evidence_count: 7,
    provenance: 'quiz_verify:evt-8841',
  },
  beta: {
    id: 'K-B29',
    subject: 'history',
    mastery: 0,
    evidence_count: 0,
    provenance: 'import:evt-1120',
  },
  gamma: { id: 'K-C31', mastery: null, evidence_count: null },
  edge: { from: 'K-A17', to: 'K-B29', relation: 'analogy', confidence: 0.73 },
  alpha_to_gamma: 'unobserved',
  target: 73,
  observed: 68,
  delta: 5,
  active_ids: ['Q-19', 'Q-23'],
  pending_count: null,
  snapshot: 'snap-2031',
};
const expected = { ...fixture, approved: false, learner: 'L-UPDATED-92' };
let learner = 'L-ORIGINAL-17';
function input(user_message: string): CopilotRunInput {
  return {
    surface: 'copilot',
    triggered_by: 'chat',
    user_message,
    proposal_feedback: [],
    conversation_history: [],
    validator_context_history: [],
    learner_state_header: `Current learner token: ${learner}. Current token supersedes old tokens.`,
    correction_contract: {
      available_prior_turn_ids: [],
      prior_turn_summaries: {},
      required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
    },
  };
}
type Wire = {
  phase: string;
  bytes: number;
  input_sha256: string;
  output_sha256?: string;
  status?: number;
  usage: Record<string, number>;
  estimate_usd: number | null;
  reserve_usd: number;
  complete: boolean;
  updated_learner: boolean;
  original_fixture_verbatim: boolean;
  message_count: number;
};
const wires: Wire[] = [];
const events: Record<string, unknown>[] = [];
const outputs: Record<string, string> = {};
const prompts: Record<string, { text: string; sha256: string }> = {};
const controller = new AbortController();
const runId = `native_compact_acceptance_${randomUUID()}`;
const directory = mkdtempSync(resolve(tmpdir(), 'tlp-native-actual-'));
const exactHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const evidencePath = resolve('.tmp/native-compaction-actual', `${Date.now()}-${runId}.json`);
let phase = 'initial';
let sessionId: string | undefined;
let compactObserved = false;
let failure: string | undefined;
let accepted = false;
const reserved = () => wires.reduce((sum, row) => sum + row.reserve_usd, 0);
// Admission reserves all bytes as tokens +4096 overhead at $2/$4 per million,
// above official $0.435/$0.87. Failed calls retain full reserve. No retries/tools.
const server = createServer(async (request, response) => {
  try {
    if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 96_000) throw new Error('input byte ceiling');
    }
    const body = JSON.parse(raw);
    if (body.model !== model || (body.tools?.length ?? 0) !== 0 || !body.stream)
      throw new Error('unexpected model/tools/transport');
    if (wires.length >= 5) throw new Error('five-request ceiling');
    body.max_tokens = Math.min(body.max_tokens ?? 8192, 8192);
    const encoded = JSON.stringify(body);
    const bytes = Buffer.byteLength(encoded);
    const reserve = offline ? 0 : ((bytes + 4096) * 2 + 8192 * 4) / 1_000_000;
    if (!offline && reserved() + reserve > limit) throw new Error('campaign reserve exhausted');
    const row: Wire = {
      phase,
      bytes,
      input_sha256: sha(encoded),
      usage: {},
      estimate_usd: null,
      reserve_usd: reserve,
      complete: false,
      updated_learner: encoded.includes('L-UPDATED-92'),
      original_fixture_verbatim: encoded.includes(
        JSON.stringify(JSON.stringify(fixture)).slice(1, -1),
      ),
      message_count: body.messages.length,
    };
    wires.push(row);
    let fullText = '';
    const inspect = (data: Record<string, unknown>) => {
      const message = data.message as { usage?: Record<string, number> } | undefined;
      const usage = message?.usage ?? data.usage;
      if (usage && typeof usage === 'object') Object.assign(row.usage, usage);
      const delta = data.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta') fullText += delta.text ?? '';
      if (data.type === 'message_stop') row.complete = true;
    };
    if (offline) {
      const text =
        phase === 'recall'
          ? JSON.stringify(expected)
          : phase === 'compact'
            ? `Synthetic summary: ${JSON.stringify(expected)}`
            : 'ACK';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type: string, data: Record<string, unknown>) => {
        const event = { type, ...data };
        inspect(event);
        response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      emit('message_start', {
        message: {
          id: `msg_${wires.length}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1000, output_tokens: 0 },
        },
      });
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 100 },
      });
      emit('message_stop', {});
      row.status = 200;
    } else {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      };
      if (typeof request.headers['anthropic-beta'] === 'string')
        headers['anthropic-beta'] = request.headers['anthropic-beta'];
      const upstream = await fetch(`https://api.xiaomimimo.com/anthropic${request.url}`, {
        method: 'POST',
        headers,
        body: encoded,
        signal: controller.signal,
      });
      row.status = upstream.status;
      if (!upstream.ok || !upstream.body) throw new Error(`provider HTTP ${upstream.status}`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let pending = '';
      const decoder = new TextDecoder();
      for await (const chunk of upstream.body) {
        response.write(chunk);
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line.startsWith('data: ') && line !== 'data: [DONE]')
            inspect(JSON.parse(line.slice(6)));
          newline = pending.indexOf('\n');
        }
      }
    }
    row.output_sha256 = sha(fullText);
    const usage = row.usage;
    if (row.complete && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens))
      row.estimate_usd = offline
        ? 0
        : (usage.input_tokens * 0.435 +
            usage.output_tokens * 0.87 +
            (usage.cache_read_input_tokens ?? 0) * 0.0036) /
          1_000_000;
    response.end();
  } catch (error) {
    failure = error instanceof Error ? error.message : 'proxy failure';
    controller.abort();
    response.destroy();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('missing loopback address');
const env: Record<string, string | undefined> = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  ANTHROPIC_API_KEY: 'loopback-only-not-provider-key',
  ANTHROPIC_AUTH_TOKEN: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CONFIG_DIR: directory,
  CLAUDE_CODE_MAX_RETRIES: '0',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
};
for (const name of [
  'XIAOMI_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AWS',
])
  delete env[name];
const options: Options = {
  model,
  cwd: directory,
  title: 'native-compaction-fact-retention',
  env,
  systemPrompt:
    'You are a careful learning assistant. Preserve facts, corrections, unknowns and provenance. Do not infer mastery or approval. Follow the requested shape. No tools are available.',
  settingSources: [],
  tools: [],
  persistSession: true,
  maxTurns: 2,
  canUseTool: async () => ({ behavior: 'deny', message: 'No tools in this acceptance probe' }),
  settings: { autoCompactEnabled: true, precomputeCompactionEnabled: false },
  abortController: controller,
  hooks: {
    SessionStart: [
      {
        hooks: [
          async (hook) => {
            if (hook.hook_event_name !== 'SessionStart' || hook.source !== 'compact') return {};
            events.push({ phase, hook: 'SessionStart', source: 'compact', learner });
            return {
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: compileCopilotSessionContext(input('')),
              },
            };
          },
        ],
      },
    ],
  },
};
async function turn(name: string, prompt: string): Promise<void> {
  phase = name;
  prompts[name] = { text: prompt, sha256: sha(prompt) };
  const stream = query({
    prompt,
    options: { ...options, ...(sessionId ? { resume: sessionId } : {}) },
  });
  const timer = setTimeout(() => controller.abort(), 90_000);
  let success = false;
  try {
    for await (const message of stream) {
      if (sessionId && message.session_id !== sessionId)
        throw new Error('session identity changed');
      sessionId ??= message.session_id;
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        compactObserved = true;
        const meta = message.compact_metadata;
        events.push({
          phase,
          type: 'compact_boundary',
          trigger: meta.trigger,
          pre_tokens: meta.pre_tokens,
          post_tokens: meta.post_tokens,
        });
      }
      if (message.type === 'result') {
        success = message.subtype === 'success';
        if (success && 'result' in message) outputs[name] = message.result;
        events.push({
          phase,
          type: 'result',
          subtype: message.subtype,
          session_id: message.session_id,
          sdk_reported_cost_usd: message.total_cost_usd,
        });
      }
    }
    if (!success || failure) throw new Error(failure ?? `${name}: no successful terminal`);
    if (wires.some((wire) => wire.estimate_usd === null))
      throw new Error('unknown usage; refuse next phase');
  } finally {
    clearTimeout(timer);
    stream.close();
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
try {
  await turn(
    'initial',
    `${compileCopilotSessionContext(input(''))}\nHold this synthetic study record for later. Unknown is not zero; an unobserved relation is not a proven impossibility. Acknowledge only.\n${JSON.stringify(fixture)}`,
  );
  await turn(
    'correction',
    'Correction: the proposed plan is NOT approved; approved=false. The original study snapshot is unchanged. Acknowledge only.',
  );
  await turn(
    'context',
    'We will later compare evidence and learning priorities. Do not create facts, merge subjects, change the snapshot or assume missing values. Acknowledge only.',
  );
  learner = 'L-UPDATED-92';
  await turn(
    'compact',
    '/compact Preserve the original study records, exact IDs and numbers, provenance, relation direction, unknown versus zero and later approval correction.',
  );
  if (!compactObserved) throw new Error('no native compact boundary');
  // Only current learner is reintroduced; none of the old facts tested are resent.
  await turn(
    'recall',
    compileCopilotModelInput(
      input(
        'Recall the original snapshot and correction. Return only JSON keys alpha (id,subject,mastery,evidence_count,provenance), beta (same), gamma (id,mastery,evidence_count), edge (from,to,relation,confidence), alpha_to_gamma ("unobserved" if no evidence), target, observed, delta, active_ids, pending_count, snapshot, approved, learner (current learner token). Keep unknown quantities null.',
      ),
      'resume',
    ),
  );
  const actual = JSON.parse(
    outputs.recall
      ?.replace(/^```(?:json)?\s*/u, '')
      .replace(/\s*```$/u, '')
      .trim() ?? '',
  );
  for (const [name, value] of Object.entries(expected))
    if (canonical(actual[name]) !== canonical(value)) throw new Error(`fact mismatch: ${name}`);
  if (!wires.at(-1)?.updated_learner) throw new Error('current learner missing from resumed wire');
  if (!events.some((event) => event.hook === 'SessionStart' && event.source === 'compact'))
    throw new Error('compact reinjection hook not observed');
  accepted = true;
} catch (error) {
  failure ??= error instanceof Error ? error.message : 'acceptance failure';
} finally {
  controller.abort();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  mkdirSync(resolve(evidencePath, '..'), { recursive: true });
  const estimated = wires.some((row) => row.estimate_usd === null)
    ? null
    : wires.reduce((sum, row) => sum + (row.estimate_usd ?? 0), 0);
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        accepted,
        failure,
        offline,
        run_id: runId,
        exact_head: exactHead,
        harness_sha256: sha(readFileSync(new URL(import.meta.url), 'utf8')),
        sdk_version: '0.3.220',
        model,
        session_id: sessionId,
        cost_limit_usd: offline ? 0 : limit,
        reserved_usd: reserved(),
        estimated_usd: estimated,
        price_basis: 'official public USD rates checked2026-09-06; estimate, not account invoice',
        price_source: 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go',
        fixture,
        expected,
        prompts,
        outputs,
        events,
        wires,
        limitations: [
          'Direct SDK plus product context codec; not Hono/PG/queue E2E.',
          'Manual compact tests summary quality, not automatic threshold or net savings.',
          'No raw thinking archived; SDK session persists in isolated temporary config.',
        ],
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify({
      accepted,
      failure,
      offline,
      evidence_path: evidencePath,
      estimated_usd: estimated,
      reserved_usd: reserved(),
      requests: wires.length,
    }),
  );
  if (!accepted) process.exitCode = 1;
}
