CREATE TABLE "event_subscription_checkpoint" (
	"subscriber_id" text NOT NULL,
	"subscriber_version" integer NOT NULL,
	"declaration_hash" text NOT NULL,
	"status" text NOT NULL,
	"next_delivery_seq" bigint DEFAULT 1 NOT NULL,
	"claim_owner" text,
	"claim_token" uuid,
	"claim_lease_until" timestamp with time zone,
	"bootstrapped_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_subscription_checkpoint_subscriber_id_subscriber_version_pk" PRIMARY KEY("subscriber_id","subscriber_version"),
	CONSTRAINT "event_subscription_checkpoint_version_positive" CHECK ("event_subscription_checkpoint"."subscriber_version" > 0),
	CONSTRAINT "event_subscription_checkpoint_delivery_seq_positive" CHECK ("event_subscription_checkpoint"."next_delivery_seq" > 0),
	CONSTRAINT "event_subscription_checkpoint_status_check" CHECK ("event_subscription_checkpoint"."status" IN ('bootstrapping','active','paused')),
	CONSTRAINT "event_subscription_checkpoint_claim_shape" CHECK (("event_subscription_checkpoint"."claim_owner" IS NULL AND "event_subscription_checkpoint"."claim_token" IS NULL AND "event_subscription_checkpoint"."claim_lease_until" IS NULL)
        OR ("event_subscription_checkpoint"."claim_owner" IS NOT NULL AND "event_subscription_checkpoint"."claim_token" IS NOT NULL AND "event_subscription_checkpoint"."claim_lease_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "event_subscription_delivery" (
	"subscriber_id" text NOT NULL,
	"subscriber_version" integer NOT NULL,
	"source_event_id" text NOT NULL,
	"source_dispatch_seq" bigint NOT NULL,
	"delivery_seq" bigint NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"redrive_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claim_owner" text,
	"claim_token" uuid,
	"claim_lease_until" timestamp with time zone,
	"last_error" text,
	"outcome" jsonb,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_subscription_delivery_subscriber_id_subscriber_version_source_event_id_pk" PRIMARY KEY("subscriber_id","subscriber_version","source_event_id"),
	CONSTRAINT "event_subscription_delivery_version_positive" CHECK ("event_subscription_delivery"."subscriber_version" > 0),
	CONSTRAINT "event_subscription_delivery_seq_positive" CHECK ("event_subscription_delivery"."delivery_seq" > 0),
	CONSTRAINT "event_subscription_delivery_attempt_nonnegative" CHECK ("event_subscription_delivery"."attempt_count" >= 0),
	CONSTRAINT "event_subscription_delivery_redrive_nonnegative" CHECK ("event_subscription_delivery"."redrive_count" >= 0),
	CONSTRAINT "event_subscription_delivery_status_check" CHECK ("event_subscription_delivery"."status" IN ('bootstrap_skipped','pending','claimed','retry_wait','succeeded','skipped','dead_letter')),
	CONSTRAINT "event_subscription_delivery_claim_shape" CHECK ((("event_subscription_delivery"."claim_owner" IS NULL AND "event_subscription_delivery"."claim_token" IS NULL AND "event_subscription_delivery"."claim_lease_until" IS NULL AND "event_subscription_delivery"."claimed_at" IS NULL)
        OR ("event_subscription_delivery"."claim_owner" IS NOT NULL AND "event_subscription_delivery"."claim_token" IS NOT NULL AND "event_subscription_delivery"."claim_lease_until" IS NOT NULL AND "event_subscription_delivery"."claimed_at" IS NOT NULL))
        AND (("event_subscription_delivery"."status" = 'claimed') = ("event_subscription_delivery"."claim_owner" IS NOT NULL))),
	CONSTRAINT "event_subscription_delivery_retry_shape" CHECK ((("event_subscription_delivery"."status" = 'retry_wait') = ("event_subscription_delivery"."next_attempt_at" IS NOT NULL))),
	CONSTRAINT "event_subscription_delivery_completion_shape" CHECK ((("event_subscription_delivery"."status" IN ('bootstrap_skipped','succeeded','skipped','dead_letter')) = ("event_subscription_delivery"."completed_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "event_subscription_effect" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_event_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"effect_kind" text NOT NULL,
	"subscriber_id" text,
	"subscriber_version" integer,
	"source_event_id" text,
	"mastery_event_ids" text[] NOT NULL,
	"evidence_ids" text[] NOT NULL,
	"question_id" text,
	"status" text NOT NULL,
	"stable_job_key" text NOT NULL,
	"downstream_job_id" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enqueued_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_subscription_effect_kind_check" CHECK ("event_subscription_effect"."effect_kind" = 'mastery_change'),
	CONSTRAINT "event_subscription_effect_status_check" CHECK ("event_subscription_effect"."status" IN ('reserved','enqueued','debounced','disabled')),
	CONSTRAINT "event_subscription_effect_provenance_shape" CHECK (("event_subscription_effect"."subscriber_id" IS NULL AND "event_subscription_effect"."subscriber_version" IS NULL AND "event_subscription_effect"."source_event_id" IS NULL)
        OR ("event_subscription_effect"."subscriber_id" IS NOT NULL AND "event_subscription_effect"."subscriber_version" IS NOT NULL AND "event_subscription_effect"."subscriber_version" > 0 AND "event_subscription_effect"."source_event_id" IS NOT NULL)),
	CONSTRAINT "event_subscription_effect_mastery_events_nonempty" CHECK (cardinality("event_subscription_effect"."mastery_event_ids") > 0),
	CONSTRAINT "event_subscription_effect_evidence_nonempty" CHECK (cardinality("event_subscription_effect"."evidence_ids") > 0)
);
--> statement-breakpoint
CREATE SEQUENCE "event_dispatch_seq";--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "dispatch_seq" bigint;--> statement-breakpoint
WITH ordered_events AS (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "seq"
	FROM "event"
)
UPDATE "event"
SET "dispatch_seq" = ordered_events."seq"
FROM ordered_events
WHERE "event"."id" = ordered_events."id";--> statement-breakpoint
SELECT setval(
	'event_dispatch_seq',
	COALESCE((SELECT MAX("dispatch_seq") FROM "event"), 1),
	EXISTS (SELECT 1 FROM "event")
);--> statement-breakpoint
ALTER TABLE "event" ALTER COLUMN "dispatch_seq" SET DEFAULT nextval('event_dispatch_seq');--> statement-breakpoint
ALTER TABLE "event" ALTER COLUMN "dispatch_seq" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_id_dispatch_seq_unique" ON "event" USING btree ("id","dispatch_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "event_dispatch_seq_unique" ON "event" USING btree ("dispatch_seq");--> statement-breakpoint
ALTER TABLE "event_subscription_delivery" ADD CONSTRAINT "event_subscription_delivery_source_event_fk" FOREIGN KEY ("source_event_id","source_dispatch_seq") REFERENCES "public"."event"("id","dispatch_seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscription_delivery" ADD CONSTRAINT "event_subscription_delivery_checkpoint_fk" FOREIGN KEY ("subscriber_id","subscriber_version") REFERENCES "public"."event_subscription_checkpoint"("subscriber_id","subscriber_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscription_effect" ADD CONSTRAINT "event_subscription_effect_attempt_event_id_event_id_fk" FOREIGN KEY ("attempt_event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscription_effect" ADD CONSTRAINT "event_subscription_effect_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscription_effect" ADD CONSTRAINT "event_subscription_effect_delivery_fk" FOREIGN KEY ("subscriber_id","subscriber_version","source_event_id") REFERENCES "public"."event_subscription_delivery"("subscriber_id","subscriber_version","source_event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_subscription_checkpoint_status_idx" ON "event_subscription_checkpoint" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "event_subscription_checkpoint_expired_lease_idx" ON "event_subscription_checkpoint" USING btree ("claim_lease_until","subscriber_id","subscriber_version") WHERE "event_subscription_checkpoint"."claim_lease_until" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_subscription_delivery_local_seq_uq" ON "event_subscription_delivery" USING btree ("subscriber_id","subscriber_version","delivery_seq");--> statement-breakpoint
CREATE INDEX "event_subscription_delivery_ready_idx" ON "event_subscription_delivery" USING btree ("subscriber_id","subscriber_version","delivery_seq") WHERE "event_subscription_delivery"."status" IN ('pending','retry_wait');--> statement-breakpoint
CREATE INDEX "event_subscription_delivery_expired_claim_idx" ON "event_subscription_delivery" USING btree ("claim_lease_until","subscriber_id","subscriber_version","delivery_seq") WHERE "event_subscription_delivery"."status" = 'claimed';--> statement-breakpoint
CREATE INDEX "event_subscription_delivery_dlq_idx" ON "event_subscription_delivery" USING btree ("subscriber_id","subscriber_version","completed_at" DESC NULLS LAST) WHERE "event_subscription_delivery"."status" = 'dead_letter';--> statement-breakpoint
CREATE INDEX "event_subscription_delivery_history_idx" ON "event_subscription_delivery" USING btree ("subscriber_id","subscriber_version","delivery_seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "event_subscription_delivery_discovery_idx" ON "event_subscription_delivery" USING btree ("subscriber_id","subscriber_version","source_dispatch_seq","source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_subscription_effect_causal_uq" ON "event_subscription_effect" USING btree ("attempt_event_id","artifact_id","effect_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "event_subscription_effect_stable_job_key_uq" ON "event_subscription_effect" USING btree ("stable_job_key");--> statement-breakpoint
CREATE INDEX "event_subscription_effect_recent_enqueued_idx" ON "event_subscription_effect" USING btree ("artifact_id","effect_kind","enqueued_at" DESC NULLS LAST) WHERE "event_subscription_effect"."status" = 'enqueued';--> statement-breakpoint
CREATE INDEX "event_subscription_effect_provenance_idx" ON "event_subscription_effect" USING btree ("subscriber_id","subscriber_version","source_event_id");--> statement-breakpoint
CREATE INDEX "event_subscription_effect_downstream_job_idx" ON "event_subscription_effect" USING btree ("downstream_job_id") WHERE "event_subscription_effect"."downstream_job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "event_action_dispatch_idx" ON "event" USING btree ("action","dispatch_seq","id");