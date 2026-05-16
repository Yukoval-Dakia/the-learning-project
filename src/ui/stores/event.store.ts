import { create } from 'zustand';

// NOTE: named "event" not "encounter" — per ADR-0006 v2
// TODO (Phase 1c.2): flesh out with event list state shape
// - events by session
// - optimistic event mutations
// - real-time event feed subscription
export const useEventStore = create(() => ({}));
