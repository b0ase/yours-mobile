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

export const copyLink = async (url: string): Promise<'copied' | 'failed'> => {
  try {
    await navigator.clipboard?.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
};
