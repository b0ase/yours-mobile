import { defineConfig, loadEnv, mergeConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';
import { readFileSync, renameSync } from 'fs';
import baseConfig from './vite.config.base';
import { brand as sharedBrand, bcorpText, bcorpColours, brandDefines } from './vite.brand';

// BWALLET_* build settings (fee addresses etc.) may live in a gitignored .env.local; the shell wins.
for (const [k, v] of Object.entries(loadEnv(process.env.NODE_ENV ?? 'production', __dirname, 'BWALLET_'))) {
  process.env[k] ??= v;
}

/**
 * Mobile (Capacitor) build. One WebView hosts the popup UI (mobile.html →
 * index.html), the background as a Web Worker, and the extension's other
 * pages as overlay iframes. Output: build-mobile/ (Capacitor webDir).
 */

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

const polyfills = () =>
  nodePolyfills({
    include: ['buffer', 'process', 'util', 'stream', 'crypto', 'assert', 'url', 'path'],
    globals: { Buffer: true, process: true },
  });

// Overlay pages get their chrome shim from the top window before any module runs.
const FRAME_SHIM = `<script>(function(){var m=window.parent!==window&&window.parent.__yoursMobile;if(m){Object.defineProperty(window,'chrome',{value:m.attachFrame(window),writable:true,configurable:true});window.__yoursPlatform=window.parent.__yoursPlatform;}})();</script>`;

// Brand plugins (brand(), bcorpText(), bcorpColours()) are shared with the
// extension build: see vite.brand.ts. Mobile adds its own theme, tab bar and
// top nav swaps on top.
export const MOBILE_SWAPS: Record<string, string> = {
  [resolve(__dirname, 'src/theme.ts')]: resolve(__dirname, 'src/mobile/brand/theme.ts'),
  // Mobile tab bar: Wallet · Market · Apps · Feed · Chat (src/mobile/tabs).
  [resolve(__dirname, 'src/components/BottomMenu.tsx')]: resolve(__dirname, 'src/mobile/tabs/BottomMenu.tsx'),
  [resolve(__dirname, 'src/hooks/useBottomMenu.tsx')]: resolve(__dirname, 'src/mobile/tabs/useBottomMenu.tsx'),
  // Account drawer (Phantom-style) in place of the dropdown + GitHub button.
  [resolve(__dirname, 'src/components/TopNav.tsx')]: resolve(__dirname, 'src/mobile/tabs/TopNav.tsx'),
};
const brand = () => sharedBrand(MOBILE_SWAPS);

// All mobile builds: mount the mobile-only tab routes (/m/settings, /m/media,
// /m/market) in upstream's router without editing App.tsx. Same must-match rule.
const MOBILE_TEXT: Record<string, [string, string][]> = {
  // "Forgot password? Restore with recovery phrase" under Unlock (src/mobile/forgot).
  'src/components/UnlockWallet.tsx': [
    [
      "import { QuickUnlock } from './QuickUnlock';",
      "import { QuickUnlock } from './QuickUnlock';\nimport { ForgotPassword } from '../mobile/forgot/ForgotPassword';",
    ],
    [
      '{!usbEnabled && <QuickUnlock theme={theme} onUnlock={onUnlock} />}',
      '{!usbEnabled && <QuickUnlock theme={theme} onUnlock={onUnlock} />}\n<ForgotPassword theme={theme} />',
    ],
  ],
  // Token page: "Room" opens that token's chatroom in the Chat tab (src/mobile/chat, docs/TOKEN-ROOMS.md).
  'src/components/SendBsv21View.tsx': [
    [
      "import { CoinHistory } from './CoinHistory';",
      "import { CoinHistory } from './CoinHistory';\nimport { OpenTokenRoomButton } from '../mobile/chat/OpenTokenRoomButton';",
    ],
    [
      '{/* Action buttons */}\n            <div className="flex gap-2 mt-1">',
      '{/* Action buttons */}\n            <div className="flex gap-2 mt-1">\n<OpenTokenRoomButton id={token.info.id} />',
    ],
  ],
  // Wallet tab: gold "Mint" beside Receive / Send (src/mobile/mint).
  'src/pages/BsvWallet.tsx': [
    [
      "import { getPlatform } from '../platform';",
      "import { getPlatform } from '../platform';\nimport { MintButton } from '../mobile/mint/MintButton';\nimport { SectionBoundary } from '../mobile/wallet/SectionBoundary';",
    ],
    [
      '            Send\n          </motion.button>\n        </motion.div>',
      '            Send\n          </motion.button>\n<SectionBoundary name="Mint"><MintButton exchangeRate={exchangeRate} /></SectionBoundary>\n        </motion.div>',
    ],
    // Button order: Send · Receive · Mint (flex order; upstream renders Receive first).
    [
      "onClick={() => setPageState('receive')}\n            className=\"flex flex-1",
      "onClick={() => setPageState('receive')}\n            className=\"order-2 flex flex-1",
    ],
    [
      "onClick={() => setPageState('asset-picker')}\n            className=\"flex flex-1",
      "onClick={() => setPageState('asset-picker')}\n            className=\"order-1 flex flex-1",
    ],
    // Credits row under the action buttons: balance, Top up, history (src/mobile/credits).
    [
      "import { MintButton } from '../mobile/mint/MintButton';",
      "import { MintButton } from '../mobile/mint/MintButton';\nimport { CreditsRow } from '../mobile/credits/CreditsRow';",
    ],
    // Send to a name: $handle / paymail / OpNS recipient box with resolve + confirm (src/mobile/names).
    [
      "import { MintButton } from '../mobile/mint/MintButton';",
      "import { MintButton } from '../mobile/mint/MintButton';\nimport { NameInput } from '../mobile/names/NameInput';\nimport { ReceiveName } from '../mobile/names/MyNameBadge';",
    ],
    [
      `<Input
                theme={theme}
                placeholder="Enter Address or Paymail"
                type="text"
                onChange={(e) => updateRecipient(recipient.id, 'address', e.target.value)}
                value={recipient.address}
              />`,
      `<NameInput
                theme={theme}
                asset="bsv"
                onChange={(v) => updateRecipient(recipient.id, 'address', v)}
                value={recipient.address}
              />`,
    ],
    // Receive screen shows the account's name.
    [
      '          Receive Assets\n        </h2>\n      </div>',
      '          Receive Assets\n        </h2>\n      </div>\n<ReceiveName identityAddress={identityAddress} />',
    ],
    // "Choose your handle" after create / restore, else a dismissible "Get your $name" card (src/mobile/names).
    [
      "import { CreditsRow } from '../mobile/credits/CreditsRow';",
      "import { CreditsRow } from '../mobile/credits/CreditsRow';\nimport { HandleOnboarding } from '../mobile/names/HandleOnboarding';\nimport { SweepPrompt } from '../mobile/sweep/SweepPrompt';",
    ],
    // Under Receive / Send / Mint, outside the Tokens / NFTs / Credits gates so it shows on every view.
    [
      '</SectionBoundary>\n        </motion.div>',
      '</SectionBoundary>\n        </motion.div>\n<SectionBoundary name="Handle"><HandleOnboarding /></SectionBoundary>\n<SectionBoundary name="Sweep"><SweepPrompt /></SectionBoundary>',
    ],
  ],
  // New wallet / new account: flag the "Choose your handle" step (shown on the Wallet tab after Enter reloads).
  'src/pages/onboarding/CreateAccount.tsx': [
    // Avatar: "Add a photo" (or an NFT id / link) instead of upstream's Icon URL box (names/AccountIconField.tsx).
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { AccountIconField } from '../../mobile/names/AccountIconField';",
    ],
    [
      '        <Input\n          theme={theme}\n          placeholder="Icon URL"\n          type="text"\n          value={iconURL}\n          onChange={(e) => setIconURL(e.target.value)}\n        />',
      '        <AccountIconField value={iconURL} onChange={setIconURL} />',
    ],
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { markHandlePrompt } from '../../mobile/names/handlePrompt';",
    ],
    [
      '      setStep(2);\n    } catch',
      "      markHandlePrompt(keys.identityAddress, 'create');\n      setStep(2);\n    } catch",
    ],
  ],
  // WIF / JSON import and master (zip) restore: same step for the imported account, after the name sync.
  'src/pages/onboarding/ImportAccount.tsx': [
    // Avatar: "Add a photo" (or an NFT id / link) instead of upstream's Icon URL box (names/AccountIconField.tsx).
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { AccountIconField } from '../../mobile/names/AccountIconField';",
    ],
    [
      '        <Input\n          theme={theme}\n          placeholder="Icon URL"\n          type="text"\n          value={iconURL}\n          onChange={(e) => setIconURL(e.target.value)}\n        />',
      '        <AccountIconField value={iconURL} onChange={setIconURL} />',
    ],
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { markHandlePrompt } from '../../mobile/names/handlePrompt';",
    ],
    [
      '      await chromeStorageService.switchAccount(keys.identityAddress || identityPk);\n',
      "      await chromeStorageService.switchAccount(keys.identityAddress || identityPk);\n      markHandlePrompt(keys.identityAddress, 'restore');\n",
    ],
  ],
  'src/pages/onboarding/MasterRestore.tsx': [
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { markHandlePrompt } from '../../mobile/names/handlePrompt';",
    ],
    [
      "      addSnackbar('Wallet restored successfully!', 'success');\n",
      "      addSnackbar('Wallet restored successfully!', 'success');\n      markHandlePrompt(chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress, 'restore');\n",
    ],
  ],
  // Restore: same step, shown only if the restored account has no name after the name sync.
  'src/pages/onboarding/RestoreAccount.tsx': [
    // Colour on the RelayX tile (white mark on its #2669FF blue) and Twetch's real icon (its brand is monochrome).
    [
      "import relayXLogo from '../../assets/relayx.svg';",
      "import relayXLogo from '../../mobile/brand/restore/relayx.svg';",
    ],
    [
      "import twetchLogo from '../../assets/twetch.svg';",
      "import twetchLogo from '../../mobile/brand/apps/twetch.png';",
    ],
    // Restore › SimplyCash: create a bWallet, then sweep the SimplyCash wallet into it (src/mobile/sweep).
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { clearSweepPrompt, markSweepPrompt } from '../../mobile/sweep/sweepPending';\nimport simplycashLogo from '../../mobile/brand/simplycash.png';",
    ],
    [
      "    {\n      id: 'other',\n      label: 'Other',",
      "    {\n      id: 'simplycash' as SupportedWalletImports,\n      label: 'SimplyCash',\n      logo: <img src={simplycashLogo} alt=\"SimplyCash\" style={{ width: '2.25rem', height: '2.25rem', borderRadius: '0.5rem' }} />,\n    },\n    {\n      id: 'other',\n      label: 'Other',",
    ],
    [
      '  const handleWalletSelection = (wallet?: SupportedWalletImports) => {\n    setImportWallet(wallet);',
      "  const handleWalletSelection = (wallet?: SupportedWalletImports) => {\n    // SimplyCash spreads coins over many addresses: make a bWallet, then sweep into it (src/mobile/sweep).\n    if (wallet === ('simplycash' as SupportedWalletImports)) {\n      markSweepPrompt('simplycash');\n      newWallet ? navigate('/create-wallet') : onNavigateBack('create-account');\n      return;\n    }\n    // Any other choice: no SimplyCash sweep after this restore (sweepPending.ts).\n    clearSweepPrompt();\n    setImportWallet(wallet);",
    ],
    // Avatar: "Add a photo" (or an NFT id / link) instead of upstream's Icon URL box (names/AccountIconField.tsx).
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { AccountIconField } from '../../mobile/names/AccountIconField';",
    ],
    [
      '        <Input\n          theme={theme}\n          placeholder="Icon URL"\n          type="text"\n          value={iconURL}\n          onChange={(e) => setIconURL(e.target.value)}\n        />',
      '        <AccountIconField value={iconURL} onChange={setIconURL} />',
    ],
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { markHandlePrompt } from '../../mobile/names/handlePrompt';",
    ],
    ['      setStep(4);\n', "      markHandlePrompt(keys.identityAddress, 'restore');\n      setStep(4);\n"],
  ],
  // Obsidian UI (Direction A): Wallet home restyle. Classes styled in src/mobile/mobile.css.
  'src/pages/BsvWallet.tsx#obsidian': [
    [
      "import { getPlatform } from '../platform';",
      "import { getPlatform } from '../platform';\nimport { WalletCard } from '../mobile/wallet/WalletCard';",
    ],
    // Account avatar lives in the top bar (gold ring); the home starts with the balance label.
    [
      `        {/* ── Profile avatar ── */}
        <Show when={avatarReady}>`,
      `        {/* ── Profile avatar ── */}
        <Show when={avatarReady && false}>`,
    ],
    [
      '          className="flex flex-col items-center mt-1"\n        >\n          <div className="flex items-center gap-2">',
      '          className="hidden"\n        >\n          <div className="flex items-center gap-2">',
    ],
    // Balance as a membership card (src/mobile/wallet/WalletCard); the old balance block below it is hidden.
    [
      '        {/* ── USD balance ── */}',
      '<SectionBoundary name="Card"><WalletCard usd={bsvBalance * exchangeRate + (services.mnee ? mneeBalance : 0)} sats={Math.round(bsvBalance * 100_000_000)} view={balanceView({ loading: balanceLoading, failed: balanceFailed, known: balanceKnown })} syncing={isSyncing} failed={balanceFailed} onRetry={() => void getAndSetBsvBalance()} receiveAddress={receiveAddress} /></SectionBoundary>\n        {/* ── USD balance ── */}',
    ],
    [
      'className="text-4xl font-bold tracking-tight select-none"',
      'className="text-4xl font-bold tracking-tight select-none bw-balance-amount"',
    ],
    // Receive / Send: gold gradient pills with glow.
    [
      'items-center justify-center gap-2 py-3 rounded-2xl font-semibold text-sm border-0 outline-none cursor-pointer"',
      'items-center justify-center gap-2 py-3 rounded-2xl font-semibold text-sm border-0 outline-none cursor-pointer bw-pill bw-pill-gold"',
    ],
    ['className="flex items-center gap-4 mt-6 w-[88%]"', 'className="flex items-center gap-3 mt-6 w-[90%]"'],
    // Section label.
    [
      '              Assets\n            </span>\n            <div className="flex-1 ml-3 h-px opacity-20" style={{ backgroundColor: theme.color.global.gray }} />',
      '              Tokens\n            </span>',
    ],
  ],
  // Pull to refresh replaces the balance refresh icon (src/mobile/ui/PullToRefresh).
  'src/pages/BsvWallet.tsx#ptr': [
    [
      "import { getPlatform } from '../platform';",
      "import { getPlatform } from '../platform';\nimport { PullToRefresh } from '../mobile/ui/PullToRefresh';\nimport { VideoBackground } from '../mobile/ui/VideoBackground';\nimport walletBg from '../mobile/brand/bg/wallet-card.mp4';\nimport walletPoster from '../mobile/brand/bg/wallet-card.jpg';",
    ],
    [
      "        style={{ minHeight: '100%' }}\n      >\n        {/* ── Legacy migration banner ── */}",
      "        style={{ minHeight: '100%' }}\n      >\n<PullToRefresh onRefresh={() => refreshUtxos({ notifyIfUnchanged: true })} />\n<VideoBackground src={walletBg} poster={walletPoster} scrim='dark' position='fixed' />\n        {/* ── Legacy migration banner ── */}",
    ],
    [
      'className="flex flex-col items-center w-full pt-14 pb-16 overflow-y-auto"',
      'className="isolate flex flex-col items-center w-full pt-14 pb-16 overflow-y-auto"',
    ],
    [
      '            {!isSyncing && !balanceLoading && (\n              <motion.button',
      '            {false && !isSyncing && !balanceLoading && (\n              <motion.button',
    ],
  ],
  // Own tokens with an unpaid indexing fee: cards under the action buttons (src/mobile/tokens/WalletIndexing).
  'src/pages/BsvWallet.tsx#indexing': [
    [
      "import { getPlatform } from '../platform';",
      "import { getPlatform } from '../platform';\nimport { WalletIndexing } from '../mobile/tokens/WalletIndexing';",
    ],
    [
      '<MintButton exchangeRate={exchangeRate} /></SectionBoundary>\n        </motion.div>',
      '<MintButton exchangeRate={exchangeRate} /></SectionBoundary>\n        </motion.div>\n<SectionBoundary name="Indexing"><WalletIndexing exchangeRate={exchangeRate} /></SectionBoundary>',
    ],
  ],
  // UnlockWallet: bigger b mark above "Welcome back" (YoursIcon shows the b+x in bWalletX builds).
  'src/components/UnlockWallet.tsx#logo': [['<YoursIcon width="4rem" />', '<YoursIcon width="7rem" />']],
  // Welcome, unlock and every other YoursIcon: the b+x tile in bWalletX builds (storeBuild.isBWalletX).
  'src/components/YoursIcon.tsx': [
    [
      "import walletIcon from '../assets/logos/icon.png';",
      "import plainIcon from '../assets/logos/icon.png';\nimport bxIcon from '../mobile/brand/bcorpx/icon.png';\nimport { isBWalletX } from '../mobile/storeBuild';\nconst walletIcon = isBWalletX() ? bxIcon : plainIcon;",
    ],
  ],
  // Wallet › Tokens: every BSV-21 token you hold, favourites first (upstream lists favourites only,
  // so tokens you mint or receive never appeared until starred in Manage tokens).
  'src/pages/BsvWallet.tsx#allTokens': [
    [
      'const filtered = bsv21s.filter((t) => t.id && account?.settings?.favoriteTokens?.includes(t.id));',
      'const favs = account?.settings?.favoriteTokens ?? [];\n    const held = bsv21s.filter((t) => t.id && (favs.includes(t.id) || BigInt(t.amt || "0") > 0n));\n    const filtered = [...held].sort((a, b) => (favs.indexOf(a.id!) + 1 || 1e9) - (favs.indexOf(b.id!) + 1 || 1e9));',
    ],
  ],
  // Wallet tab: Tokens | NFTs | Tickets | Credits (like Market). NFTs is the media library (src/mobile/wallet, src/mobile/media).
  'src/pages/BsvWallet.tsx#kinds': [
    [
      "import { ManageTokens } from '../components/ManageTokens';",
      "import { ManageTokens } from '../components/ManageTokens';\nimport { WalletKindGate, WalletKindSwitch } from '../mobile/wallet/KindSwitch';\nimport { MediaSection } from '../mobile/media/MediaSection';\nimport { TicketsSection } from '../mobile/wallet/TicketsSection';",
    ],
    [
      '        {/* ── Assets section ── */}',
      '        <SectionBoundary name="Kind switch"><WalletKindSwitch /></SectionBoundary>\n        <WalletKindGate kind="tokens">\n<SectionBoundary name="Tokens">\n        {/* ── Assets section ── */}',
    ],
    [
      '        {/* Bottom breathing room */}',
      '</SectionBoundary>\n        </WalletKindGate>\n        <WalletKindGate kind="nfts">\n          <SectionBoundary name="NFTs"><MediaSection /></SectionBoundary>\n        </WalletKindGate>\n        <WalletKindGate kind="tickets">\n          <SectionBoundary name="Tickets"><TicketsSection /></SectionBoundary>\n        </WalletKindGate>\n        <WalletKindGate kind="credits">\n          <SectionBoundary name="Credits"><CreditsRow /></SectionBoundary>\n        </WalletKindGate>\n        {/* Bottom breathing room */}',
    ],
    // The switch replaces the section label and its top margin.
    [
      '          className="w-full mt-6"\n        >\n          {/* Section header */}\n          <div className="flex items-center px-4 mb-2">',
      '          className="w-full"\n        >\n          {/* Section header */}\n          <div className="hidden">',
    ],
  ],
  // Tokens list: tickets stay listed (sending one is an invite) but carry a "· Ticket" mark.
  'src/components/Bsv21TokensList.tsx': [
    [
      "import { AssetRow } from './AssetRow';",
      "import { AssetRow } from './AssetRow';\nimport { tokenListLabel } from '../mobile/wallet/ticketMark';",
    ],
    [
      "const getTokenName = (b: Bsv21Balance): string => b.sym || 'Null';",
      "const getTokenName = (b: Bsv21Balance): string => tokenListLabel(b.sym || 'Null', b.id);",
    ],
  ],
  // Obsidian token rows: raised cards (every AssetRow: BSV, MNEE, locks, BSV21).
  'src/components/AssetRow.tsx': [
    [
      'className="flex flex-wrap items-center justify-between w-[92%] mx-auto rounded-xl px-0 py-3 mb-1.5"',
      'className="flex flex-wrap items-center justify-between w-[92%] mx-auto px-0 py-2.5 mb-2 bw-card"',
    ],
    [
      `        backgroundColor: theme.color.global.row,
        cursor: showPointer ? 'pointer' : 'default',
        border: \`1px solid \${theme.color.global.gray}14\`,`,
      "        cursor: showPointer ? 'pointer' : 'default',",
    ],
  ],
  // Token send: names only when the destination can receive ordinals (ordAddress), else blocked.
  'src/components/SendBsv21View.tsx#names': [
    [
      "import { Input } from './Input';",
      "import { Input } from './Input';\nimport { NameInput } from '../mobile/names/NameInput';",
    ],
    [
      `<Input
                    theme={theme}
                    placeholder="Enter address..."
                    type="text"
                    onChange={(e) => updateRecipient(recipient.id, 'address', e.target.value)}
                    value={recipient.address}
                    style={{ width: '100%', margin: 0 }}
                  />`,
      `<NameInput
                    theme={theme}
                    asset="token"
                    onChange={(v) => updateRecipient(recipient.id, 'address', v)}
                    value={recipient.address}
                    style={{ width: '100%', margin: 0 }}
                  />`,
    ],
  ],
  // Settings → Identity: "Get your name" (OpNS search + bind an owned name).
  'src/pages/Settings.tsx': [
    [
      "import { ToggleSwitch } from '../components/ToggleSwitch';",
      "import { ToggleSwitch } from '../components/ToggleSwitch';\nimport { GetYourName } from '../mobile/names/GetYourName';\nimport { IdentityVerification } from '../mobile/kyc/IdentityVerification';\nimport { FeedSettings } from '../mobile/settings/FeedSettings';",
    ],
    // One flow: profile name (upstream) → "Make your name payable" (paymail / OpNS, defaulting to the profile name).
    [
      '          {identity.bapId && identity.isPublished && (',
      "          <GetYourName profileName={identity.isPublished ? identity.profile.name : ''} />\n          {identity.bapId && identity.isPublished && (",
    ],
    ['          {identityPubKey && (', '          <IdentityVerification />\n          {identityPubKey && ('],
    // Settings → Feed / Payments / Privacy (default feed, autoplay, one-click pay, bookmarks, blocked & muted).
    [
      '      {/* Preferences section */}',
      '      <FeedSettings Section={Section} Row={SettingRow} Divider={Divider} />\n      {/* Preferences section */}',
    ],
    // Deep links to Settings → Identity ("Get verified" / "Qualify as an investor" from Market → Shares).
    [
      "    if (query === 'storage') return 'storage';",
      "    if (query === 'storage') return 'storage';\n    if (query === 'identity' || query === 'investor') return 'identity';",
    ],
    [
      "    else if (query === 'storage') setPage('storage');",
      "    else if (query === 'storage') setPage('storage');\n    else if (query === 'identity' || query === 'investor') setPage('identity');",
    ],
  ],
  'src/App.tsx': [
    // After a forgot-password wipe, open straight on the restore-from-phrase screen.
    [
      "import { MemoryRouter as Router, Route, Routes } from 'react-router-dom';",
      "import { MemoryRouter as Router, Route, Routes } from 'react-router-dom';\nimport { initialRoute } from './mobile/forgot/wipe';\nimport { AndroidMotion } from './mobile/AndroidMotion';",
    ],
    // Android: no transform animations (WebView ghost tiles); see mobile/AndroidMotion.
    ['<Router>', '<AndroidMotion><Router initialEntries={[initialRoute()]}>'],
    ['</Router>', '</Router></AndroidMotion>'],
    [
      "const BrowserPage = lazy(() => import('./mobile/BrowserPage'));",
      "const BrowserPage = lazy(() => import('./mobile/BrowserPage'));\nconst MobileRoutes = lazy(() => import('./mobile/tabs/MobileRoutes'));\nconst MiniPlayer = lazy(() => import('./mobile/media/MiniPlayer'));\nconst CallScreen = lazy(() => import('./mobile/calls/CallScreen'));\nconst NotifyEngine = lazy(() => import('./mobile/notify/NotifyEngine'));\nconst ExtensionEdge = lazy(() => import('./mobile/ExtensionEdge'));",
    ],
    [
      '<Route path="/settings" element={<Settings />} />',
      '<Route path="/settings" element={<Settings />} />\n<Route path="/m/*" element={<Suspense fallback={null}><MobileRoutes /></Suspense>} />',
    ],
    // Media (Wallet › NFTs) now-playing bar, app-wide so audio controls follow every tab.
    // bWallet calls: incoming / in-call screens above every tab (mobile/calls/CallScreen).
    [
      '<UsbBackupPill />',
      '<UsbBackupPill />\n<Suspense fallback={null}><ExtensionEdge /></Suspense>\n<Suspense fallback={null}><MiniPlayer /></Suspense>\n<Suspense fallback={null}><CallScreen /></Suspense>\n<Suspense fallback={null}><NotifyEngine /></Suspense>',
    ],
  ],
};
export const mobileText = (): Plugin => ({
  name: 'mobile-text',
  enforce: 'pre',
  transform(code, id) {
    const file = id.split('?')[0].slice(__dirname.length + 1);
    const swaps = Object.entries(MOBILE_TEXT).flatMap(([k, v]) => (k.split('#')[0] === file ? v : []));
    if (!swaps.length) return null;
    for (const [from, to] of swaps) {
      if (!code.includes(from)) this.error(`mobile-text: "${from}" not found in ${file}`);
      code = code.split(from).join(to);
    }
    return { code, map: null };
  },
});

const mobilePages = (): Plugin => ({
  name: 'yours-mobile-pages',
  transformIndexHtml: {
    order: 'pre',
    handler(html, ctx) {
      const isShell = ctx.filename.endsWith('mobile.html');
      let out = html.replace(
        /<meta name="viewport"[^>]*>/,
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />',
      );
      // Upstream's PWA manifest link points at extension icons; not used in-app.
      out = out.replace(/\s*<link rel="manifest"[^>]*>/, '');
      if (!isShell) {
        out = out.replace('<head>', `<head>\n    ${FRAME_SHIM}`);
        out = out.replace('</head>', '    <link rel="stylesheet" href="./src/mobile/mobile.css" />\n  </head>');
      }
      return out;
    },
  },
  // Capacitor loads index.html from webDir.
  writeBundle(options) {
    const dir = options.dir ?? resolve(__dirname, 'build-mobile');
    renameSync(resolve(dir, 'mobile.html'), resolve(dir, 'index.html'));
  },
});

/** Build-time constants for every build that runs the mobile UI (Capacitor, web, Chrome extension). */
export const MOBILE_DEFINES = {
  ...brandDefines(),
  __BWALLET_EXTENSION__: 'false',
  __MOBILE_VERSION__: JSON.stringify(version),
  // Market tab fee address (src/mobile/market/fee.ts). Empty = no fee.
  __MARKET_FEE_ADDRESS__: JSON.stringify(process.env.BWALLET_MARKET_FEE_ADDRESS ?? ''),
  // bWallet re-enables BSV-21 OrdLock listings (Sell tickets); resale fee on tickets defaults to 0.
  __BWALLET_SELL__: 'true',
  __TICKET_RESALE_FEE_RATE__: JSON.stringify(process.env.BWALLET_TICKET_RESALE_FEE_RATE ?? '0'),
  // Wallet tab Mint creation fee (src/mobile/mint/mint.ts). Empty = no fee.
  __MINT_FEE_ADDRESS__: JSON.stringify(process.env.BWALLET_MINT_FEE_ADDRESS ?? ''),
  // "Set up $X's room" bCorp fee (src/mobile/tokens/roomSetup.ts): USD price, paid in sats to this address.
  // Empty address = no fee; a store build never charges it (bcorpFeeAddress).
  __ROOM_SETUP_FEE_USD__: JSON.stringify(process.env.BWALLET_ROOM_SETUP_FEE_USD ?? '1'),
  __ROOM_SETUP_FEE_ADDRESS__: JSON.stringify(process.env.BWALLET_ROOM_SETUP_FEE_ADDRESS ?? ''),
  // Market safety filter (src/mobile/market/safety.ts): optional remote blocklist JSON and report endpoint. Empty = off.
  __MARKET_BLOCKLIST_URL__: JSON.stringify(process.env.BWALLET_MARKET_BLOCKLIST_URL ?? ''),
  // Reports go to bit-sign's moderation queue (content_reports); owner acts within 24h (Apple 1.2).
  __MARKET_REPORT_URL__: JSON.stringify(
    process.env.BWALLET_MARKET_REPORT_URL ?? 'https://www.bitcoinchat.online/api/bitsign/report',
  ),
  // bWallet paymail (src/mobile/names/config.ts): name@bwallet.space, served by pay.bwallet.space.
  // Set BWALLET_PAYMAIL_DOMAIN='' to build with paymail off.
  __PAYMAIL_DOMAIN__: JSON.stringify(process.env.BWALLET_PAYMAIL_DOMAIN ?? 'bwallet.space'),
  __PAYMAIL_API__: JSON.stringify(process.env.BWALLET_PAYMAIL_API ?? 'https://pay.bwallet.space'),
};

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [brand(), mobileText(), bcorpText(), bcorpColours(), mobilePages()],
    build: {
      outDir: 'build-mobile',
      target: 'es2022',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'mobile.html'),
          'sweep-tab': resolve(__dirname, 'sweep-tab.html'),
          'prompt-tab': resolve(__dirname, 'prompt.html'),
          'usb-tab': resolve(__dirname, 'usb.html'),
        },
      },
    },
    worker: {
      format: 'es',
      plugins: () => [brand(), bcorpText(), bcorpColours(), polyfills()],
    },
    define: MOBILE_DEFINES,
  }),
);
