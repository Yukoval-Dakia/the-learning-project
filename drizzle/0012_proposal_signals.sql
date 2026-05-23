CREATE TABLE "proposal_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"cooldown_key" text NOT NULL,
	"accept_count" integer DEFAULT 0 NOT NULL,
	"dismiss_count" integer DEFAULT 0 NOT NULL,
	"acceptance_rate" real DEFAULT 0.5 NOT NULL,
	"dismiss_reason" text,
	"cooldown_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_signals_key_unique" ON "proposal_signals" USING btree ("kind","cooldown_key");--> statement-breakpoint
CREATE INDEX "proposal_signals_kind_rate_idx" ON "proposal_signals" USING btree ("kind","acceptance_rate" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proposal_signals_cooldown_idx" ON "proposal_signals" USING btree ("cooldown_key","cooldown_until");
