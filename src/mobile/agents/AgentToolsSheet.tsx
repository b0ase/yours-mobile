import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, ExternalLink, Terminal, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { openDappBrowser } from '../dappBrowser';

const MUTED = '#98A2B3';
const GOLD = '#F5B800';

const MCP_CONFIG = `{
  "mcpServers": {
    "bwalletx": { "command": "npx", "args": ["-y", "bwalletx", "mcp"] }
  }
}`;

const Code = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-xl p-3 pr-10 font-mono text-[12px] whitespace-pre-wrap break-all" style={{ background: '#17191E', color: '#E4E7EC' }}>
      {text}
      <button
        type="button"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-2 right-2 p-1 border-0 bg-transparent"
      >
        {copied ? <Check size={14} color="#A1FF8B" /> : <Copy size={14} color={MUTED} />}
      </button>
    </div>
  );
};

const Link = ({ href, label }: { href: string; label: string }) => (
  <button
    type="button"
    onClick={() => void openDappBrowser(href)}
    className="flex items-center gap-1 text-xs font-semibold border-0 bg-transparent p-0"
    style={{ color: GOLD }}
  >
    {label} <ExternalLink size={12} />
  </button>
);

/**
 * Account menu › CLI & MCP for agents (owner, 6 Oct 2026): tells people the bWalletX CLI and MCP server exist and how
 * to start. Pairing keeps keys on the phone: the computer asks, this wallet approves within the limits you set.
 */
export const AgentToolsSheet = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: '#010101' }}>
      <div className="flex items-center gap-2 px-4 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 14px)' }}>
        <Terminal size={18} color={GOLD} />
        <span className="flex-1 text-base font-bold text-white">CLI &amp; MCP for agents</span>
        <button type="button" aria-label="Close" onClick={onClose} className="p-1 border-0 bg-transparent">
          <X size={18} color={MUTED} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-10 flex flex-col gap-4">
        <p className="m-0 text-sm" style={{ color: '#D0D5DD' }}>
          Let scripts and AI assistants (Claude, Cursor and others) use a bWalletX <b>agent account</b>. Keys stay on this
          phone: the computer asks, and this wallet approves within the limits you set when pairing.
        </p>
        <div className="flex flex-col gap-2">
          <div className="text-sm font-bold text-white">1. Make an agent account</div>
          <p className="m-0 text-xs" style={{ color: MUTED }}>
            Account menu › Add agent account. Fund it with only what the agent may spend.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-sm font-bold text-white">2. Pair the command line</div>
          <p className="m-0 text-xs" style={{ color: MUTED }}>
            On your computer (Node 20+), run this, then on this phone open the agent account › Settings › Paired websites
            › Scan to connect.
          </p>
          <Code text="npx bwalletx login --account phone" />
          <Code text="npx bwalletx balance --account phone" />
          <Link href="https://bwalletx.com/cli" label="CLI guide" />
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-sm font-bold text-white">3. Connect an AI assistant (MCP)</div>
          <p className="m-0 text-xs" style={{ color: MUTED }}>
            Add this to your assistant&apos;s MCP settings (e.g. Claude Desktop or Cursor) after pairing.
          </p>
          <Code text={MCP_CONFIG} />
          <Link href="https://bwalletx.com/mcp" label="MCP guide" />
        </div>
        <Link href="https://www.npmjs.com/package/bwalletx" label="bwalletx on npm" />
      </div>
    </div>,
    document.body,
  );
};
