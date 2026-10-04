/**
 * Save a small text file from the app. Phones (Capacitor WebViews) often ignore <a download>, so try
 * the share sheet with a file first (Save to Files / AirDrop / Drive), then fall back to a download link.
 */
export const saveTextFile = async (name: string, text: string, type = 'application/json') => {
  const file = new File([text], name, { type });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // the user closed the sheet
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
