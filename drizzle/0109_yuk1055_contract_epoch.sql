CREATE TABLE "contract_epoch" (
	"seq" integer PRIMARY KEY NOT NULL,
	"epoch" text NOT NULL,
	"state" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entered_by" text NOT NULL,
	"note" text,
	CONSTRAINT "contract_epoch_state_ck" CHECK ("contract_epoch"."state" IN ('preparing','ready','active')),
	CONSTRAINT "contract_epoch_epoch_nonempty_ck" CHECK (length("contract_epoch"."epoch") > 0),
	CONSTRAINT "contract_epoch_entered_by_nonempty_ck" CHECK (length("contract_epoch"."entered_by") > 0)
);
--> statement-breakpoint
-- YUK-1055 — seed the implicit legacy epoch so every migrated DB has an explicit,
-- auditable marker row instead of relying on "table absent/empty ⇒ legacy" alone.
-- Idempotent: re-run on a DB that already carries any epoch history is a no-op
-- (never downgrade an operator-placed 'preparing'/'ready'/new-epoch marker).
INSERT INTO "contract_epoch" ("seq", "epoch", "state", "entered_by", "note")
SELECT 0, 'legacy', 'active', 'migrate', 'implicit legacy epoch — seeded by 0109'
WHERE NOT EXISTS (SELECT 1 FROM "contract_epoch");
