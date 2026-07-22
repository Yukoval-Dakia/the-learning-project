-- YUK-746 item 4: artifact UPDATE transitions must apply the effects of both
-- the old artifact type and the new artifact type. In particular, a direct
-- note_atomic <-> note_hub transition must update the transitioned hub cursor
-- and fan out the atomic topology change to every other live hub.
CREATE OR REPLACE FUNCTION "fanout_hub_sync_dirty"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_live_hub boolean;
  new_live_hub boolean;
  dirty_target record;
BEGIN
  IF TG_TABLE_NAME = 'artifact' THEN
    -- The reconciler's own body_blocks/version write must never self-dirty.
    -- Only this GUC (set by hub-sync finalization) reaches here, and the
    -- reconciler touches no other artifact row/column, so a full skip is safe.
    IF current_setting('app.hub_sync_internal_apply', true) = '1' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF NEW.type = 'note_hub' AND NEW.archived_at IS NULL THEN
        PERFORM mark_hub_sync_dirty(NEW.id, false);
      ELSIF NEW.type = 'note_atomic' AND NEW.archived_at IS NULL THEN
        PERFORM mark_hub_sync_dirty(id, false)
        FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      old_live_hub := OLD.type = 'note_hub' AND OLD.archived_at IS NULL;
      new_live_hub := NEW.type = 'note_hub' AND NEW.archived_at IS NULL;

      IF OLD.type IS DISTINCT FROM NEW.type
        AND (OLD.type IN ('note_hub', 'note_atomic') OR NEW.type IN ('note_hub', 'note_atomic')) THEN
        -- Type transitions can affect the transitioned hub cursor and every
        -- other live hub. Build one de-duplicated action set, then lock all
        -- reconciliation rows in the same global order across transactions.
        FOR dirty_target IN
          SELECT target_artifact_id, bool_or(cancel_target) AS cancel_target
          FROM (
            SELECT NEW.id AS target_artifact_id, old_live_hub AND NOT new_live_hub AS cancel_target
            WHERE old_live_hub IS DISTINCT FROM new_live_hub
            UNION ALL
            SELECT id AS target_artifact_id, false AS cancel_target
            FROM artifact
            WHERE type = 'note_hub'
              AND archived_at IS NULL
              AND id <> NEW.id
              AND (OLD.type = 'note_atomic' OR NEW.type = 'note_atomic')
          ) AS transition_targets
          GROUP BY target_artifact_id
          ORDER BY target_artifact_id
        LOOP
          PERFORM mark_hub_sync_dirty(
            dirty_target.target_artifact_id,
            dirty_target.cancel_target
          );
        END LOOP;
      ELSE
        IF OLD.type = 'note_hub' OR NEW.type = 'note_hub' THEN
          IF old_live_hub AND NOT new_live_hub THEN
            -- archive cancels the cursor.
            PERFORM mark_hub_sync_dirty(NEW.id, true);
          ELSIF new_live_hub AND NOT old_live_hub THEN
            -- restore re-dirties the cursor.
            PERFORM mark_hub_sync_dirty(NEW.id, false);
          ELSIF new_live_hub AND old_live_hub AND (
            OLD.knowledge_ids IS DISTINCT FROM NEW.knowledge_ids
            OR OLD.body_blocks IS DISTINCT FROM NEW.body_blocks
            OR OLD.attrs IS DISTINCT FROM NEW.attrs
          ) THEN
            PERFORM mark_hub_sync_dirty(NEW.id, false);
          END IF;
        END IF;

        IF OLD.type = 'note_atomic' OR NEW.type = 'note_atomic' THEN
          IF OLD.title IS DISTINCT FROM NEW.title
            OR OLD.knowledge_ids IS DISTINCT FROM NEW.knowledge_ids
            OR OLD.archived_at IS DISTINCT FROM NEW.archived_at THEN
            PERFORM mark_hub_sync_dirty(id, false)
            FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
          END IF;
        END IF;
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      -- Hard-deleted hubs cascade their cursor via FK. A live atomic delete
      -- changes every hub mesh, so fan out.
      IF OLD.type = 'note_atomic' AND OLD.archived_at IS NULL THEN
        PERFORM mark_hub_sync_dirty(id, false)
        FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
      END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'knowledge' THEN
    IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' OR (
      OLD.name IS DISTINCT FROM NEW.name
      OR OLD.domain IS DISTINCT FROM NEW.domain
      OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
      OR OLD.merged_from IS DISTINCT FROM NEW.merged_from
      OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    ) THEN
      PERFORM mark_hub_sync_dirty(id, false)
      FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'knowledge_edge' THEN
    IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' OR (
      OLD.from_knowledge_id IS DISTINCT FROM NEW.from_knowledge_id
      OR OLD.to_knowledge_id IS DISTINCT FROM NEW.to_knowledge_id
      OR OLD.relation_type IS DISTINCT FROM NEW.relation_type
      OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    ) THEN
      PERFORM mark_hub_sync_dirty(id, false)
      FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
