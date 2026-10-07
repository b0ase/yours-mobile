import { Sheet } from './Sheet';
import { addable, DOCK_MAX, type DockItem } from './dockModel';
import { itemIcon, itemLabel } from './icons';
import type { Screen } from './screens';

/** Arrange › Add: screens and Send/Receive not in the dock yet. Apps are added from Apps or HOME (touch and hold › Add to Dock). */
export const AddToDockSheet = ({
  items,
  strip,
  labels,
  onAdd,
  onClose,
}: {
  items: DockItem[];
  strip: readonly Screen[];
  labels: Record<string, string>;
  onAdd: (i: DockItem) => void;
  onClose: () => void;
}) => {
  const choices = addable(items, strip);
  const full = items.length >= DOCK_MAX;
  return (
    <Sheet label="Add to the dock" onClose={onClose}>
      <p className="text-base font-bold text-white">Add to the dock</p>
      {full ? (
        <p className="text-sm text-[#98A2B3]">The dock is full ({DOCK_MAX}). Remove something first.</p>
      ) : choices.length === 0 ? (
        <p className="text-sm text-[#98A2B3]">Everything is in the dock already.</p>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          {choices.map((c) => {
            const Icon = itemIcon(c);
            const label = itemLabel(c, labels);
            return (
              <button
                key={label}
                type="button"
                onClick={() => onAdd(c)}
                className="flex flex-col items-center gap-1 bg-transparent border-0"
                aria-label={`Add ${label}`}
              >
                <span className="h-12 w-12 rounded-2xl flex items-center justify-center bg-[#2b2f36]">
                  <Icon size={22} color="#F2F2F0" />
                </span>
                <span className="text-[11px] text-white">{label}</span>
              </button>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-[#98A2B3]">To add an app: on Apps or Home, touch and hold it, then Add to Dock.</p>
      <button onClick={onClose} className="py-2 text-sm text-[#98A2B3] bg-transparent border-0">
        Close
      </button>
    </Sheet>
  );
};
