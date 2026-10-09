import { useState } from 'react';
import BappsDock, { BAPPS, BappIcon } from './BappsDock';
import './bapps.css';

/** PROTOTYPE (demo/desktop-shell): bApps page — selected bApp in an iframe above a dock. */
export default function BappsPage() {
  const [current, setCurrent] = useState('music');
  const [running, setRunning] = useState<string[]>(['music']);
  const app = BAPPS.find((a) => a.id === current) ?? BAPPS[0];
  const pick = (id: string) => {
    setCurrent(id);
    const a = BAPPS.find((x) => x.id === id);
    if (a?.url && !running.includes(id)) setRunning((r) => [...r, id]);
  };
  const close = () => {
    const rest = running.filter((r) => r !== current);
    setRunning(rest);
    setCurrent(rest[rest.length - 1] ?? 'music');
  };
  return (
    <div className="bx-page">
      <div className="bx-window">
        <div className="bx-title">
          <BappIcon app={app} size={22} />
          <span className="bx-name">{app.name}</span>
          <span className="bx-url">{app.url ?? 'coming soon'}</span>
          {app.url && (
            <a className="bx-btn" href={app.url} target="_blank" rel="noreferrer" title="Open in new tab">
              ↗
            </a>
          )}
          <button className="bx-btn" onClick={close} title="Close">
            ✕
          </button>
        </div>
        <div className="bx-body">
          {BAPPS.filter((a) => a.url && running.includes(a.id)).map((a) => (
            <iframe
              key={a.id}
              title={a.name}
              src={a.url}
              style={{ display: a.id === current ? 'block' : 'none' }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              allow="autoplay; microphone"
            />
          ))}
          {!app.url && (
            <div className="bx-soon">
              <BappIcon app={app} size={88} />
              <h2>{app.name}</h2>
              <p>Coming soon to bWalletX.</p>
            </div>
          )}
        </div>
      </div>
      <BappsDock current={current} running={running} onPick={pick} />
    </div>
  );
}
