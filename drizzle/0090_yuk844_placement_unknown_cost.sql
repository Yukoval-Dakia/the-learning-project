ALTER TABLE "placement_starter_claim"
  ALTER COLUMN "known_cost_micro_usd" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "placement_starter_cost_component"
  ALTER COLUMN "cost_micro_usd" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "placement_starter_cost_component"
  ADD COLUMN "over_cap" boolean;
--> statement-breakpoint
ALTER TABLE "placement_starter_claim"
  DROP CONSTRAINT "placement_starter_claim_nonnegative_cost";
--> statement-breakpoint
ALTER TABLE "placement_starter_claim"
  ADD CONSTRAINT "placement_starter_claim_nonnegative_cost"
  CHECK (
    "budget_limit_micro_usd" >= 0
    AND ("known_cost_micro_usd" IS NULL OR "known_cost_micro_usd" >= 0)
  );
--> statement-breakpoint
ALTER TABLE "placement_starter_cost_component"
  DROP CONSTRAINT "placement_starter_cost_component_nonnegative";
--> statement-breakpoint
ALTER TABLE "placement_starter_cost_component"
  ADD CONSTRAINT "placement_starter_cost_component_nonnegative"
  CHECK (
    (
      "provider_task_run_id" LIKE 'reservation:%'
      AND "cost_micro_usd" IS NOT NULL
      AND "cost_micro_usd" >= 0
    ) OR (
      "provider_task_run_id" NOT LIKE 'reservation:%'
      AND ("cost_micro_usd" IS NULL OR "cost_micro_usd" >= 0)
    )
  );
--> statement-breakpoint
ALTER TABLE "placement_starter_cost_component"
  ADD CONSTRAINT "placement_starter_cost_component_over_cap_check"
  CHECK (
    "over_cap" IS NULL
    OR (
      "provider_task_run_id" NOT LIKE 'reservation:%'
      AND "cost_micro_usd" IS NOT NULL
    )
  );
