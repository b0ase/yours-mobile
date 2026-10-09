import { defineConfig, loadEnv, mergeConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';
import { copyFileSync, existsSync, readFileSync, renameSync } from 'fs';
import baseConfig from './vite.config.base';
import { BRAND, brand as sharedBrand, bcorpText, bcorpColours, brandDefines } from './vite.brand';

// The app's name in build-time text patches: bWallet in a store build, bWalletX otherwise (src/mobile/storeBuild.ts).
const STORE_APP_NAME =
  process.env.VITE_STORE_BUILD === '1' || ['ios-store', 'android-play'].includes(process.env.VITE_CHANNEL ?? '')
    ? 'bWallet'
    : 'bWalletX';

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
// Store builds (ios-store, android-play): the bWalletX-only owner tiles are not in the bundle, icon included.
const STORE_CHANNEL =
  process.env.VITE_STORE_BUILD === '1' || ['ios-store', 'android-play'].includes(process.env.VITE_CHANNEL ?? '');
if (STORE_CHANNEL) {
  MOBILE_SWAPS[resolve(__dirname, 'src/mobile/ownerAppsX.ts')] = resolve(__dirname, 'src/mobile/ownerAppsX.store.ts');
  // bExchange and the Markets & collectibles tiles: not in the store bundle, icons included.
  MOBILE_SWAPS[resolve(__dirname, 'src/mobile/exchangeAppsX.ts')] = resolve(
    __dirname,
    'src/mobile/exchangeAppsX.store.ts',
  );
  // TokenBlaster arcade games in Apps › Games: not in the store bundle.
  MOBILE_SWAPS[resolve(__dirname, 'src/mobile/games/gamesCatalogX.ts')] = resolve(
    __dirname,
    'src/mobile/games/gamesCatalogX.store.ts',
  );
}
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
  // Token page actions, in order Buy · Sell · Send · Chat (owner, 4 Oct 2026). Buy opens the token in
  // our own Market tab (replacing the external 1Sat "Trade" link); Chat opens its room (docs/TOKEN-ROOMS.md).
  'src/components/SendBsv21View.tsx': [
    [
      "import { CoinHistory } from './CoinHistory';",
      "import { CoinHistory } from './CoinHistory';\nimport { BuyTokenButton, OpenTokenRoomButton } from '../mobile/chat/OpenTokenRoomButton';",
    ],
    [
      '{/* Action buttons */}\n            <div className="flex gap-2 mt-1">',
      '{/* Action buttons */}\n            <div className="flex gap-2 mt-1">\n<BuyTokenButton id={token.info.id} />',
    ],
    [
      'onClick={() => window.open(`${ONE_SAT_MARKET_URL}/bsv21/${token.info.id}`, \'_blank\')}\n                className="flex items-center justify-center gap-2 flex-1 h-11 rounded-xl text-sm font-bold outline-none border cursor-pointer"',
      'onClick={() => window.open(`${ONE_SAT_MARKET_URL}/bsv21/${token.info.id}`, \'_blank\')}\n                className="hidden"',
    ],
    [
      "{isProcessing ? 'Sending...' : 'Send'}\n              </motion.button>",
      "{isProcessing ? 'Sending...' : 'Send'}\n              </motion.button>\n<OpenTokenRoomButton id={token.info.id} />",
    ],
    // Token links (website / app / X / Telegram / bChat) under the action buttons, when the issuer set any.
    [
      "import { BuyTokenButton, OpenTokenRoomButton } from '../mobile/chat/OpenTokenRoomButton';",
      "import { BuyTokenButton, OpenTokenRoomButton } from '../mobile/chat/OpenTokenRoomButton';\nimport { TokenLinks } from '../mobile/tokens/TokenLinks';",
    ],
    [
      '{/* Market chart */}',
      '<div className="mx-4 mb-3 empty:hidden"><TokenLinks tokenId={token.info.id} sym={token.info.sym} /></div>\n          {/* Market chart */}',
    ],
  ],
  // Inscription HTML/SVG: an explicitly empty sandbox (no scripts, opaque origin); upstream's "true" only
  // worked because it is not a valid token (security audit, 8 Oct 2026).
  'src/components/Ordinal.tsx': [['sandbox="true"', 'sandbox=""']],
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
    // Send to a name now lives in the Send card itself (src/mobile/wallet/send/SendCard → NameInput).
    [
      "import { MintButton } from '../mobile/mint/MintButton';",
      "import { MintButton } from '../mobile/mint/MintButton';\nimport { ReceiveName } from '../mobile/names/MyNameBadge';",
    ],
    // Receive screen shows the account's name.
    [
      '          Receive Assets\n        </h2>\n      </div>',
      '          Receive Assets\n        </h2>\n      </div>\n<ReceiveName identityAddress={identityAddress} />',
    ],
    // Receive › Payments | Airdrops: the airdrop address (account's ordinals address) with QR + copy.
    [
      "import { ReceiveName } from '../mobile/names/MyNameBadge';",
      "import { ReceiveName } from '../mobile/names/MyNameBadge';\nimport { ReceiveTabs } from '../mobile/airdrops/ReceiveTabs';\nimport { AirdropsRow } from '../mobile/airdrops/AirdropsRow';",
    ],
    [
      '<ReceiveName identityAddress={identityAddress} />',
      '<ReceiveName identityAddress={identityAddress} />\n<ReceiveTabs />',
    ],
    // "Choose your handle" after create / restore, else a dismissible "Get your $name" card (src/mobile/names).
    [
      "import { CreditsRow } from '../mobile/credits/CreditsRow';",
      "import { CreditsRow } from '../mobile/credits/CreditsRow';\nimport { HandleOnboarding } from '../mobile/names/HandleOnboarding';\nimport { SweepPrompt } from '../mobile/sweep/SweepPrompt';",
    ],
    // Under Receive / Send / Mint, outside the Tokens / NFTs / Credits gates so it shows on every view.
    // Wide web layout: the token table and totals beside the wallet read this page's balances (wide/walletFeed.ts).
    [
      '  if (showWelcome) {',
      '  useWideWalletFeed({ bsvBalance, mneeBalance, exchangeRate, bsv21s });\n  if (showWelcome) {',
    ],
    [
      "import { CreditsRow } from '../mobile/credits/CreditsRow';",
      "import { CreditsRow } from '../mobile/credits/CreditsRow';\nimport { useWideWalletFeed } from '../mobile/wide/walletFeed';",
    ],
    [
      '</SectionBoundary>\n        </motion.div>',
      '</SectionBoundary>\n        </motion.div>\n<SectionBoundary name="Handle"><HandleOnboarding /></SectionBoundary>\n<SectionBoundary name="Sweep"><SweepPrompt /></SectionBoundary>\n<SectionBoundary name="Airdrops"><AirdropsRow /></SectionBoundary>',
    ],
  ],
  // New wallet / new account: flag the "Choose your handle" step (shown on the Wallet tab after Enter reloads).
  'src/pages/onboarding/CreateAccount.tsx': [
    // A Continue with X / Google sign-in made on this screen now belongs to the new account (socialLogin.ts bindSocial).
    [
      '      await saveAccountDataToChromeStorage(chromeStorageService, accountName, iconURL);',
      '      await saveAccountDataToChromeStorage(chromeStorageService, accountName, iconURL);\n      bindSocial(keys.identityAddress);',
    ],
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { bindSocial } from '../../mobile/social/socialLogin';",
    ],
    // Password asked twice for every new account (owner, 6 Oct 2026).
    ['      if (newWallet && password !== passwordConfirm) {', '      if (password !== passwordConfirm) {'],
    // Restore offer from SocialSignIn needs the bottom menu's page switch.
    [
      '  const { hideMenu, showMenu } = useBottomMenu();',
      '  const { hideMenu, showMenu, handleSelect } = useBottomMenu();',
    ],
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { onboardingError } from '../../mobile/onboardingError';",
    ],
    // Say why it failed (src/mobile/onboardingError.ts) instead of always blaming the password.
    [
      "      console.log(error);\n      addSnackbar('An error occurred while creating the account! Make sure your password is correct.', 'error');",
      "      console.log(error);\n      addSnackbar(onboardingError('create', error), 'error');",
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
    [
      '      setStep(2);\n    } catch',
      "      markHandlePrompt(keys.identityAddress, 'create');\n      setStep(2);\n    } catch",
    ], // Password: generate a strong one, eye toggle, autocomplete hints so the phone / browser saves it
    // (src/mobile/names/PasswordFields.tsx; iOS webcredentials:www.bwallet.space).
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { PasswordFields } from '../../mobile/names/PasswordFields';\nimport { saveWalletPassword } from '../../mobile/names/walletPassword';",
    ],
    [
      '        <Input\n          theme={theme}\n          placeholder="Password"\n          type="password"\n          value={password}\n          onChange={(e) => setPassword(e.target.value)}\n        />\n        <Show when={newWallet}>\n          <Input\n            theme={theme}\n            placeholder="Confirm password"\n            type="password"\n            value={passwordConfirm}\n            onChange={(e) => setPasswordConfirm(e.target.value)}\n          />\n        </Show>',
      '        <PasswordFields askSaved confirmAlways newWallet={newWallet} username={accountName} password={password} confirm={passwordConfirm} setPassword={setPassword} setConfirm={setPasswordConfirm} />',
    ],
    [
      "      markHandlePrompt(keys.identityAddress, 'create');",
      "      markHandlePrompt(keys.identityAddress, 'create');\n      if (newWallet) void saveWalletPassword(accountName, password);",
    ],
    // Recovery phrase "Next": don't wait on the background wallet switch (a new wallet's first
    // storage connection can hang), so the button never silently does nothing.
    [
      '          await chromeStorageService.switchAccount(identityAddress);\n          setStep(3);',
      "          await Promise.race([\n            chromeStorageService.switchAccount(identityAddress).catch((e) => console.error('[create] switchAccount', e)),\n            new Promise((r) => setTimeout(r, 4000)),\n          ]);\n          setStep(3);",
    ],
    // Continue with X / Google above the form (src/mobile/social): fills name + photo.
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { SocialSignIn } from '../../mobile/social/SocialSignIn';",
    ],
    [
      '      <form onSubmit={handleKeyGeneration} className="flex flex-col items-center w-full gap-0">',
      "      <SocialSignIn onProfile={(p) => { setAccountName(p.name); if (p.avatar) setIconURL(p.avatar); }} onClear={(a) => setIconURL((v) => (a && v === a ? '' : v))} onRestore={() => (newWallet ? navigate('/restore-wallet') : handleSelect('settings', 'restore-account'))} />\n      <form onSubmit={handleKeyGeneration} autoComplete=\"off\" className=\"flex flex-col items-center w-full gap-0\">",
    ],
    // Add account: say plainly it's the wallet password (one password unlocks every account) and that this
    // account gets its own new 12 words next (owner, 6 Oct 2026: it looked like it wanted a new password).
    [
      "{newWallet ? 'Create password' : 'New Account'}",
      "{newWallet ? 'Create password' : isAgentCreatePending() ? 'New agent account' : 'New account'}",
    ],
    [
      "{newWallet ? 'This will be used to unlock your wallet.' : 'Enter your existing password.'}",
      `{newWallet ? 'This will be used to unlock your wallet.' : 'Enter the password you unlock ${STORE_APP_NAME} with (one password for all your accounts). Next you will get this account\\'s own 12-word recovery phrase.'}`,
    ],
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { isAgentCreatePending } from '../../mobile/agents/agentCreate';",
    ],
    // Agent account switch on Add account (src/mobile/agents, docs/SMART-WALLET-SPEC.md §1).
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { AgentAccountToggle } from '../../mobile/agents/AgentAccountToggle';\nimport { consumeAgentCreate } from '../../mobile/agents/agentCreate';",
    ],
    [
      "        <Button\n          theme={theme}\n          type=\"primary\"\n          label={newWallet ? 'Generate Seed' : 'Create New Account'}",
      "        {!newWallet && <AgentAccountToggle />}\n        <Button\n          theme={theme}\n          type=\"primary\"\n          label={newWallet ? 'Generate Seed' : 'Create New Account'}",
    ],
    [
      "      markHandlePrompt(keys.identityAddress, 'create');\n      if (newWallet)",
      "      markHandlePrompt(keys.identityAddress, 'create');\n      if (!newWallet) consumeAgentCreate(keys.identityAddress);\n      if (newWallet)",
    ],
  ],
  // WIF / JSON import and master (zip) restore: same step for the imported account, after the name sync.
  'src/pages/onboarding/ImportAccount.tsx': [
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { onboardingError } from '../../mobile/onboardingError';",
    ],
    // Say why it failed (src/mobile/onboardingError.ts) instead of always blaming the password.
    [
      "      console.log(error);\n      addSnackbar('An error occurred while importing the account!', 'error');",
      "      console.log(error);\n      addSnackbar(onboardingError('import', error), 'error');",
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
    // A Continue with X / Google sign-in made on this screen now belongs to the new account (socialLogin.ts bindSocial).
    [
      '      await saveAccountDataToChromeStorage(chromeStorageService, accountName, iconURL);',
      '      await saveAccountDataToChromeStorage(chromeStorageService, accountName, iconURL);\n      bindSocial(keys.identityAddress);',
    ],
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { bindSocial } from '../../mobile/social/socialLogin';",
    ],
    // Continue with X / Google: the 12 words must be the wallet that owns the verified name (src/mobile/social/restoreGuard.ts).
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { checkRestoreMatchesName } from '../../mobile/social/restoreGuard';",
    ],
    [
      '      await sleep(50);\n      const keys = await keysService.generateSeedAndStoreEncrypted(\n        password,\n        newWallet,\n        seedWords,',
      "      const nameMismatch = await checkRestoreMatchesName(seedWords, walletDerivation, ordDerivation, identityDerivation, importWallet);\n      console.log('[restore] name check at', at());\n      if (nameMismatch) {\n        addSnackbar(nameMismatch, 'error');\n        return;\n      }\n      await sleep(50);\n      const keys = await keysService.generateSeedAndStoreEncrypted(\n        password,\n        newWallet,\n        seedWords,",
    ],
    // Confirm field also when adding to an existing wallet.
    [
      '        <Show when={newWallet}>\n          <Input\n            theme={theme}\n            placeholder="Confirm Password"',
      '        <Show when={true}>\n          <Input\n            theme={theme}\n            placeholder={newWallet ? "Confirm Password" : "Your wallet password again"}',
    ],
    // Password asked twice for every restore (owner, 6 Oct 2026).
    ['      if (newWallet && password !== passwordConfirm) {', '      if (password !== passwordConfirm) {'],
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { onboardingError } from '../../mobile/onboardingError';",
    ],
    // Say why it failed (src/mobile/onboardingError.ts) instead of always blaming the password.
    [
      "      console.log(error);\n      addSnackbar('An error occurred while restoring the account!', 'error');",
      "      console.log(error);\n      addSnackbar(onboardingError('restore', error), 'error');",
    ],
    // Colour on the RelayX tile (white mark on its #2669FF blue) and Twetch's real icon (its brand is monochrome).
    [
      "import relayXLogo from '../../assets/relayx.svg';",
      "import relayXLogo from '../../mobile/brand/restore/relayx.svg';",
    ],
    [
      "import twetchLogo from '../../assets/twetch.svg';",
      "import twetchLogo from '../../mobile/brand/apps/twetch.png';",
    ],
    // Continue with X / Google on Restore too (owner, 4 Oct 2026): the restored wallet can claim its verified name.
    [
      "import { useNavigate } from 'react-router-dom';",
      "import { useNavigate } from 'react-router-dom';\nimport { SocialSignIn } from '../../mobile/social/SocialSignIn';",
    ],
    [
      '      <form onSubmit={handleRestore} className="flex flex-col items-center w-full">',
      '      <SocialSignIn onProfile={(p) => { setAccountName(p.name); if (p.avatar) setIconURL(p.avatar); }} onClear={(a) => setIconURL((v) => (a && v === a ? \'\' : v))} />\n      <form onSubmit={handleRestore} autoComplete="off" className="flex flex-col items-center w-full">',
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
      '<SectionBoundary name="Card"><WalletCard usd={bsvBalance * exchangeRate + (services.mnee ? mneeBalance : 0)} sats={Math.round(bsvBalance * 100_000_000)} view={balanceView({ loading: balanceLoading, failed: balanceFailed, known: balanceKnown })} syncing={isSyncing} failed={balanceFailed} onRetry={() => void getAndSetBsvBalance()} receiveAddress={receiveAddress} onRefresh={(manual) => void refreshUtxos({ notifyIfUnchanged: manual })} refreshing={isRefreshing} rate={exchangeRate} /></SectionBoundary>\n        {/* ── USD balance ── */}',
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
      "        style={{ minHeight: '100%' }}\n      >\n        {/* ── BSV price + Buy BSV (owner, 6 Oct 2026); the migration banner moved below the token buttons ── */}",
      "        style={{ minHeight: '100%' }}\n      >\n<PullToRefresh onRefresh={() => refreshUtxos({ notifyIfUnchanged: true })} />\n<VideoBackground src={walletBg} poster={walletPoster} scrim='dark' position='fixed' />\n        {/* ── BSV price + Buy BSV (owner, 6 Oct 2026); the migration banner moved below the token buttons ── */}",
    ],
    [
      'className="flex flex-col items-center w-full pt-14 pb-16 overflow-y-auto"',
      'className="isolate flex flex-col items-center w-full pt-14 pb-16 overflow-y-auto"',
    ],
    [
      // Phone: pull to refresh instead. Extension (no pull gesture): keep the button.
      '            {!balanceLoading && (\n              <motion.button',
      '            {__BWALLET_EXTENSION__ && !balanceLoading && (\n              <motion.button',
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
  // Unlock: let the phone / browser fill the saved wallet password (PasswordFields saves it).
  // A hidden username (the account name the password was saved under at Create, PasswordFields) so the browser files
  // and fills the password per wallet instead of offering whatever it saved for the domain.
  'src/components/UnlockWallet.tsx#autofill': [
    [
      '          <Input\n            theme={theme}\n            placeholder="Password"\n            type="password"\n            value={password}',
      '          <input\n            type="text"\n            name="username"\n            autoComplete="username"\n            value={chromeStorageService.getCurrentAccountObject().account?.name || chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress || \'\'}\n            readOnly\n            hidden\n          />\n          <Input\n            theme={theme}\n            placeholder="Password"\n            type="password"\n            name="password"\n            autoComplete="current-password"\n            value={password}',
    ],
  ],
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
      'const favs = account?.settings?.favoriteTokens ?? [];\n    const hidden = (account?.settings as { hiddenTokens?: string[] } | undefined)?.hiddenTokens ?? [];\n    const held = bsv21s.filter((t) => t.id && (favs.includes(t.id) || (BigInt(t.amt || "0") > 0n && !hidden.includes(t.id))));\n    const filtered = [...held].sort((a, b) => (favs.indexOf(a.id!) + 1 || 1e9) - (favs.indexOf(b.id!) + 1 || 1e9));',
    ],
  ],
  // Wallet tab: Tokens | NFTs | Tickets | Credits (like Market). NFTs is the media library (src/mobile/wallet, src/mobile/media).
  'src/pages/BsvWallet.tsx#kinds': [
    [
      "import { ManageTokens } from '../components/ManageTokens';",
      "import { ManageTokens } from '../components/ManageTokens';\nimport { WalletKindGate, WalletKindSwitch } from '../mobile/wallet/KindSwitch';\nimport { MediaSection } from '../mobile/media/MediaSection';\nimport { TicketsSection } from '../mobile/wallet/TicketsSection';\nimport { FriendsSection } from '../mobile/wallet/FriendsSection';",
    ],
    [
      '        {/* ── Assets section ── */}',
      '        <SectionBoundary name="Kind switch"><WalletKindSwitch /></SectionBoundary>\n        <WalletKindGate kind="tokens">\n<SectionBoundary name="Tokens">\n        {/* ── Assets section ── */}',
    ],
    [
      '        {/* Bottom breathing room */}',
      '</SectionBoundary>\n        </WalletKindGate>\n        <WalletKindGate kind="nfts">\n          <SectionBoundary name="NFTs"><MediaSection /></SectionBoundary>\n        </WalletKindGate>\n        <WalletKindGate kind="friends">\n          <SectionBoundary name="Friends"><FriendsSection /></SectionBoundary>\n        </WalletKindGate>\n        <WalletKindGate kind="tickets">\n          <SectionBoundary name="Tickets"><TicketsSection /></SectionBoundary>\n        </WalletKindGate>\n        <WalletKindGate kind="credits">\n          <SectionBoundary name="Credits"><CreditsRow /></SectionBoundary>\n        </WalletKindGate>\n        {/* Bottom breathing room */}',
    ],
    // The switch replaces the section label and its top margin.
    [
      '          className="w-full mt-6"\n        >\n          {/* Section header */}\n          <div className="flex items-center px-4 mb-2">',
      '          className="w-full"\n        >\n          {/* Section header */}\n          <div className="hidden">',
    ],
  ],
  // "Back up your wallet" (src/mobile/backup): red banner + step on the Wallet tab, Receive gated until backed
  // up. Replaces upstream's BackupPromo (its plain-JSON key download) in our builds.
  'src/pages/BsvWallet.tsx#backup': [
    [
      "import { getPlatform } from '../platform';",
      "import { getPlatform } from '../platform';\nimport { BackupGate } from '../mobile/backup/BackupGate';\nimport { requestBackupThen } from '../mobile/backup/backupState';",
    ],
    [
      '<SectionBoundary name="Card">',
      '<SectionBoundary name="Backup"><BackupGate sats={Math.round(bsvBalance * 100_000_000)} /></SectionBoundary>\n<SectionBoundary name="Card">',
    ],
    [
      "onClick={() => setPageState('receive')}",
      "onClick={() => requestBackupThen(chromeStorageService, () => setPageState('receive'))}",
    ],
    [
      '      setShowBackupPromo(!dismissed && !hasRemotes);',
      '      setShowBackupPromo(false && !dismissed && !hasRemotes);',
    ],
    // "Missing assets? Open migration tool": only for wallets that could hold legacy Yours assets, not ones made here.
    [
      "import { BackupGate } from '../mobile/backup/BackupGate';\nimport { requestBackupThen } from '../mobile/backup/backupState';",
      "import { BackupGate } from '../mobile/backup/BackupGate';\nimport { createdHere, requestBackupThen } from '../mobile/backup/backupState';",
    ],
    [
      '      setShowMigrationBanner(!acct?.settings?.sweepStarted && !acct?.settings?.sweepCompleted);',
      '      setShowMigrationBanner(!acct?.settings?.sweepStarted && !acct?.settings?.sweepCompleted && !createdHere(acct?.addresses?.identityAddress));',
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
  // Ordinals › List (inherited "Global orderbook" step): bWalletX only. Nothing opens it (ordlock listing is
  // off upstream), and MARKET_ENABLED folds it to `false` in a store build so its text is not in the bundle.
  'src/pages/OrdWallet.tsx': [
    [
      "import validate from 'bitcoin-address-validation';",
      "import validate from 'bitcoin-address-validation';\nimport { MARKET_ENABLED } from '../mobile/storeBuild';",
    ],
    ['  const listView = (', '  const listView = MARKET_ENABLED && ('],
  ],
  // Settings → Identity: "Get your name" (OpNS search + bind an owned name).
  'src/pages/Settings.tsx': [
    [
      "import { ToggleSwitch } from '../components/ToggleSwitch';",
      "import { ToggleSwitch } from '../components/ToggleSwitch';\nimport { GetYourName } from '../mobile/names/GetYourName';\nimport { IdentityVerification } from '../mobile/kyc/IdentityVerification';\nimport { FeedSettings } from '../mobile/settings/FeedSettings';\nimport { SettingsAccountHeader, SettingsGroup } from '../mobile/settings/SettingsAccountHeader';",
    ],
    // One flow: profile name (upstream) → "Make your name payable" (paymail / OpNS, defaulting to the profile name).
    [
      '          {identity.bapId && identity.isPublished && (',
      "          <GetYourName profileName={identity.isPublished ? identity.profile.name : ''} />\n          {identity.bapId && identity.isPublished && (",
    ],
    ['          {identityPubKey && (', '          <IdentityVerification />\n          {identityPubKey && ('],
    // Settings → General (one row each for Feed, Payments, Subscriptions, … opening its own page), Privacy, Connections, Help.
    [
      '      {/* Preferences section */}',
      '      <FeedSettings part="wallet" Section={Section} Row={SettingRow} Divider={Divider} />\n      {/* Preferences section */}',
    ],
    // Settings main page: "Settings for: <account> ▾", then "This account" (identity, backup, permissions, names, tokens) and "All accounts (wallet)" (Manage accounts, password, USB key, preferences). Owner, 6 Oct 2026.
    [
      '      {/* Account section */}\n      <Section title="Account">\n        <SettingRow\n          icon={<Users size={16} />}\n          label="Manage Accounts"\n          description="Create, restore, or edit accounts"\n          onClick={() => setPage(\'manage-accounts\')}\n          isFirst\n        />\n        <Divider />\n',
      '      <SettingsAccountHeader />\n      <SettingsGroup title="This account" note="Each account has its own 12 words, keys, names and tokens." />\n      <Section title="Account">\n        <SettingRow\n          icon={<Fingerprint size={16} />}\n          label="Identity"\n          description="Your names, posting profile and verification"\n          onClick={() => setPage(\'identity\')}\n          isFirst\n        />\n        <Divider />\n        <SettingRow\n          icon={<Key size={16} />}\n          label="Wallet Backup"\n          description="This account\'s recovery phrase and keys; the encrypted file holds every account"\n          onClick={() => setPage(\'export-keys-options\')}\n        />\n        <Divider />\n',
    ],
    [
      '          description="Review and revoke connected apps and permissions"',
      '          description="Apps connected to this account and their permissions"',
    ],
    [
      '      <Section title="Security">\n        <SettingRow\n          icon={<Key size={16} />}\n          label="Wallet Backup"\n          description="Backup seed, download JSON, or QR code"\n          onClick={() => setPage(\'export-keys-options\')}\n          isFirst\n          isLast={!usbSupported}\n        />',
      '      <FeedSettings part="account" Section={Section} Row={SettingRow} Divider={Divider} />\n      <SettingsGroup title="All accounts (wallet)" note="One password and these preferences for every account on this device." />\n      <FeedSettings part="notify" Section={Section} Row={SettingRow} Divider={Divider} />\n      <Section title="Wallet">\n        <SettingRow\n          icon={<Users size={16} />}\n          label="Manage Accounts"\n          description="Create, restore, or edit accounts"\n          onClick={() => setPage(\'manage-accounts\')}\n          isFirst\n          isLast={!usbSupported}\n        />',
    ],
    [
      '      <Section title="Preferences">\n        <SettingRow\n          icon={<Fingerprint size={16} />}\n          label="Posting profile"\n          description="Your on-chain name and photo that sign your posts"\n          onClick={() => setPage(\'identity\')}\n          isFirst\n        />\n        <Divider />\n        <SettingRow\n          icon={<Gauge size={16} />}\n          label="Custom Fee Rate"\n          description="Default: 100 sat/kb"',
      '      <Section title="Preferences">\n        <SettingRow\n          icon={<Gauge size={16} />}\n          label="Custom Fee Rate"\n          isFirst\n          description="All accounts \u00b7 default 100 sat/kb"',
    ],
    [
      '          description="Lock wallet after inactivity"',
      '          description="Lock every account after inactivity"',
    ],
    [
      "    const update: Partial<ChromeStorageObject['accounts']> = {\n      [selectedAccount]: {\n        ...account,\n        settings: { ...account.settings, customFeeRate: rate },\n      },\n    };",
      "    const update: Partial<ChromeStorageObject['accounts']> = Object.fromEntries(\n      chromeStorageService.getAllAccounts().map(({ address: _a, ...a }) => [a.addresses.identityAddress, { ...a, settings: { ...a.settings, customFeeRate: rate } }]),\n    );\n    void account;",
    ],
    [
      "    const update: Partial<ChromeStorageObject['accounts']> = {\n      [selectedAccount]: {\n        ...account,\n        settings: { ...account.settings, lockTimeout: minutes },\n      },\n    };",
      "    const update: Partial<ChromeStorageObject['accounts']> = Object.fromEntries(\n      chromeStorageService.getAllAccounts().map(({ address: _a, ...a }) => [a.addresses.identityAddress, { ...a, settings: { ...a.settings, lockTimeout: minutes } }]),\n    );\n    void account;",
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
    // Phone layout (src/mobile/phone, behind the Settings › Testing switch): the dock, page swipes and the hold-b
    // agent, mounted once inside the router. Renders nothing while the switch is off.
    // PhonePage wraps the routed page so the phone layout can drag it sideways (phone/pager.tsx).
    // Wide web layout (src/mobile/wide, demo/desktop-shell): sidebar + top bar around the same routes; a no-op when off.
    ['<Routes>', '<Suspense fallback={null}><PhoneShell /></Suspense>\n<WideFrame><PhonePage><Routes>'],
    ['</Routes>', '</Routes></PhonePage></WideFrame>'],
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
      "const BrowserPage = lazy(() => import('./mobile/BrowserPage'));\nconst MobileRoutes = lazy(() => import('./mobile/tabs/MobileRoutes'));\nconst MiniPlayer = lazy(() => import('./mobile/media/MiniPlayer'));\nconst CallScreen = lazy(() => import('./mobile/calls/CallScreen'));\nconst NotifyEngine = lazy(() => import('./mobile/notify/NotifyEngine'));\nconst PushEngine = lazy(() => import('./mobile/push/PushEngine'));\nconst BappFrameHost = lazy(() => import('./mobile/bappFrame/BappFrameHost').then((m) => ({ default: m.BappFrameHost })));\nconst ExtensionEdge = lazy(() => import('./mobile/ExtensionEdge'));\nconst PhoneShell = lazy(() => import('./mobile/phone/PhoneShell'));\nimport { PhonePage } from './mobile/phone/pager';\nimport { WideFrame } from './mobile/wide/WideFrame';",
    ],
    [
      '<Route path="/settings" element={<Settings />} />',
      '<Route path="/settings" element={<Settings />} />\n<Route path="/m/*" element={<Suspense fallback={null}><MobileRoutes /></Suspense>} />',
    ],
    // Media (Wallet › NFTs) now-playing bar, app-wide so audio controls follow every tab.
    // bWallet calls: incoming / in-call screens above every tab (mobile/calls/CallScreen).
    // Push: device registration + notification taps (mobile/push/PushEngine).
    [
      '<UsbBackupPill />',
      '<UsbBackupPill />\n<Suspense fallback={null}><ExtensionEdge /></Suspense>\n<Suspense fallback={null}><MiniPlayer /></Suspense>\n<Suspense fallback={null}><CallScreen /></Suspense>\n<Suspense fallback={null}><NotifyEngine /></Suspense>\n<Suspense fallback={null}><PushEngine /></Suspense>\n<Suspense fallback={null}><BappFrameHost /></Suspense>',
    ],
  ],
};
export const mobileText = (): Plugin => ({
  name: 'mobile-text',
  enforce: 'pre',
  // order: 'pre' on the hook too: in dev, @vitejs/plugin-react (also 'pre', listed earlier by the base
  // config) reprints the source with Babel first, and the exact strings below would no longer match.
  transform: {
    order: 'pre',
    handler(code, id) {
      const file = id.split('?')[0].slice(__dirname.length + 1);
      const swaps = Object.entries(MOBILE_TEXT).flatMap(([k, v]) => (k.split('#')[0] === file ? v : []));
      if (!swaps.length) return null;
      for (const [from, to] of swaps) {
        if (!code.includes(from)) this.error(`mobile-text: "${from}" not found in ${file}`);
        code = code.split(from).join(to);
      }
      return { code, map: null };
    },
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
  // bWallet paymail (src/mobile/names/config.ts): name@bwalletx.com (owner, 4 Oct 2026; bwallet.space stays an
  // alias for every name), both served by pay.bwallet.space (PAYMAIL_DOMAINS).
  // Set BWALLET_PAYMAIL_DOMAIN='' to build with paymail off.
  __PAYMAIL_DOMAIN__: JSON.stringify(process.env.BWALLET_PAYMAIL_DOMAIN ?? 'bwalletx.com'),
  __PAYMAIL_API__: JSON.stringify(process.env.BWALLET_PAYMAIL_API ?? 'https://pay.bwallet.space'),
};

/**
 * public/ is the extension's folder and still carries the Yours favicon and logos, so a browser tab on the
 * mobile build showed the Yours icon (owner, 7 Oct 2026). Overwrite them with the bWalletX icons after the copy.
 */
const bwalletxIcons = (): Plugin => ({
  name: 'bwalletx-icons',
  apply: 'build',
  closeBundle() {
    // Only the bcorp brand: bWalletX (non-store) gets the bWalletX set, the store bWallet its own
    // (black b on yellow); other brands keep public/. Missing icons skip instead of failing the build.
    if (BRAND !== 'bcorp') return;
    const store =
      process.env.VITE_STORE_BUILD === '1' || ['ios-store', 'android-play'].includes(process.env.VITE_CHANNEL ?? '');
    const dir = store ? 'assets/bwallet-ext' : 'assets/bwalletx-ext';
    const from = (f: string) => resolve(__dirname, dir, f);
    const to = (f: string) => resolve(__dirname, 'build-mobile', f);
    const copy = (a: string, b: string) => existsSync(from(a)) && copyFileSync(from(a), to(b));
    copy('favicon.ico', 'favicon.ico');
    copy('icon192.png', 'logo192.png');
    copy('icon512.png', 'logo512.png');
    for (const f of ['icon16.png', 'icon48.png', 'icon128.png', 'icon192.png']) copy(f, `icons/${f}`);
  },
});

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [brand(), mobileText(), bcorpText(), bcorpColours(), mobilePages(), bwalletxIcons()],
    build: {
      outDir: 'build-mobile',
      target: 'es2022',
      // No source maps in a store app: they carry the source comments of code the store build drops.
      sourcemap: !STORE_CHANNEL,
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
