-- YUK-841 — one explicit cost truth per central-runner model attempt.
--
-- Existing and non-runner ledger rows remain `legacy`; this migration does not
-- infer evidence from historical numeric amounts. New attempt rows distinguish
-- provider-reported, locally estimated, and genuinely unknown cost.
ALTER TABLE "ai_task_runs"
  ADD COLUMN "cost_basis" text,
  ADD COLUMN "cost_ref" text;

ALTER TABLE "ai_task_runs"
  ADD CONSTRAINT "ai_task_runs_cost_truth_ck"
    CHECK (
      ("cost_basis" IS NULL AND "cost_ref" IS NULL)
      OR (
        "cost_basis" IS NOT NULL
        AND "cost_basis" IN ('reported', 'estimated', 'unknown')
        AND "cost_ref" IS NOT NULL
        AND btrim("cost_ref") <> ''
        AND (
          ("cost_basis" = 'unknown' AND "cost_usd" IS NULL)
          OR (
            "cost_basis" IN ('reported', 'estimated')
            AND "cost_usd" IS NOT NULL
            AND "cost_usd" >= 0
          )
        )
      )
    );

ALTER TABLE "cost_ledger"
  ALTER COLUMN "cost" DROP NOT NULL,
  ADD COLUMN "entry_kind" text DEFAULT 'legacy' NOT NULL,
  ADD COLUMN "cost_basis" text,
  ADD COLUMN "cost_ref" text;

ALTER TABLE "cost_ledger"
  ADD CONSTRAINT "cost_ledger_entry_kind_ck"
    CHECK ("entry_kind" IN ('legacy', 'attempt')),
  ADD CONSTRAINT "cost_ledger_cost_basis_ck"
    CHECK ("cost_basis" IS NULL OR "cost_basis" IN ('reported', 'estimated', 'unknown')),
  ADD CONSTRAINT "cost_ledger_attempt_truth_ck"
    CHECK (
      (
        "entry_kind" = 'legacy'
        AND "cost" IS NOT NULL
        AND "cost_basis" IS NULL
        AND "cost_ref" IS NULL
      ) OR (
        "entry_kind" = 'attempt'
        AND "task_run_id" IS NOT NULL
        AND "cost_basis" IS NOT NULL
        AND "cost_ref" IS NOT NULL
        AND btrim("cost_ref") <> ''
        AND (
          ("cost_basis" = 'unknown' AND "cost" IS NULL)
          OR (
            "cost_basis" IN ('reported', 'estimated')
            AND "cost" IS NOT NULL
            AND "cost" >= 0
          )
        )
      )
    );

CREATE UNIQUE INDEX "cost_ledger_attempt_task_run_uq"
  ON "cost_ledger" ("task_run_id")
  WHERE "entry_kind" = 'attempt';
