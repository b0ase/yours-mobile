import { sortedRecipients } from '../../services/permissionBundle';

/** Past this many outputs the list scrolls inside the sheet; every row is still there (0xrard #2). */
export const RECIPIENTS_SHOWN = 12;
const ROW_PX = 17;

/**
 * Where the payment goes (N3-3): every output, largest first, so the biggest payees always lead and none is cut off.
 * The site picks the output order, so a capped list let dust outputs push the real payee out of sight (b-Aware
 * 6 Nov 2026, 0xrard #2). A long list scrolls and says how many outputs and how much in all.
 */
export const PaymentRecipients = ({ recipients }: { recipients?: { to: string; satoshis: number }[] }) => {
  if (!recipients) return null;
  const rows = sortedRecipients(recipients);
  if (rows.length === 0) return <li data-testid="pay-recipient">no outputs: only the network fee</li>;
  const items = rows.map((x, i) => (
    <li key={`to-${i}`} data-testid="pay-recipient">
      to {x.to}: {x.satoshis.toLocaleString()} sats
    </li>
  ));
  if (rows.length <= RECIPIENTS_SHOWN) return <>{items}</>;
  const total = rows.reduce((s, x) => s + x.satoshis, 0);
  return (
    <li data-testid="pay-recipients-all">
      {rows.length.toLocaleString()} outputs, {total.toLocaleString()} sats in all, largest first:
      <ul
        className="m-0 pl-4"
        style={{ maxHeight: RECIPIENTS_SHOWN * ROW_PX, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {items}
      </ul>
    </li>
  );
};
