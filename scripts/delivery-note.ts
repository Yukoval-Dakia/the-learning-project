// Delivery note generator — turns `delivery-evidence` output into (a) a PLAN.md NOW-stanza
// skeleton and (b) a .remember/ handoff draft, so session closeout stops being hand-assembled.
//
// The stanza is a DRAFT: TODO markers are intentional — the agent/owner fills the delivery
// summary, review verdict, paid/deploy declarations. Evidence lines are machine-collected,
// not re-typed by hand.
//
// CLI:
//   pnpm delivery:note --issue=YUK-987 [--pr=1379] [--out=.remember/custom.md]
//   (writes .remember/delivery-<YYYY-MM-DD>-<issue>.md and prints the stanza)

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDeliveryEvidence, formatEvidence } from './delivery-evidence';

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : null;
}

export function buildStanza(
  ev: Awaited<ReturnType<typeof collectDeliveryEvidence>>,
  issue: string,
  pr: string | null,
): string {
  const f = ev.fields;
  const prPart = pr ? `PR${pr} ` : '';
  const ciPart = f.gateRunId
    ? `CI#${f.gateRunId} ${f.gateConclusion}`
    : `CI<TODO ${f.gateConclusion ?? '无 run'}>`;
  const c = f.counts;
  const counts = c
    ? `event${c.event}/task${c.task}/attempt${c.attempt}/queue${c.queueActive}` +
      `${c.queueFailed > 0 ? `(+failed${c.queueFailed})` : ''}`
    : 'db计数<TODO 未采到>';
  const mig =
    f.migrationsApplied !== null
      ? `migrate applied${f.migrationsApplied}/files${f.migrationFiles}` +
        `${f.migrationsApplied === f.migrationFiles ? '零漂移' : 'DRIFT'}`
      : 'migrate<TODO 未采到>';
  const app = f.appImageTag ?? '<TODO>';
  const worker =
    f.workerImageTag && f.workerImageTag !== f.appImageTag ? `/${f.workerImageTag}` : '';

  return [
    `- ${issue} Done：<TODO 一句话交付内容>（${prPart}exact${f.shortSha ?? '<sha>'} ${ciPart}；初审<TODO>）。`,
    '  <TODO 机制/范围一行>',
    `  证据${ev.collectedAt.slice(0, 10)}：app${app ? `=${app}` : ''}${worker} <healthy|TODO>；` +
      `${counts}；${mig}；golden ${f.goldenSummary}；crons ${f.cronNames.length}。`,
    '  <TODO paid/部署范围/Linear 状态>',
  ].join('\n');
}

async function main() {
  const issue = arg('issue');
  const pr = arg('pr');
  if (!issue || !/^YUK-\d+$/i.test(issue)) {
    console.error('[delivery-note] --issue=YUK-NN required (e.g. --issue=YUK-987)');
    process.exit(2);
  }
  const ev = await collectDeliveryEvidence();
  const stanza = buildStanza(ev, issue.toUpperCase(), pr);

  const date = ev.collectedAt.slice(0, 10);
  const out = arg('out') ?? `.remember/delivery-${date}-${issue.toLowerCase()}.md`;
  const anomalies = ev.checks.filter((c) => c.level === 'warn' || c.level === 'fail');
  const handoff = `# delivery handoff — ${issue.toUpperCase()} — ${date}

auto-collected ${ev.collectedAt} by \`pnpm delivery:note\`. Read-only evidence; verify TODOs before pasting.

## evidence block

\`\`\`
${formatEvidence(ev)}
\`\`\`

## PLAN stanza draft (NOW 栏就地改写)

\`\`\`
${stanza}
\`\`\`

## anomalies to explain in the stanza (not to hide)

${anomalies.length > 0 ? anomalies.map((a) => `- ${a.level}: ${a.label} — ${a.detail}`).join('\n') : '- none'}

## closeout checklist

- [ ] PLAN.md NOW 就地改写（stanza 粘贴 + 过期叙事滚存 .remember/）
- [ ] Linear ${issue.toUpperCase()} 状态对齐（Done / 留 In Progress 须写明缺什么）
- [ ] PR review threads 回复/resolve；跳过项写 rationale，不冒充已修
- [ ] 部署状态写明：Mac 生产 SHA / 未部署 / NAS 不动
- [ ] 新发现 actionable follow-up 已查重并登记 Linear
- [ ] paid/预算消耗按实记录，未知不填 0
`;

  mkdirSync(resolve('.remember'), { recursive: true });
  writeFileSync(out, handoff);
  console.log(stanza);
  console.log(`\nhandoff draft → ${out}`);
  if (ev.checks.some((c) => c.level === 'fail')) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
