import { useState } from 'react';
import { ART_TEMPLATES } from '../lib/artTemplates';

/**
 * /m/bmint/notes for everyone but the owner: the Mint's note designs as a showcase. Notes are fixed
 * designs issued only by The Bitcoin Corporation Mint, so there is no designer and no mint button here.
 */
export const NotesShowcase = () => {
  const [open, setOpen] = useState<number | null>(null);
  const big = open === null ? null : ART_TEMPLATES[open];
  return (
    <div className="bm-body bwx-bmint-showcase">
      <div className="bm-hero">
        <span className="bm-chip">Notes</span>
        <h1>
          The Mint&apos;s <span>notes</span>
        </h1>
        <p>Designed and issued by The Bitcoin Corporation Mint.</p>
      </div>
      {big && (
        <figure className="bm-show-big">
          <img src={big.full} alt={big.name} />
          <figcaption>{big.name}</figcaption>
        </figure>
      )}
      <div className="bm-show-grid" aria-label="The Mint's note designs">
        {ART_TEMPLATES.map((t, i) => (
          <button
            key={t.id}
            type="button"
            className={`bm-show${open === i ? ' on' : ''}`}
            onClick={() => setOpen(open === i ? null : i)}
            aria-pressed={open === i}
          >
            <img src={t.thumb} alt={t.name} loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
};

export default NotesShowcase;
