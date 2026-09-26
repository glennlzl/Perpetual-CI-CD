import { findUser, type User } from './users.js';

/** "Hello, <display name>!" for a known id, and "Hello, guest!" for an unknown one. */
export function greeting(id: string): string {
  const user = findUser(id);
  return `Hello, ${user.name}!`;
}

/** An @-mention: "@" and the first word of the display name, in lower case. */
export function mention(user: User): string {
  return `@${user.name.split(' ')[0].toLowerCase()}`;
}
