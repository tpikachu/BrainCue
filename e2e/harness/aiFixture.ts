/**
 * The AI-01 configuration, shared by the model-label, settings-order and
 * catalog-bounds specs: Anthropic answers the interview, the coding solver is
 * overridden to OpenAI, and both providers have keys (so the pickers show the
 * full OpenAI + Anthropic catalog — the size that clipped in UI-03).
 */
export const SETTINGS = {
  stt: { engine: 'local', localModelId: 'x' },
  audio: { micDeviceId: null },
  companionPrefs: null,
  providerKeys: { openai: true, anthropic: true },
  sttReady: true,
  memoryEnabled: false,
  sessionArchiveEnabled: true,
  codingLanguage: 'javascript',
  chatProvider: 'anthropic',
  models: { coding: 'gpt-6.2-astra' },
  // The OpenAI preset table: what the chip used to show for "answer".
  modelDefaults: { answer: 'gpt-6-luna', coding: 'gpt-6.2-astra' },
  // Main's resolution: what the next request for each task really uses.
  effectiveModels: { answer: 'anthropic/claude-sonnet-5-5', coding: 'gpt-6.2-astra', classify: 'anthropic/claude-haiku-5-5' },
  autoModels: { answer: 'anthropic/claude-sonnet-5-5', coding: 'anthropic/claude-opus-5-5', classify: 'anthropic/claude-haiku-5-5' },
  modelNotices: {},
  reasoningEfforts: {},
  openaiInterviewFast: true,
  reasoningEffortDefaults: { coding: 'low' },
};

export const FIXTURE = {
  profiles: [{ id: 'pA', name: 'Alex', parsedResume: { skills: ['TS'] }, resumeText: 'Resume' }],
  roles: [{ id: 'A', profileId: 'pA', kind: 'job', title: 'Backend Engineer', company: 'Acme', jdText: 'JD', parsedJd: { requirements: ['TS'] } }],
  sessions: { pA: [] },
  settings: SETTINGS,
  readiness: {
    chat: { ready: true, provider: 'anthropic', model: 'm', classifyModel: 'm', explanation: 'Ready' },
    transcription: { ready: true, engine: 'local' },
    retrieval: { ready: true, mode: 'lexical' },
    // Deliberately NOT the answer's provider: a card must name where ITS
    // sources went, not where the next request would go.
    routes: { answer: 'openai', classify: 'anthropic', parsing: 'anthropic' },
    features: {},
  },
};

/** A settings snapshot as main would send it after a change: the stored
 *  overrides plus the routes they resolve to. */
export function snapshot(change: {
  models?: Record<string, string>;
  efforts?: Record<string, string>;
  effective?: Record<string, string>;
  notices?: Record<string, string>;
}) {
  return {
    ...SETTINGS,
    models: change.models ?? SETTINGS.models,
    reasoningEfforts: change.efforts ?? SETTINGS.reasoningEfforts,
    effectiveModels: { ...SETTINGS.effectiveModels, ...change.effective },
    modelNotices: change.notices ?? {},
  };
}
