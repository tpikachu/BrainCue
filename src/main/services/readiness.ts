import { cloudProvider } from '@shared/providers';
import { explainAnswerModel, type PolicyTask } from '@shared/modelPolicy';
import type { Readiness } from '@shared/types';
import { modelPreference, resolveTask } from './openai/models';
import { providerKeys } from './security/providerKeys';
import { readSttPrefs, sttReady } from './stt';

/** Can a chat task run — does the provider it resolves to have a key?
 *  Résumé/JD parsing used to require the OpenAI key specifically, so a user
 *  on Anthropic alone never got a parsed résumé (and the Interview activity,
 *  which needs one, never started). */
export function chatTaskReady(task: PolicyTask): boolean {
  return providerKeys.isPresent(resolveTask(task).provider);
}

/** User-facing reason a chat task can't run, naming its provider. */
export function chatTaskProblem(task: PolicyTask, toDo: string): string {
  const r = resolveTask(task);
  const name = cloudProvider(r.provider)?.name ?? r.provider;
  if (!Object.values(providerKeys.presence()).some(Boolean))
    return `Add an API key for an AI provider in Settings → Language Models to ${toDo}.`;
  // An override is pinned to its provider (never moved elsewhere), so the
  // fix is that provider's key or clearing the override.
  if (r.source === 'override')
    return `Your ${task} model override uses ${name}, which has no API key. Add the key, or clear the override in Settings → Language Models → Advanced, to ${toDo}.`;
  return `${name} is selected for this but has no API key. Add it, or pick a provider you have a key for, in Settings → Language Models to ${toDo}.`;
}

/**
 * Per-FEATURE readiness for the latency-tolerant features, so the renderer
 * gates each on what it actually needs — not on "is there an OpenAI key?",
 * which blocked an Anthropic-only user from parsing a résumé or drafting
 * stories that now run on Anthropic:
 *  - parsing (résumé/JD/company, briefs, stories): the parsing task's provider;
 *  - practice (mock, sparring): the mock task's provider AND OpenAI — the
 *    interviewer speaks (OpenAI TTS) and sparring transcribes (OpenAI);
 *  - tailoring: OpenAI only.
 * Each blocked feature carries the reason, naming the fix.
 */
export function featureReadiness(): Readiness['features'] {
  const openai = providerKeys.isPresent('openai');
  const gate = (ready: boolean, problem: string) => (ready ? { ready } : { ready, problem });
  return {
    parsing: gate(chatTaskReady('parsing'), chatTaskProblem('parsing', 'read résumés and job descriptions')),
    practice: gate(
      openai && chatTaskReady('mock'),
      !openai
        ? 'Practice speaks and listens through OpenAI, so it needs an OpenAI key — add one in Settings → Language Models.'
        : chatTaskProblem('mock', 'practise'),
    ),
    tailoring: gate(openai, 'Tailoring runs on OpenAI only for now — add an OpenAI key in Settings → Language Models.'),
  };
}

/**
 * What a live interview can rely on, per CAPABILITY — chat, transcription,
 * retrieval — instead of the old single "is there an OpenAI key?" gate,
 * which blocked a user with a perfectly good Anthropic key and the local
 * transcriber from ever starting.
 *
 * Every problem names the actual cause and the next action. Retrieval is
 * never a blocker: without an embedding key the documents are still used,
 * matched lexically, and the limitation is said out loud.
 */
export function getReadiness(): Readiness {
  const keys = providerKeys.presence();

  // ---- chat (detection + answers) ----
  const answer = resolveTask('answer');
  const classify = resolveTask('classify');
  const providerName = cloudProvider(answer.provider)?.name ?? answer.provider;
  const chatReady = !!keys[answer.provider] && !!keys[classify.provider];
  const chat: Readiness['chat'] = {
    ready: chatReady,
    provider: answer.provider,
    model: answer.model,
    classifyModel: classify.model,
    explanation: explainAnswerModel(answer, modelPreference()),
    ...(answer.notice ? { notice: answer.notice } : {}),
    ...(chatReady
      ? {}
      : Object.values(keys).some(Boolean)
        ? answer.source === 'override' || classify.source === 'override'
          ? {
              // A pinned override: never moved to another provider.
              problem: (answer.notice ?? classify.notice) || `${providerName} is selected for answers but has no API key.`,
              action: 'Add that key, or clear the override, in Settings → Language Models → Advanced.',
            }
          : {
              problem: `${providerName} is selected for answers but has no API key.`,
              action: 'Add its key, or pick a provider you have a key for, in Settings → Language Models.',
            }
        : {
            problem: 'No AI provider is set up — nothing can detect questions or write answers.',
            action: 'Add an API key for OpenAI, Anthropic, Google, Groq or OpenRouter in Settings → Language Models.',
          }),
  };

  // ---- transcription ----
  const stt = readSttPrefs();
  const sttOk = sttReady();
  const transcription: Readiness['transcription'] = {
    ready: sttOk,
    engine: stt.engine,
    ...(sttOk
      ? {}
      : stt.engine === 'local'
        ? {
            problem: 'The on-device transcription model is not downloaded yet.',
            action: 'Download it in Settings → Speech-to-Text (it runs offline afterwards).',
          }
        : {
            problem: 'Cloud transcription needs an OpenAI key, and none is stored.',
            action: 'Add an OpenAI key, or switch to the on-device engine in Settings → Speech-to-Text.',
          }),
  };

  // ---- retrieval ----
  const retrieval: Readiness['retrieval'] = keys.openai
    ? { ready: true, mode: 'embeddings' }
    : {
        ready: true,
        mode: 'lexical',
        note:
          'No OpenAI key, so documents are matched by keyword rather than meaning. Answers still use your résumé ' +
          'and the JD, but a question worded differently from your documents may miss a passage. Add an OpenAI key ' +
          'and re-save the profile to switch to semantic matching.',
      };

  return { chat, transcription, retrieval, features: featureReadiness() };
}
