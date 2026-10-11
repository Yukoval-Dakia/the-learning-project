-- New paid-effect tables only. Earlier hand-written migrations 0113–0118
-- already create the historical control/receipt tables represented in the new snapshot.
CREATE TABLE "paid_effect" (
	"family" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_revision" text NOT NULL,
	"unit" text NOT NULL,
	"input_digest" text NOT NULL,
	"input_json" jsonb NOT NULL,
	"state" text NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"delivery_id" text,
	"delivery_backend" text,
	"delivery_tick" text,
	"send_lease_expires_at" timestamp with time zone,
	"result_json" jsonb,
	"result_recorded_at" timestamp with time zone,
	"application_json" jsonb,
	"applied_at" timestamp with time zone,
	"application_attempts" integer DEFAULT 0 NOT NULL,
	"last_application_error" text,
	"unresolved_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_effect_family_entity_id_entity_revision_unit_input_digest_pk" PRIMARY KEY("family","entity_id","entity_revision","unit","input_digest"),
	CONSTRAINT "paid_effect_state_ck" CHECK ("paid_effect"."state" IN ('pending','sending','unknown','receipt_ready','applied')),
	CONSTRAINT "paid_effect_digest_ck" CHECK ("paid_effect"."input_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "paid_effect_fence_ck" CHECK ("paid_effect"."fence" >= 0),
	CONSTRAINT "paid_effect_identity_nonempty_ck" CHECK ("paid_effect"."entity_id" <> '' AND "paid_effect"."entity_revision" <> '' AND "paid_effect"."unit" <> ''),
	CONSTRAINT "paid_effect_state_shape_ck" CHECK ((
        ("paid_effect"."state" = 'pending' AND "paid_effect"."delivery_id" IS NULL AND "paid_effect"."delivery_backend" IS NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL)
        OR ("paid_effect"."state" = 'sending' AND "paid_effect"."delivery_id" IS NOT NULL AND "paid_effect"."delivery_backend" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NOT NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL)
        OR ("paid_effect"."state" = 'unknown' AND "paid_effect"."delivery_id" IS NOT NULL AND "paid_effect"."delivery_backend" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."result_json" IS NULL AND "paid_effect"."applied_at" IS NULL AND "paid_effect"."unresolved_reason" IS NOT NULL)
        OR ("paid_effect"."state" = 'receipt_ready' AND "paid_effect"."result_json" IS NOT NULL AND "paid_effect"."result_recorded_at" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL AND "paid_effect"."applied_at" IS NULL)
        OR ("paid_effect"."state" = 'applied' AND "paid_effect"."result_json" IS NOT NULL AND "paid_effect"."applied_at" IS NOT NULL AND "paid_effect"."application_json" IS NOT NULL AND "paid_effect"."send_lease_expires_at" IS NULL)
      )),
	CONSTRAINT "paid_effect_application_attempts_ck" CHECK ("paid_effect"."application_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "paid_effect_control" (
	"family" text PRIMARY KEY NOT NULL,
	"backend" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "paid_effect_obligation_idx" ON "paid_effect" USING btree ("family","state");
