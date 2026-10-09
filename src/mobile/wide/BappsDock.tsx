import { BAPPS as WALLET_BAPPS } from '../bapps';
import bmusicIcon from '../brand/bmusic-icon.png';
import bvideoIcon from '../brand/bvideo-icon.png';
import tokenblasterIcon from '../brand/apps/tokenblaster.png';

/** Real tile icons from the wallet's own bApps list. */
const ico = (name: string) => WALLET_BAPPS.find((a) => a.name === name)?.icon as string | undefined;

/** PROTOTYPE (demo/desktop-shell): macOS-style dock of bApps along the bottom of the wide main area. */
export type Bapp = {
  id: string;
  name: string;
  url?: string; // undefined → "coming soon"
  icon?: string; // wallet tile icon; otherwise gold monogram
  mono: string;
  soon?: boolean;
};

export const BAPPS: Bapp[] = [
  { id: 'music', name: 'Bitcoin Music', url: 'http://localhost:3027/', icon: bmusicIcon, mono: '♪' },
  { id: 'bmovies', name: 'bMovies', url: 'https://bmovies.app', icon: ico('bMovies'), mono: 'bM' },
  { id: 'bwriter', name: 'bWriter', url: 'https://bitcoin-writer.com/', icon: ico('bWriter'), mono: 'bW' },
  { id: 'bsheets', name: 'bSheets', url: 'https://bitcoin-spreadsheet.vercel.app', icon: ico('bSheets'), mono: 'bS' },
  { id: 'bdrive', name: 'bDrive', url: 'https://bitcoin-drive.vercel.app', icon: ico('bDrive'), mono: 'bD' },
  { id: 'bvideo', name: 'Bitcoin Video', icon: bvideoIcon, mono: 'bV', soon: true },
  { id: 'bchatx', name: 'bChatX', url: 'https://bchatx.com', icon: ico('bChat'), mono: 'bC' },
  { id: 'tokenblaster', name: 'TokenBlaster', url: 'http://localhost:3028/', icon: tokenblasterIcon, mono: 'TB' },
];

export const BappIcon = ({ app, size }: { app: Bapp; size: number }) =>
  app.icon ? (
    <img className="bx-ico" src={app.icon} alt="" width={size} height={size} />
  ) : (
    <span className="bx-ico bx-mono" style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {app.mono}
    </span>
  );

export default function BappsDock({
  current,
  running,
  onPick,
}: {
  current: string;
  running: string[];
  onPick: (id: string) => void;
}) {
  return (
    <div className="bx-dockwrap">
      <nav className="bx-dock" aria-label="bApps dock">
        {BAPPS.map((a) => (
          <button
            key={a.id}
            className={`bx-item${a.soon ? ' soon' : ''}${current === a.id ? ' on' : ''}`}
            onClick={() => onPick(a.id)}
            aria-label={a.name}
          >
            <span className="bx-tip">{a.soon ? `${a.name} · soon` : a.name}</span>
            <BappIcon app={a} size={56} />
            <span className={`bx-dot${running.includes(a.id) ? ' run' : ''}`} />
          </button>
        ))}
      </nav>
    </div>
  );
}
