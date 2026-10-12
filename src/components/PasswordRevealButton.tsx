import { RefObject } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export type PasswordRevealButtonProps = {
  shown: boolean;
  onToggle: () => void;
  /** The password input: its caret and selection survive the type switch. */
  inputRef: RefObject<HTMLInputElement | null>;
  color?: string;
  size?: number;
};

/**
 * The eye inside every password field (unlock, create, restore, change password). A plain
 * type="button" so Enter in the field still submits the form; pressing it with the mouse or a
 * finger never takes focus from the field, and the caret stays where it was.
 */
export const PasswordRevealButton = ({
  shown,
  onToggle,
  inputRef,
  color = '#98A2B3',
  size = 16,
}: PasswordRevealButtonProps) => {
  const toggle = () => {
    const input = inputRef.current;
    const focused = !!input && document.activeElement === input;
    const start = input?.selectionStart ?? null;
    const end = input?.selectionEnd ?? null;
    onToggle();
    if (!input || !focused || start === null || end === null) return;
    // Switching type can reset the selection: put it back once React has re-rendered.
    requestAnimationFrame(() => {
      try {
        input.setSelectionRange(start, end);
      } catch {
        // Some input types reject selection ranges; nothing to restore.
      }
    });
  };
  return (
    <button
      type="button"
      aria-label={shown ? 'Hide password' : 'Show password'}
      aria-pressed={shown}
      title={shown ? 'Hide password' : 'Show password'}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.preventDefault()}
      onClick={toggle}
      className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-7 h-7 p-0 bg-transparent border-0 cursor-pointer rounded-md"
      style={{ color }}
    >
      {shown ? <EyeOff size={size} aria-hidden /> : <Eye size={size} aria-hidden />}
    </button>
  );
};
