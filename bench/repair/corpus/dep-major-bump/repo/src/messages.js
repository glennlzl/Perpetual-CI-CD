import render from 'acme-template';
import { TEMPLATES } from './templates.js';

/** The notice of a kind for its data. */
export function notice(kind, data) {
  const template = TEMPLATES[kind];
  if (!template) throw new Error(`Unknown notice ${kind}`);
  return render(template, data);
}
