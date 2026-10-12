import { useState } from 'react';
import { thumbOrFullUrls } from '../market/thumbs';

/** A token's icon (an on-chain outpoint), trying the thumbnail then each content host; a gold initial otherwise. */
export const TokenIcon = ({
  icon,
  sym,
  size = 32,
}: {
  icon: string | null | undefined;
  sym: string;
  size?: number;
}) => {
  const urls = thumbOrFullUrls(icon, 96);
  const [i, setI] = useState(0);
  const box = { width: size, height: size };
  if (i < urls.length)
    return (
      <img
        src={urls[i]}
        alt=""
        style={box}
        className="rounded-full object-cover shrink-0"
        onError={() => setI(i + 1)}
      />
    );
  return (
    <span
      style={{
        ...box,
        background: 'linear-gradient(135deg, #de973f, #f9dd63)',
        color: '#1a1300',
        fontSize: size * 0.45,
      }}
      className="rounded-full grid place-items-center font-extrabold shrink-0"
    >
      {(sym.replace(/^\$/, '')[0] ?? '?').toUpperCase()}
    </span>
  );
};
