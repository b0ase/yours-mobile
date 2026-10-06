import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Error boundary for one mobile insert on the Wallet page (Mint, kind switch, Tickets, Credits,
 * handle card, Finish setting up...). A widget that throws while rendering shows one quiet line
 * instead of unmounting the whole Wallet tab; the error goes to the console.
 */
export class SectionBoundary extends Component<
  { name: string; children?: ReactNode; /** Whole screen: message plus Reload. */ screen?: boolean },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[bwallet] ${this.props.name} failed to render`, error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children ?? null;
    // A whole tab / page threw (owner, 6 Oct 2026: a blank page on the web): say so and offer a reload.
    if (this.props.screen)
      return (
        <div role="alert" className="flex flex-col items-center gap-3 px-6 pt-24 text-center">
          <p className="text-sm m-0" style={{ color: '#98A2B3' }}>
            Something went wrong showing this page.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl px-5 py-2 text-sm font-bold border-0"
            style={{ background: '#F5B800', color: '#000' }}
          >
            Reload
          </button>
        </div>
      );
    return (
      <p role="status" className="text-[11px] my-2 text-center" style={{ color: '#98A2B3' }}>
        Couldn't load this section.
      </p>
    );
  }
}
