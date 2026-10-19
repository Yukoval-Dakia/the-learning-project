CREATE TABLE "model_catalog_cache" (
	"id" smallint PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"version" text NOT NULL,
	"upstream_version" text NOT NULL,
	"source_url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"findings" jsonb NOT NULL,
	CONSTRAINT "model_catalog_cache_singleton" CHECK ("model_catalog_cache"."id" = 1)
);
