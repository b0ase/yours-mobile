/**
 * Whether an approval prompt should render inside the open wallet panel (PanelPrompt.tsx) rather than in its
 * own window/overlay. Only the Chrome extension draws PanelPrompt; it is the only build with chrome.sidePanel.
 * The phone and web wallet connect the same 'extension-popup' port but show prompts as overlays above
 * everything (including a framed bApp), so they must never take the panel path.
 */
export const promptsShowInPanel = (openPanels: number, chromeApi: unknown): boolean =>
  openPanels > 0 && !!(chromeApi as { sidePanel?: unknown } | undefined)?.sidePanel;
