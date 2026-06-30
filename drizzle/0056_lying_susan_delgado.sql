CREATE TABLE "misconception_edge" (
	"id" text PRIMARY KEY NOT NULL,
	"from_kind" text NOT NULL,
	"from_id" text NOT NULL,
	"to_kind" text NOT NULL,
	"to_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"proposed_by_ai" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "misconception" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "misconception" ADD COLUMN "source" text DEFAULT 'soft' NOT NULL;--> statement-breakpoint
ALTER TABLE "misconception" ADD COLUMN "seen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "misconception" ADD COLUMN "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "misconception_edge_unique" ON "misconception_edge" USING btree ("from_kind","from_id","to_kind","to_id","relation_type");--> statement-breakpoint
CREATE INDEX "misconception_edge_from_idx" ON "misconception_edge" USING btree ("from_kind","from_id","relation_type");--> statement-breakpoint
CREATE INDEX "misconception_edge_to_idx" ON "misconception_edge" USING btree ("to_kind","to_id","relation_type");