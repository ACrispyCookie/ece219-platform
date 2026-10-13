import { createContext, useContext, useRef, useState } from 'react';

// Removal is exclusive with in-flight saves in this view. Different forms may
// still save independently; each form owns its registration through verification.
export const OperationContext = createContext<{
  locked: { current: boolean };
  pending: boolean;
  saves: { current: Set<symbol> };
  acquire: () => boolean;
  release: () => void;
  acquireSave: (owner: symbol) => boolean;
  releaseSave: (owner: symbol) => void;
} | null>(null);

export function useOperations() {
  const shared = useContext(OperationContext);
  const locked = useRef(false);
  const saves = useRef(new Set<symbol>());
  const [pending, setPending] = useState(false);
  const local = {
    locked,
    pending,
    saves,
    acquire: () => {
      if (locked.current || saves.current.size) return false;
      locked.current = true;
      setPending(true);
      return true;
    },
    release: () => {
      locked.current = false;
      setPending(false);
    },
    acquireSave: (owner: symbol) => {
      if (locked.current || saves.current.has(owner)) return false;
      saves.current.add(owner);
      return true;
    },
    releaseSave: (owner: symbol) => {
      saves.current.delete(owner);
    },
  };
  return shared || local;
}
