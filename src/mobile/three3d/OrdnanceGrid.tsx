import { lazy, Suspense, useEffect, useState } from 'react';
import { Box } from 'lucide-react';
import { cachedExchangeRate } from '../../utils/wallet';
import ModelThumb from './ModelThumb';
import { loadWeapons, RARITY_COLOR, type Weapon } from './ordnance';

// three.js only loads when someone opens a cabinet.
export const LazyCabinet = lazy(() => import('./Cabinet'));

const price = (sats: number) => {
  const rate = cachedExchangeRate();
  return rate > 0 ? `$${((sats / 1e8) * rate).toFixed(2)}` : `${sats / 1e8} BSV`;
};

/** Square tile: the gun's art with a 3D badge and rarity edge. */
export const WeaponTile = ({ weapon, onOpen, sub }: { weapon: Weapon; onOpen: () => void; sub?: string }) => (
  <button
    type="button"
    onClick={onOpen}
    className="relative rounded-xl overflow-hidden bg-[#17191E] text-left p-0"
    style={{ aspectRatio: '1/1', border: `1px solid ${RARITY_COLOR[weapon.rarity]}55` }}
  >
    {weapon.image ? (
      <img src={weapon.image} alt={weapon.name} loading="lazy" className="w-full h-full object-cover" />
    ) : (
      // The manifest has no art for any gun now (image: null): a rendered still of the model, Box if that fails.
      <ModelThumb
        url={weapon.model}
        cacheKey={`ordnance:${weapon.id}:${weapon.model}`}
        opts={{ tint: weapon.tint, tintAmount: weapon.tintAmount ?? 0.22, turn: weapon.flip ? Math.PI : 0 }}
        alt={weapon.name}
        fallback={
          <div className="w-full h-full flex items-center justify-center" style={{ color: RARITY_COLOR[weapon.rarity] }}>
            <Box size={44} />
          </div>
        }
      />
    )}
    <span
      className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-bold"
      style={{ background: '#000000aa', color: '#F5B800' }}
    >
      <Box size={10} /> 3D
    </span>
    <div className="absolute bottom-0 inset-x-0 bg-black/65 px-2 py-1">
      <div className="text-[11px] font-semibold text-white truncate">{weapon.name}</div>
      <div className="text-[10px] truncate" style={{ color: RARITY_COLOR[weapon.rarity] }}>
        {sub ?? weapon.rarity}
      </div>
    </div>
  </button>
);

/** Exchange › 3D: the 1Sat Ordnance catalogue from tokenblaster.lol. Tap a gun to see it in 3D and buy it there. */
export const OrdnanceGrid = () => {
  const [weapons, setWeapons] = useState<Weapon[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Weapon | null>(null);

  useEffect(() => {
    loadWeapons()
      .then(setWeapons)
      .catch(() => setError(true));
  }, []);

  if (error)
    return (
      <p className="text-xs text-center py-8 text-[#98A2B3]">Couldn&apos;t load the 3D catalogue. Try again later.</p>
    );
  if (!weapons) return <p className="text-xs text-center py-8 text-[#98A2B3]">Loading 3D NFTs…</p>;

  return (
    <div className="flex flex-col gap-2 pb-24">
      <p className="m-0 text-xs text-[#98A2B3]">
        1Sat Ordnance by tokenblaster.lol: game guns as 1Sat NFTs. Owning one unlocks it in Double-O Satoshi and the Arena.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {weapons.map((w) => (
          <WeaponTile key={w.id} weapon={w} onOpen={() => setOpen(w)} sub={`${w.rarity} · ${price(w.priceSats)}`} />
        ))}
      </div>
      {open && (
        <Suspense fallback={null}>
          <LazyCabinet weapon={open} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </div>
  );
};
