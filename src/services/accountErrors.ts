/** Add account › Restore of a phrase or key the wallet already holds (it used to overwrite the account silently). */
export class AccountExistsError extends Error {
  constructor() {
    super('Account already added');
    this.name = 'AccountExistsError';
  }
}
