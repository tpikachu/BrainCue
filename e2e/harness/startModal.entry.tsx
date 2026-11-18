/**
 * Renderer harness for the REAL StartSessionModal (startModal.race.spec.ts).
 *
 * Bundled by the spec with esbuild and served to headless Chromium. The page
 * defines `window.api` (a fake whose replies the test holds and releases)
 * and `window.__fixture` BEFORE this runs. Only the edges are stubbed: the
 * preload bridge, and `startNew`, which records the job id it was asked to
 * start instead of opening any capture. Everything between — the modal, its
 * effects, the stores, the checklist, the picker — is the shipped code.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { StartSessionModal } from '../../src/renderer/dashboard/StartSessionModal';
import { useLiveSession } from '../../src/renderer/store/useLiveSession';
import { useProfileStore } from '../../src/renderer/store/useProfileStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const w = window as any;
const fx = w.__fixture;

useProfileStore.setState({ profiles: fx.profiles, activeId: fx.profiles[0].id, loaded: true } as any);
useLiveSession.setState({
  session: null,
  startNew: async (a: { jobId?: string | null }) => {
    w.__fake.starts.push(a.jobId ?? null);
    return { ok: true, sessionId: 'harness-session' };
  },
} as any);

function Harness() {
  // Mirrors the Interview page: a row's Start sets the role and opens; closing
  // clears it.
  const [st, setSt] = useState<{ open: boolean; spaceId?: string }>({ open: false });
  w.__harness = {
    open: (spaceId?: string) => setSt({ open: true, spaceId }),
    close: () => setSt({ open: false }),
    setProfile: (id: string) => useProfileStore.setState({ activeId: id } as any),
  };
  return (
    <HashRouter>
      <StartSessionModal open={st.open} onClose={() => setSt({ open: false })} initialSpaceId={st.spaceId} />
    </HashRouter>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
