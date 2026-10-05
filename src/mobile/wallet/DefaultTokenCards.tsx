import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { routeFor } from '../tabs/tabs';
import { getBsv21Balances } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { AssetRow } from '../../components/AssetRow';
import { getPersonalLink, onPersonalChange } from '../names/personalToken';
import { PNEE_DECIMALS, PNEE_ICON, PNEE_TOKEN_ID, unindexedPnee } from '../notes/pnee';
import { BackPneeSheet } from '../notes/BackPneeSheet';
import bGlyph from '../brand/bwallet-glyph.svg';

type Bal = { id: string; amount: number; icon: string | null };

/**
 * Wallet › default balances under BSV and MNEE (owner, 5 Oct 2026): Penny Notes ($PNEE, shown in dollars) and, while
 * you hold none of it, the account's own $HANDLE token, so the cards people care about are always there.
 */
export const DefaultTokenCards = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const addrs = chromeStorageService.getCurrentAccountObject().account?.addresses;
  const id = addrs?.identityAddress;
  // While the 1Sat overlay misses PNEE transfers, fall back to GorillaPool's count, labelled as indexing.
  const [pending, setPending] = useState(0);
  const [link, setLink] = useState(() => getPersonalLink(id));
  const [bals, setBals] = useState<Bal[]>([]);
  const [backing, setBacking] = useState(false);
  useEffect(() => onPersonalChange(() => setLink(getPersonalLink(id))), [id]);
  useEffect(() => {
    if (!apiContext) return;
    let live = true;
    void getBsv21Balances
      .execute(apiContext, {})
      .then((rows) => {
        if (!live) return;
        setBals(
          rows
            .filter((r) => r.id)
            .map((r) => ({
              id: r.id!,
              amount: Number(r.all.confirmed) / 10 ** (r.dec ?? 0),
              icon: r.icon ? `https://ordfs.network/${r.icon}` : null,
            })),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [apiContext, link?.tokenId]);

  const of = (tokenId: string) => bals.find((b) => b.id === tokenId);
  const indexed = PNEE_TOKEN_ID ? (of(PNEE_TOKEN_ID)?.amount ?? 0) : 0;
  useEffect(() => {
    if (indexed > 0 || !addrs) return;
    let live = true;
    void unindexedPnee([addrs.bsvAddress, addrs.ordAddress, addrs.identityAddress]).then((n) => live && setPending(n));
    return () => {
      live = false;
    };
  }, [indexed, addrs?.bsvAddress, addrs?.ordAddress, addrs?.identityAddress]); // eslint-disable-line react-hooks/exhaustive-deps
  const pnee = indexed > 0 ? indexed : pending;
  const mine = link ? of(link.tokenId) : undefined;
  const sub = (text: string) => (
    <span className="text-xs mt-0.5" style={{ color: theme.color.global.gray }}>
      {text}
    </span>
  );

  return (
    <>
      {backing && <BackPneeSheet onClose={() => setBacking(false)} />}
      <AssetRow
        icon={PNEE_ICON}
        ticker="PNEEs · Penny Stablecoins"
        balance={pnee}
        decimals={PNEE_DECIMALS}
        usdBalance={pnee}
        showPointer={false}
        subline={indexed === 0 && pending > 0 ? sub('Indexing · can send once indexed') : undefined}
        // Buy PNEE on the right, like Buy MNEE, once the token exists (Exchange › Bonds lists notes and vaults).
        action={PNEE_TOKEN_ID ? { label: 'Buy PNEEs', onClick: () => navigate(routeFor('market') ?? '/m/market') } : undefined}
        // Back PNEEs sits on the right next to Buy PNEEs (owner, 5 Oct 2026).
        secondaryAction={{ label: 'Back PNEEs', onClick: () => setBacking(true) }}
      />
      {/* Held tokens already have a row in the token list below (with the issuer badge): only show it here at 0. */}
      {link && !(mine && mine.amount > 0) && (
        <AssetRow
          icon={mine?.icon ?? bGlyph}
          ticker={`$${link.ticker.replace(/^\$/, '')}`}
          balance={mine?.amount ?? 0}
          decimals={0}
          usdBalance={0}
          showPointer={false}
          subline={sub('Your token')}
        />
      )}
    </>
  );
};
