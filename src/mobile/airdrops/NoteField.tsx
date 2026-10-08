/** "Note to holders" on token Send (owner, 8 Oct 2026): ≤280 characters, written on chain in the same tx (note.ts). */
import { NOTE_MAX, cleanNote, noteCharsLeft } from './note';

export const NoteField = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  const left = noteCharsLeft(value);
  const bad = value.trim() !== '' && !cleanNote(value);
  return (
    <label className="flex flex-col gap-1 w-full">
      <span className="text-xs font-semibold" style={{ color: '#98A2B3' }}>
        Note to holders (optional)
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={NOTE_MAX * 2}
        placeholder="Say why you're sending this. Plain text, public, on chain."
        className="w-full rounded-xl px-3 py-2 text-sm outline-none resize-none"
        style={{ background: '#17191E', color: '#fff', border: `1px solid ${bad ? '#F97066' : '#2b2f36'}` }}
      />
      <span className="text-[10px] self-end" style={{ color: left < 0 || bad ? '#F97066' : '#667085' }}>
        {bad && left >= 0 ? 'Plain text only' : `${left} left`}
      </span>
    </label>
  );
};
