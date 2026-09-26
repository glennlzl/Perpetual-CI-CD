// What the bench writes to disk: the product's redaction (string by string in JSON, so JSON stays JSON), then the
// gateway's scrub, which replaces the real key; so no key reaches a result, an artifact or a case file.
import { redact } from '../../src/providers.ts';

export type Scrub = (text: string) => Promise<string>;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** A JSON value with the product's redaction applied to every string in it. */
export const redactJson = (value: unknown): unknown => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(redactJson)
  : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)])) : value;
/** Text as the bench writes it: redacted, then scrubbed of the key. */
export const safeText = async (content: string | Buffer, scrub: Scrub) => scrub(redact(Buffer.isBuffer(content) ? content.toString('utf8') : content));
/** A JSON value as the bench writes it: every string redacted, then the text scrubbed of the key. */
export const safeJson = async (value: unknown, scrub: Scrub, space?: number) => scrub(JSON.stringify(redactJson(value), null, space));
