CREATE TABLE "paid_effect_authorization" (
	"family" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_revision" text NOT NULL,
	"unit" text NOT NULL,
	"input_digest" text NOT NULL,
	"authorization_id" text NOT NULL,
	"successor_entity_revision" text NOT NULL,
	"successor_unit" text NOT NULL,
	"successor_input_digest" text NOT NULL,
	"successor_delivery_backend" text NOT NULL,
	"successor_delivery_id" text NOT NULL,
	"reason" text NOT NULL,
	"operator" text NOT NULL,
	"basis" text NOT NULL,
	"consumed_delivery_id" text,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_effect_authorization_family_entity_id_entity_revision_unit_input_digest_pk" PRIMARY KEY("family","entity_id","entity_revision","unit","input_digest"),
	CONSTRAINT "paid_effect_authorization_digest_ck" CHECK ("paid_effect_authorization"."input_digest" ~ '^sha256:[0-9a-f]{64}$' AND "paid_effect_authorization"."successor_input_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "paid_effect_authorization_nonempty_ck" CHECK ("paid_effect_authorization"."entity_id" <> '' AND "paid_effect_authorization"."entity_revision" <> '' AND "paid_effect_authorization"."unit" <> '' AND "paid_effect_authorization"."authorization_id" <> '' AND "paid_effect_authorization"."successor_entity_revision" <> '' AND "paid_effect_authorization"."successor_unit" <> '' AND "paid_effect_authorization"."successor_delivery_id" <> '' AND "paid_effect_authorization"."reason" <> '' AND "paid_effect_authorization"."operator" <> '' AND "paid_effect_authorization"."basis" <> '')
);
--> statement-breakpoint
ALTER TABLE "paid_effect" DROP CONSTRAINT "paid_effect_state_ck";--> statement-breakpoint
ALTER TABLE "paid_effect" DROP CONSTRAINT "paid_effect_state_shape_ck";--> statement-breakpoint
ALTER TABLE "paid_effect" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paid_effect" ADD COLUMN "void_json" jsonb;--> statement-breakpoint
ALTER TABLE "paid_effect_authorization" ADD CONSTRAINT "paid_effect_authorization_family_entity_id_entity_revision_unit_input_digest_paid_effect_family_entity_id_entity_revision_unit_input_digest_fk" FOREIGN KEY ("family","entity_id","entity_revision","unit","input_digest") REFERENCES "public"."paid_effect"("family","entity_id","entity_revision","unit","input_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paid_effect_authorization_entity_idx" ON "paid_effect_authorization" USING btree ("family","entity_id");--> statement-breakpoint
CREATE INDEX "paid_effect_authorization_successor_idx" ON "paid_effect_authorization" USING btree ("family","entity_id","successor_entity_revision","successor_unit","successor_input_digest");--> statement-breakpoint
ALTER TABLE "paid_effect" ADD CONSTRAINT "paid_effect_state_ck" CHECK ("paid_effect"."state" IN ('pending','sending','unknown','receipt_ready','applied','voided'));--> statement-breakpoint
ALTER TABLE "paid_effect" ADD CONSTRAINT "paid_effect_state_shape_ck" CHECK ((
        ("paid_effect"."state" = 'pending' AND "paid_effect"."delivery_id" IS NULL AND "paid_effect"."delivery_backend" IS NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL)
        OR ("paid_effect"."state" = 'sending' AND "paid_effect"."delivery_id" IS NOT NULL AND "paid_effect"."delivery_backend" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NOT NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL)
        OR ("paid_effect"."state" = 'unknown' AND "paid_effect"."delivery_id" IS NOT NULL AND "paid_effect"."delivery_backend" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL AND "paid_effect"."unresolved_reason" IS NOT NULL)
        OR ("paid_effect"."state" = 'receipt_ready' AND "paid_effect"."result_json" IS NOT NULL AND "paid_effect"."result_recorded_at" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."applied_at" IS NULL)
        OR ("paid_effect"."state" = 'applied' AND "paid_effect"."result_json" IS NOT NULL AND "paid_effect"."applied_at" IS NOT NULL AND "paid_effect"."application_json" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL)
        OR ("paid_effect"."state" = 'voided' AND "paid_effect"."delivery_id" IS NOT NULL AND "paid_effect"."delivery_backend" IS NOT NULL AND "paid_effect"."unresolved_reason" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL AND "paid_effect"."voided_at" IS NOT NULL AND "paid_effect"."void_json" IS NOT NULL)
      ));