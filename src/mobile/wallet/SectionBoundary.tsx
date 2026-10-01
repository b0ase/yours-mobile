import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Error boundary for one mobile insert on the Wallet page (Mint, kind switch, Tickets, Credits,
 * handle card, Finish setting up...). A widget that throws while rendering shows one quiet line
 * instead of unmounting the whole Wallet tab; the error goes to the console.
 */
export class SectionBoundary extends Component<{ name: string; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[bwallet] ${this.props.name} failed to render`, error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children ?? null;
    return (
      <p role="status" className="text-[11px] my-2 text-center" style={{ color: '#98A2B3' }}>
        Couldn't load this section.
      </p>
    );
  }
}
