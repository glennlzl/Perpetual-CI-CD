// The account a browser run or exploration signs in with. A twin's test accounts arrive without passwords
// and are chosen by id; the controller supplies the password. Entered values live only in the dialog.
export const MANUAL = 'manual';
export const NONE = 'none';
const TWIN = 'twin:';

/** Dialog state: the target twin's first test account when it has any, otherwise no account. */
export const initialAccount = (accounts = []) => ({ choice: accounts.length ? `${TWIN}${accounts[0].id}` : NONE, username: '', password: '' });

/** Select options: each twin account by label and username, then manual entry and no account. */
export const accountOptions = (accounts = []) => [
  ...accounts.map(account => ({ value: `${TWIN}${account.id}`, label: account.label, detail: account.username === account.label ? '' : account.username })),
  { value: MANUAL, label: 'Enter manually', detail: '' },
  { value: NONE, label: 'No account', detail: '' },
];

/** One account shares application state, so its journeys run one at a time. */
export const usesAccount = account => account.choice !== NONE;

/** Request fields for the choice: { accountId }, { credentials } or { accountId: null }; or an error to show. */
export function accountRequest(account, accounts = []) {
  if (account.choice === MANUAL) {
    const username = account.username.trim();
    return username && account.password ? { request: { credentials: { username, password: account.password } } } : { error: 'Enter a username and password.' };
  }
  if (account.choice.startsWith(TWIN)) {
    const accountId = account.choice.slice(TWIN.length);
    return accounts.some(item => item.id === accountId) ? { request: { accountId } } : { error: 'Choose a test account.' };
  }
  return { request: { accountId: null } };
}
