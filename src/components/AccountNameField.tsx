import { Theme } from '../theme.types';
import { Input } from './Input';
import { ACCOUNT_NAME_MAX } from '../utils/accountNameRules';

/** Required account name with a visible label and the reason it can't be saved (accountNameRules.ts). */
export const AccountNameField = ({
  theme,
  value,
  onChange,
  error,
}: {
  theme: Theme;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) => (
  <div className="flex w-full flex-col items-center">
    <label
      htmlFor="account-name"
      className="w-[85%] text-left text-xs font-semibold mt-1"
      style={{ color: theme.color.global.gray }}
    >
      Account name <span aria-hidden>(required)</span>
    </label>
    <Input
      theme={theme}
      id="account-name"
      name="account-name"
      placeholder="e.g. Savings"
      type="text"
      autoComplete="off"
      required
      maxLength={ACCOUNT_NAME_MAX}
      aria-invalid={!!error}
      aria-describedby={error ? 'account-name-error' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
    {error && (
      <p
        id="account-name-error"
        role="alert"
        className="w-[85%] m-0 mb-1 text-left text-xs"
        style={{ color: '#F97066' }}
      >
        {error}
      </p>
    )}
  </div>
);
