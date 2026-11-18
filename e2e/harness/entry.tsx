/**
 * Renderer harness entry (harness.ts): mounts ONE real component per
 * `?view=`, against the fake bridge the page installed before this ran.
 * Everything between the bridge and the screen — components, effects,
 * stores, the shared UI kit — is the shipped code (imported through `@app`,
 * so HARNESS_ROOT can point it at an earlier checkout).
 *
 *  - `startModal`: the start flow (M5 race cases; M6 Resume).
 *  - `sessions`: the Sessions page with its detail view (M6 offline history).
 *  - `savePrompt`: the Keep / Discard prompt (M6 truthful results).
 *  - `overlay`: the Cue Card, driven by fake main events.
 *  - `jobForm`: the role form (M6 drafts, keyboard).
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { StartSessionModal } from '@app/dashboard/StartSessionModal';
import { SavePromptModal } from '@app/dashboard/SavePromptModal';
import { JobFormModal } from '@app/dashboard/JobFormModal';
import SessionsPage from '@app/dashboard/pages/SessionsPage';
import Overlay from '@app/overlay/Overlay';
import { TooltipShield } from '@app/components/ui';
import { useLiveSession } from '@app/store/useLiveSession';
import { useProfileStore } from '@app/store/useProfileStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const w = window as any;
const fx = w.__fixture;
const view = new URLSearchParams(location.search).get('view') || 'startModal';

useProfileStore.setState({ profiles: fx.profiles, activeId: fx.profiles?.[0]?.id ?? null, loaded: true } as any);
useLiveSession.setState({
  session: null,
  startNew: async (a: { jobId?: string | null }) => {
    w.__fake.starts.push(a.jobId ?? null);
    return { ok: true, sessionId: 'harness-session' };
  },
  resumeExisting: async (a: { sessionId: string }) => {
    w.__fake.resumes.push(a.sessionId);
    return { ok: true, sessionId: a.sessionId };
  },
} as any);

const common = {
  setProfile: (id: string) => useProfileStore.setState({ activeId: id } as any),
  /** A session just stopped: the save prompt opens for it. */
  prompt: (p: unknown) => useLiveSession.setState({ pendingSave: p } as any),
  pendingSave: () => useLiveSession.getState().pendingSave,
};

function StartModalHarness() {
  // Mirrors the Interview page: a row's Start sets the role and opens; closing clears it.
  const [st, setSt] = useState<{ open: boolean; spaceId?: string; resume?: unknown }>({ open: false });
  w.__harness = {
    ...common,
    open: (spaceId?: string) => setSt({ open: true, spaceId }),
    resume: (s: unknown) => setSt({ open: true, resume: s }),
    close: () => setSt({ open: false }),
  };
  return (
    <StartSessionModal
      open={st.open}
      onClose={() => setSt({ open: false })}
      initialSpaceId={st.spaceId}
      {...({ resume: st.resume } as any)}
    />
  );
}

function JobFormHarness() {
  const [st, setSt] = useState<{ open: boolean; job: unknown }>({ open: false, job: null });
  w.__harness = {
    ...common,
    open: (job: unknown = null) => setSt({ open: true, job }),
    isOpen: () => st.open,
  };
  return (
    <>
      <button id="opener" onClick={() => setSt({ open: true, job: null })}>
        Open the role form
      </button>
      <JobFormModal open={st.open} profileId={fx.profiles[0].id} job={st.job as any} initialKind="job" lockKind onClose={() => setSt({ open: false, job: null })} onSaved={() => {}} />
    </>
  );
}

function Root() {
  if (view === 'sessions') {
    w.__harness = common;
    return <SessionsPage />;
  }
  if (view === 'savePrompt') {
    w.__harness = common;
    return <SavePromptModal />;
  }
  if (view === 'overlay') {
    w.__harness = common;
    return <Overlay />;
  }
  if (view === 'jobForm') return <JobFormHarness />;
  return <StartModalHarness />;
}

createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <TooltipShield />
    <Root />
  </HashRouter>,
);
