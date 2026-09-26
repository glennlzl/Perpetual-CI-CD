const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/**
 * The key two rows of the same person share: the address trimmed and lower-cased; at gmail.com and googlemail.com also
 * without dots or a +tag before the @, and at gmail.com. emailKey(' Jane.Doe+news@GoogleMail.com') is
 * 'janedoe@gmail.com'; other domains keep their dots and tags.
 */
export function emailKey(email) {
  const address = String(email ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return address;
  const local = address.slice(0, at), domain = address.slice(at + 1);
  if (!GMAIL.has(domain)) return address;
  return `${local.split('+')[0].replaceAll('.', '')}@gmail.com`;
}
