import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { PersonPic } from './PersonPic';

/**
 * Wide layout, Chat: the third column beside the open room (wide.css .ww-room-details). Members, the token gate
 * and the room's live Space, from what the room already loaded; nothing is fetched here.
 */
export const RoomDetails = ({
  title,
  kind,
  members,
  voices,
  gate,
  space,
  actions,
}: {
  title: string;
  kind: string;
  members: number;
  /** Handles seen in the loaded messages, most recent first. */
  voices: string[];
  gate: { symbol: string; min: string; hold: string } | null;
  /** The live Space card (spaces/LiveBanner), when the room can have one. */
  space: ReactNode;
  actions: ReactNode;
}) => {
  const others = voices.filter((h) => h.toLowerCase() !== 'b');
  return createPortal(
    <aside className="ww-room-details" aria-label="Room details">
      <section>
        <div className="ww-rd-title">{title}</div>
        <div className="ww-rd-sub">{kind}</div>
        {actions && <div className="ww-rd-actions">{actions}</div>}
      </section>
      {space && (
        <section>
          <h3>Live</h3>
          {space}
        </section>
      )}
      {gate && (
        <section>
          <h3>Token gate</h3>
          <dl className="ww-rd-dl">
            <dt>Token</dt>
            <dd>{gate.symbol}</dd>
            <dt>To enter</dt>
            <dd>{gate.min}</dd>
            <dt>You hold</dt>
            <dd>{gate.hold}</dd>
          </dl>
        </section>
      )}
      <section>
        <h3>
          Members <span className="ww-rd-count">{members}</span>
        </h3>
        {/* $b, the assistant, heads every room's list, posted or not (owner, 18 Oct 2026). */}
        <ul className="ww-rd-people">
          <li>
            <PersonPic className="ww-rd-av" handle="b" />
            <span>
              $b <span className="ww-rd-role">· assistant</span>
            </span>
          </li>
        </ul>
        {others.length ? (
          <>
            <div className="ww-rd-note">Recently active here</div>
            <ul className="ww-rd-people">
              {others.map((h) => (
                <li key={h}>
                  <PersonPic className="ww-rd-av" handle={h} />${h}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="ww-rd-note">No messages loaded yet.</div>
        )}
      </section>
    </aside>,
    document.body,
  );
};
