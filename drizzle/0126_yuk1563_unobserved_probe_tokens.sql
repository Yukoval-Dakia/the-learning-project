ALTER TABLE "cost_ledger" ALTER COLUMN "tokens_in" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ALTER COLUMN "tokens_out" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_tokens_pair_ck" CHECK ((
        ("cost_ledger"."tokens_in" IS NULL AND "cost_ledger"."tokens_out" IS NULL)
        OR (
          "cost_ledger"."tokens_in" IS NOT NULL AND "cost_ledger"."tokens_out" IS NOT NULL
          AND "cost_ledger"."tokens_in" >= 0 AND "cost_ledger"."tokens_out" >= 0
        )
      ));