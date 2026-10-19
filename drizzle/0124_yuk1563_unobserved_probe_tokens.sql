ALTER TABLE "cost_ledger" ALTER COLUMN "tokens_in" DROP NOT NULL;
ALTER TABLE "cost_ledger" ALTER COLUMN "tokens_out" DROP NOT NULL;
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_tokens_pair_ck" CHECK (
  ("tokens_in" IS NULL AND "tokens_out" IS NULL)
  OR (
    "tokens_in" IS NOT NULL AND "tokens_out" IS NOT NULL
    AND "tokens_in" >= 0 AND "tokens_out" >= 0
  )
);
