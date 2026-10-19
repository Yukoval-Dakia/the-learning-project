CREATE TABLE "paid_effect_cancellation" (
	"family" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_revision" text NOT NULL,
	"unit" text NOT NULL,
	"input_digest" text NOT NULL,
	"request_id" text NOT NULL,
	"reason" text NOT NULL,
	"operator" text NOT NULL,
	"basis" text NOT NULL,
	"cancelled_from_state" text NOT NULL,
	"previous_fence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_effect_cancellation_pk" PRIMARY KEY("family","entity_id","entity_revision","unit","input_digest"),
	CONSTRAINT "paid_effect_cancellation_digest_ck" CHECK ("paid_effect_cancellation"."input_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "paid_effect_cancellation_nonempty_ck" CHECK ("paid_effect_cancellation"."entity_id" <> '' AND "paid_effect_cancellation"."entity_revision" <> '' AND "paid_effect_cancellation"."unit" <> '' AND "paid_effect_cancellation"."request_id" <> '' AND "paid_effect_cancellation"."reason" <> '' AND "paid_effect_cancellation"."operator" <> '' AND "paid_effect_cancellation"."basis" <> ''),
	CONSTRAINT "paid_effect_cancellation_from_ck" CHECK ("paid_effect_cancellation"."cancelled_from_state" = 'pending' AND "paid_effect_cancellation"."previous_fence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "paid_effect" DROP CONSTRAINT "paid_effect_state_ck";--> statement-breakpoint
ALTER TABLE "paid_effect" DROP CONSTRAINT "paid_effect_state_shape_ck";--> statement-breakpoint
ALTER TABLE "paid_effect" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paid_effect" ADD COLUMN "cancel_json" jsonb;--> statement-breakpoint
ALTER TABLE "paid_effect_cancellation" ADD CONSTRAINT "paid_effect_cancellation_old_effect_fk" FOREIGN KEY ("family","entity_id","entity_revision","unit","input_digest") REFERENCES "public"."paid_effect"("family","entity_id","entity_revision","unit","input_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paid_effect_cancellation_entity_idx" ON "paid_effect_cancellation" USING btree ("family","entity_id");--> statement-breakpoint
CREATE INDEX "paid_effect_cancellation_request_idx" ON "paid_effect_cancellation" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "paid_effect" ADD CONSTRAINT "paid_effect_state_ck" CHECK ("paid_effect"."state" IN ('pending','sending','unknown','receipt_ready','applied','voided','cancelled'));--> statement-breakpoint
ALTER TABLE "paid_effect" ADD CONSTRAINT "paid_effect_state_shape_ck" CHECK ((
        ("paid_effect"."state" = 'pending' AND "paid_effect"."delivery_id" IS NULL AND "paid_effect"."delivery_backend" IS NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL)
        OR ("paid_effect"."state" = 'sending' AND "paid_effect"."delivery_id" IS NOT NULL AND "paid_effect"."delivery_backend" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NOT NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL)
        OR ("paid_effect"."state" = 'unknown' AND "paid_effect"."delivery_id" IS NOT NULL AND "paid_effect"."delivery_backend" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL AND "paid_effect"."unresolved_reason" IS NOT NULL)
        OR ("paid_effect"."state" = 'receipt_ready' AND "paid_effect"."result_json" IS NOT NULL AND "paid_effect"."result_recorded_at" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."applied_at" IS NULL)
        OR ("paid_effect"."state" = 'applied' AND "paid_effect"."result_json" IS NOT NULL AND "paid_effect"."applied_at" IS NOT NULL AND "paid_effect"."application_json" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL)
        OR ("paid_effect"."state" = 'voided' AND "paid_effect"."delivery_id" IS NOT NULL AND "paid_effect"."delivery_backend" IS NOT NULL AND "paid_effect"."unresolved_reason" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL AND "paid_effect"."voided_at" IS NOT NULL AND "paid_effect"."void_json" IS NOT NULL)
        OR ("paid_effect"."state" = 'cancelled' AND "paid_effect"."delivery_id" IS NULL AND "paid_effect"."delivery_backend" IS NULL AND "paid_effect"."delivery_tick" IS NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."result_recorded_at" IS NULL AND "paid_effect"."application_json" IS NULL AND "paid_effect"."applied_at" IS NULL AND "paid_effect"."unresolved_reason" IS NULL AND "paid_effect"."voided_at" IS NULL AND "paid_effect"."void_json" IS NULL AND "paid_effect"."cancelled_at" IS NOT NULL AND "paid_effect"."cancel_json" IS NOT NULL)
      ));