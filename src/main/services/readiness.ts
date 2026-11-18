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
        ? {
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

  return { chat, transcription, retrieval };
}
