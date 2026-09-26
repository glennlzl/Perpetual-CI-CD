export interface User {
  id: string;
  /** The name people see, such as "Ada Lovelace". Called `name` before 2.0. */
  displayName: string;
}

const USERS: readonly User[] = [
  { id: 'u1', displayName: 'Ada Lovelace' },
  { id: 'u2', displayName: 'Grace Hopper' },
];

/** The user with this id, or undefined when there is none. Callers greet an unknown id as a guest. */
export function findUser(id: string): User | undefined {
  return USERS.find(user => user.id === id);
}
