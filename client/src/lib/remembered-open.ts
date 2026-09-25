import { useCallback, useState, type SetStateAction } from 'react';

// Disclosure state for this page session only: leaving the Pipeline for
// Settings and returning keeps what the viewer expanded. Nothing is persisted,
// so a reload starts from the default again.
const remembered = new Map<string, boolean>();
const recall = (key: string, defaultOpen: unknown) => remembered.has(key) ? remembered.get(key)! : Boolean(defaultOpen);

export function useRememberedOpen(key: string, defaultOpen = false): [boolean, (next: SetStateAction<boolean>) => void] {
  const [state, setState] = useState(() => ({ key, open: recall(key, defaultOpen) }));
  // A new key reads its own remembered value instead of inheriting the last one.
  const current = state.key === key ? state : { key, open: recall(key, defaultOpen) };
  if (current !== state) setState(current);
  const setOpen = useCallback((next: SetStateAction<boolean>) => {
    const open = Boolean(typeof next === 'function' ? next(recall(key, defaultOpen)) : next);
    remembered.set(key, open);
    setState({ key, open });
  }, [key, defaultOpen]);
  return [current.open, setOpen];
}
