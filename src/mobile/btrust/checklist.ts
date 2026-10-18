/** bTrust Live/Coming checklist (pages show status). Tick items here as they ship. */
export const BTRUST_CHECKLIST: { label: string; live: boolean }[] = [
  { label: 'Recovery slices: 2-of-3 or any n-of-m, as QR and text cards', live: true },
  { label: 'Restore from any two slices, on this device', live: true },
  { label: 'Passing on: inheritance plan and lock script (owner, 2 of 3 heirs, lead heir)', live: true },
  { label: 'Important papers: seal and open with your slices', live: true },
  { label: 'Fund the inheritance lock from your wallet', live: false },
  { label: 'Check in (re-lock with a later date) in one tap', live: false },
  { label: 'Heirs claim from their own bWalletX', live: false },
  { label: 'Look up heir keys from their paymail', live: false },
  { label: 'Paper fingerprints recorded on chain', live: false },
  { label: 'Attorneys as extra key holders', live: false },
];
