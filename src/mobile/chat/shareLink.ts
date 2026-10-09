/** Share a link: the native share sheet where there is one, else the clipboard. Must start in a tap. */
export const shareLink = async (p: {
  title: string;
  text: string;
  url: string;
}): Promise<'shared' | 'copied' | 'failed'> => {
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share(p);
      return 'shared';
    } catch {
      // Cancelled, or not allowed: fall through to copy.
    }
  }
  return copyLink(p.url);
};

/**
 * Share text that already ends in "\n<url>" (a Space page / invite): ONLY `text` goes to the share
 * sheet. Passing `title` and `url` as well made targets glue the title onto the link or repeat it.
 * The clipboard fallback copies the same text.
 */
export const shareText = async (text: string): Promise<'shared' | 'copied' | 'failed'> => {
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch {
      // Cancelled, or not allowed: fall through to copy.
    }
  }
  return copyLink(text);
};

export const copyLink = async (url: string): Promise<'copied' | 'failed'> => {
  try {
    await navigator.clipboard?.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
};
