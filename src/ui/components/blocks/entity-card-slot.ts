import { type ComponentType, createContext } from 'react';

export interface EntityCardSlotProps {
  entityKind: 'knowledge' | 'note';
  entityId: string;
}

/** A surface that can draw the card supplies this; elsewhere it stays a link. */
export const EntityCardSlotContext = createContext<ComponentType<EntityCardSlotProps> | null>(null);
