import { ArrowUp } from 'lucide-react';
import { MAX_INPUT } from './agent';
import { AgentTalkButton } from './AgentTalkButton';
import './askBar.css';

/**
 * The one Ask b chat bar (owner, 12 Oct 2026): gold b (hold to talk) at the left, "Ask b…", send.
 * placement: 'float' = bottom-centre over every Desktop page; 'page' = the /m/ask-b composer (thinner and higher,
 * centred, on Desktop; in the flow on phones); 'inline' = in the flow everywhere.
 */
export const AskBar = ({
  value,
  onChange,
  onSend,
  canSend,
  onTranscript,
  onNote,
  placement,
  autoFocus,
  onFocus,
  status,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  canSend: boolean;
  onTranscript: (t: string) => void;
  onNote: (n: string) => void;
  placement: 'float' | 'page' | 'inline';
  autoFocus?: boolean;
  onFocus?: () => void;
  status?: string;
}) => (
  <form
    className={`askb-bar place-${placement}`}
    onSubmit={(e) => {
      e.preventDefault();
      onSend();
    }}
  >
    <AgentTalkButton onTranscript={onTranscript} onNote={onNote} />
    <textarea
      data-agent-input
      value={value}
      onChange={(e) => onChange(e.target.value.slice(0, MAX_INPUT))}
      onFocus={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onSend();
        }
      }}
      rows={1}
      autoFocus={autoFocus}
      placeholder="Ask b…"
      aria-label="Ask b"
      title={status}
      className="askb-input"
    />
    <button type="submit" aria-label="Send" disabled={!canSend || !value.trim()} className="askb-send">
      <ArrowUp size={16} color="#1a1300" />
    </button>
  </form>
);
