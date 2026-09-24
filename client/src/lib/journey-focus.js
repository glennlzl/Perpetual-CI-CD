import { useCallback, useRef, useState } from 'react';

// Switching between the journey grid and focus mode unmounts the control that was used,
// so keyboard focus follows the journey: into the focused view, then back to its card.
export function createViewFocus() {
  const cards = new Map(), refs = new Map();
  let heading = null, target = null;
  return {
    heading: node => { heading = node; },
    card(id) {
      if (!refs.has(id)) refs.set(id, node => { if (node) cards.set(id, node); else cards.delete(id); });
      return refs.get(id);
    },
    enter() { target = { heading: true }; },
    leave(id) { target = { id }; },
    // Runs after the new view commits; only a user switch moves focus.
    settle() {
      const node = target?.heading ? heading : cards.get(target?.id);
      target = null;
      node?.focus();
      return Boolean(node);
    },
  };
}

// A dialog rendered without a Radix trigger would return focus to <body> on close, so it returns to
// the control that opened it. A menu item is gone once its menu closes; it stands for that menu's trigger.
export function dialogOpener(doc = globalThis.document) {
  const active = doc?.activeElement;
  if (!active || active === doc.body) return null;
  const menu = active.closest?.('[role="menu"]');
  if (!menu) return active;
  const triggers = [...doc.querySelectorAll('[aria-haspopup="menu"]')];
  return triggers.find(node => menu.id && node.getAttribute('aria-controls') === menu.id) || triggers.find(node => node.getAttribute('data-state') === 'open') || null;
}

// The first candidate still in the document that can take focus receives it.
export function restoreFocus(candidates) {
  const target = candidates.find(node => node?.isConnected && typeof node.focus === 'function' && !node.disabled && !node.closest?.('[inert]'));
  target?.focus({ preventScroll: true });
  return target || null;
}

// The opener is read on the dialog's first render, before an autoFocus field moves focus inside it.
// `fallback` names a sensible element when the opener has gone, such as the case card or the sheet.
export function useReturnFocus(fallback) {
  const [opener] = useState(() => dialogOpener());
  const latest = useRef(fallback);
  latest.current = fallback;
  return useCallback(event => {
    event.preventDefault();
    restoreFocus([opener, latest.current?.()]);
  }, [opener]);
}
