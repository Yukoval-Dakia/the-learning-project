CREATE TABLE "item_family_calibration" (
	"id" text PRIMARY KEY NOT NULL,
	"family_key" text NOT NULL,
	"b_delta" real DEFAULT 0 NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "item_family_calibration_family_unique" ON "item_family_calibration" USING btree ("family_key");