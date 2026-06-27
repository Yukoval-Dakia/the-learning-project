CREATE TABLE "kc_typed_state" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" text DEFAULT 'knowledge' NOT NULL,
	"subject_id" text NOT NULL,
	"typed_state" text DEFAULT 'no-evidence' NOT NULL,
	"confused_with_kc_id" text,
	"lifecycle" text DEFAULT 'open' NOT NULL,
	"evidence_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_evidence_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "kc_typed_state_unique" ON "kc_typed_state" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "kc_typed_state_subject_idx" ON "kc_typed_state" USING btree ("subject_id");