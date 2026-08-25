#!/usr/bin/env node
// YUK-917 Green Bridge Phase 2 - prove a real headless Chromium launch on the
// runner image before any scenario runs. Prints exactly one JSON probe record
// (consumed by scripts/ci/usability-lane.mjs) and exits non-zero when the
// launch fails, so missing OS dependencies (the Build #1 libnspr4.so class)
// surface as a machine-readable failure instead of 13 blind scenario errors.
import { chromium } from '@playwright/test';

async function main() {
  const record = {
    schema_version: 1,
    launched: false,
    browser: 'chromium',
    version: null,
    headless: true,
    error: null,
  };
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    record.version = browser.version();
    record.launched = true;
  } catch (error) {
    record.error = String(error?.message ?? error).slice(0, 300);
  } finally {
    await browser?.close().catch(() => {});
  }
  process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exitCode = record.launched ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`usability-probe: unexpected failure: ${String(error)}\n`);
  process.exit(1);
});
