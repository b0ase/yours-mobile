import { Component, type ReactNode } from 'react';

/**
 * Renders nothing if its child throws, a lazy chunk that failed to load included (a stale hash after a deploy). For
 * Signed's always-on mounts (the recorder in MobileRoutes, the badge keeper and the ☰ row in the top bar): they must
 * never blank or error-screen the pages around them.
 */
export class QuietBoundary extends Component<{ name: string; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn(`[bwallet] ${this.props.name} did not load`, error);
  }

  render() {
    return this.state.failed ? null : (this.props.children ?? null);
  }
}
