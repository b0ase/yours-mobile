/** bwalletx:// is the only scheme Desktop registers (src-tauri/tauri.conf.json); anything else is dropped. */
export const isAppUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'bwalletx:';
  } catch {
    return false;
  }
};
