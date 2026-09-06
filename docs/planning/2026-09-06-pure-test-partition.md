# Pure-test partition closeout — YUK-962

Five existing test files now execute without a database. The three kernel files
were renamed to the established `.unit.test.ts` convention with identical bytes;
the two server/ai files use the existing fast include list. Three stale include
paths pointing to absent pre-migration files were removed. No assertions were
deleted and no production module was changed just to make a test easier to run.

## Evidence

- Base db5a57b1, implementation23932d8c/bf59af8d; independent initial review PASS.
- Without database/provider-key environment values, 5 files / 59 scoped unit tests pass.
- The DB configuration collects zero tests for those five paths. Unit617 + DB426
  equals the original1043 files (formerly612 +431); migration and plugin counts unchanged.
- Root SHA-256 comparison confirms all three renamed contents are identical.
- Typecheck, lint with existing warnings, production build and partition audit pass.

Budget soft/hard limits, permission boundaries and unknown-cost/null handling remain
covered. This is removal of unnecessary DB execution, not fewer safety checks or a
claim of measured end-to-end CI speedup.

## Deliberately retained

The copilot tool loader, variant parser and cascade-revert tests still import
DB-connected runtime graphs. File-level no-DB warnings are not sufficient evidence
to move them. The variant parser explicitly documents its transitive DB dependency.
Two `.opencode/plugins/worktree` tests use `bun:test`; absence from Vitest does not
establish that they are dead or should be deleted. Their runner remains separate.
