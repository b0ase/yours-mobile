import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Last-resort boundary (15 Oct 2026): a render error anywhere used to unmount the whole app and leave a black
 * screen with nothing in the console. Show the error and a Reload button instead; the wallet's data is untouched.
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; stack: string }> {
  state = { error: null as Error | null, stack: '' };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[RootErrorBoundary]', error, info.componentStack);
    this.setState({ stack: info.componentStack ?? '' });
  }
  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 20, color: '#fff', background: '#000', minHeight: '100vh', fontFamily: 'system-ui' }}>
        <h2 style={{ color: '#f5b400' }}>Something went wrong</h2>
        <p>Your wallet is safe. Please send this to support:</p>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, userSelect: 'all' }}>
          {String(error?.stack || error)}
          {'\n'}
          {stack.split('\n').slice(0, 12).join('\n')}
        </pre>
        <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 12, padding: '10px 16px' }}>
          Reload
        </button>
      </div>
    );
  }
}
