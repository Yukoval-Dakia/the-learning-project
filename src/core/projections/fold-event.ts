// Flat event-row projection consumed by the structural folds. Deliberately not the
// parsed Event union: that drops subject_kind/actor_kind and lacks DB id/created_at.
// Each reducer re-parses its branch from these columns so a malformed payload is
// rejected at the boundary. Both folds consume the same shape.
export interface FoldEvent {
  id: string;
  created_at: Date;
  actor_kind: string;
  actor_ref: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  outcome: string | null;
  caused_by_event_id: string | null;
  payload: Record<string, unknown>;
}
