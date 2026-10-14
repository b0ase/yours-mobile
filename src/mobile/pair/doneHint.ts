/** PairSheet "done" copy outside the extension: send people back to the browser tab they came from. */
export const switchBackHint = (host: string, ios: boolean) =>
  `Now switch back to ${ios ? 'Safari' : 'your browser'} to carry on at ${host}. Keep bWallet open while you use the site.`;
