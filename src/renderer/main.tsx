import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './dashboard/App';
import Overlay from './overlay/Overlay';
import RegionSelector from './selection/RegionSelector';
import { TooltipShield } from './components/ui';
import './index.css';

class ErrorBoundary extends React.Component<
  { label: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[${this.props.label}] render error:`, error.message);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="h-screen bg-neutral-900 p-3 text-xs text-red-300">
          {this.props.label} error: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

// One html entry, three possible views selected via ?view=. The dashboard uses
// HashRouter (#/...), which is independent of the ?view= query.
const view = new URLSearchParams(window.location.search).get('view');

// The selection window is OPAQUE and paints the frozen screenshot as its
// background (see selectionWindow.ts). Match the body to the window's solid
// black so there's never a transparent/flashing gap before the frame paints.
if (view === 'selection') document.body.style.background = '#000000';

function View() {
  if (view === 'overlay')
    return (
      <ErrorBoundary label="overlay">
        <Overlay />
      </ErrorBoundary>
    );
  if (view === 'selection')
    return (
      <ErrorBoundary label="selector">
        <RegionSelector />
      </ErrorBoundary>
    );
  return (
    <ErrorBoundary label="dashboard">
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  );
}

function Root() {
  return (
    <>
      <View />
      {/* Replaces native `title` tooltips (separate OS windows that leak into
          screen shares) with an in-window tooltip. Covers every view. */}
      <TooltipShield />
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
