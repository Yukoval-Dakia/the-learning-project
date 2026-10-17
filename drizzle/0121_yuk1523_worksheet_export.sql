CREATE TABLE "worksheet_export" (
	"export_id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"export_token" text NOT NULL,
	"short_code" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"refused" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"web_only_units" jsonb,
	"page_count" integer,
	"pdf_digest" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worksheet_export_request_digest_ck" CHECK ("worksheet_export"."request_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "worksheet_export_identity_nonempty_ck" CHECK ("worksheet_export"."export_token" <> '' AND "worksheet_export"."short_code" <> '' AND "worksheet_export"."idempotency_key" <> ''),
	CONSTRAINT "worksheet_export_archive_shape_ck" CHECK (("worksheet_export"."archived_at" IS NULL AND "worksheet_export"."page_count" IS NULL AND "worksheet_export"."web_only_units" IS NULL AND "worksheet_export"."pdf_digest" IS NULL) OR ("worksheet_export"."archived_at" IS NOT NULL AND "worksheet_export"."page_count" >= 1 AND "worksheet_export"."web_only_units" IS NOT NULL AND "worksheet_export"."pdf_digest" IS NOT NULL AND "worksheet_export"."pdf_digest" ~ '^sha256:[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "worksheet_export_item" (
	"export_id" text NOT NULL,
	"position" integer NOT NULL,
	"group_id" text NOT NULL,
	"issuance_id" text NOT NULL,
	CONSTRAINT "worksheet_export_item_export_id_position_pk" PRIMARY KEY("export_id","position"),
	CONSTRAINT "worksheet_export_item_position_ck" CHECK ("worksheet_export_item"."position" >= 0),
	CONSTRAINT "worksheet_export_item_identity_nonempty_ck" CHECK ("worksheet_export_item"."group_id" <> '' AND "worksheet_export_item"."issuance_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "worksheet_region_map_page" (
	"export_id" text NOT NULL,
	"page" integer NOT NULL,
	"page_count" integer NOT NULL,
	"region_map" jsonb NOT NULL,
	"map_digest" text NOT NULL,
	"archived_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worksheet_region_map_page_export_id_page_pk" PRIMARY KEY("export_id","page"),
	CONSTRAINT "worksheet_region_map_page_ck" CHECK ("worksheet_region_map_page"."page" >= 1),
	CONSTRAINT "worksheet_region_map_page_count_ck" CHECK ("worksheet_region_map_page"."page_count" >= 1),
	CONSTRAINT "worksheet_region_map_page_digest_ck" CHECK ("worksheet_region_map_page"."map_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "worksheet_export_item" ADD CONSTRAINT "worksheet_export_item_export_id_worksheet_export_export_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."worksheet_export"("export_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksheet_region_map_page" ADD CONSTRAINT "worksheet_region_map_page_export_id_worksheet_export_export_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."worksheet_export"("export_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worksheet_export_token_uq" ON "worksheet_export" USING btree ("export_token");--> statement-breakpoint
CREATE UNIQUE INDEX "worksheet_export_short_code_uq" ON "worksheet_export" USING btree ("short_code");--> statement-breakpoint
CREATE UNIQUE INDEX "worksheet_export_idempotency_key_uq" ON "worksheet_export" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "worksheet_export_item_issuance_idx" ON "worksheet_export_item" USING btree ("issuance_id");