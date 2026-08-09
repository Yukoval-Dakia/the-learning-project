CREATE INDEX "provider_attempt_lane_start_rate_idx"
  ON "provider_attempt" ("lane_id", "provider_start_reserved_at")
  WHERE "provider_start_reserved_at" IS NOT NULL;
