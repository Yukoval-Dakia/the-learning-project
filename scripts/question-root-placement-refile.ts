// Root-placement refile operator entry — runs the same scan/mover the
// `question_root_placement_refile` cron job runs, against the resolved local
// dev database (TEST targets refuse before any connection opens).
//
// CLI:
//   pnpm tsx scripts/question-root-placement-refile.ts          # dry-run report, zero writes
//   pnpm tsx scripts/question-root-placement-refile.ts --json   # machine JSON for the report
//   pnpm tsx scripts/question-root-placement-refile.ts --apply  # write the unique-match moves

import { config } from 'dotenv';
import { guardLocalDbTarget, localDatabaseUrl } from './local-db-env';

config({ path: '.env', override: false });

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--apply') ? 'apply' : 'report';
  const asJson = argv.includes('--json');

  const target = guardLocalDbTarget('question-root-placement-refile');
  process.env.DATABASE_URL = localDatabaseUrl(target);

  const { db } = await import('@/db/client');
  const { getConfigFlag } = await import('@/core/config/store');
  const { hydrateConfigFromDb } = await import('@/server/config/hydrate');
  const { runRootPlacementRefile } = await import(
    '@/capabilities/practice/question-bank/server/root-placement-refile'
  );

  // --apply honours the same flag as the cron wrapper: hydrate first so the
  // DB-managed value is what the check sees (same order as worker startup).
  await hydrateConfigFromDb(db);
  if (mode === 'apply' && !getConfigFlag('QUESTION_ROOT_PLACEMENT_REFILE_ENABLED')) {
    console.error(
      '[root_placement_refile] --apply refused: QUESTION_ROOT_PLACEMENT_REFILE_ENABLED is off',
    );
    return 2;
  }

  const report = await runRootPlacementRefile(db, mode);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[root_placement_refile] target ${target.host}:${target.port}/${target.database}`);
    console.log(
      `[root_placement_refile] mode=${report.mode} scanned=${report.scanned} truncated=${report.truncated}`,
    );
    console.log(`[root_placement_refile] counts=${JSON.stringify(report.counts)}`);
    for (const row of report.rows) {
      console.log(
        `  ${row.status}\t${row.question_id}\t${JSON.stringify(row.learner_topic)}\t-> ` +
          `${row.matched_node_ids.join(',') || '-'}${row.detail ? `\t(${row.detail})` : ''}`,
      );
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[question-root-placement-refile] failed:', err);
    process.exit(1);
  });
