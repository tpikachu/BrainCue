# API Key Security Plan

> v2 provider layer: the OpenAI adapters in `src/main/providers/openai` never
> read or store keys — they delegate to the existing service modules, so the
> OpenAI key still flows exclusively through `services/openai/client.ts` (and
> `realtime.ts` for the socket header). Since v2.2 the other providers
> (Anthropic, Google Gemini, Groq, OpenRouter) follow the same shape through
> **one** store, `services/security/providerKeys.ts` — see "Keys per provider"
> below: main process only, safeStorage at rest, resolved per provider at call
> time, never over IPC. The architecture test pins that no key-store or API
> host markers enter the renderer bundle.

## Principles
1. The OpenAI API key is **only** ever present in the **main process** memory.
2. It is **never** sent over IPC to the renderer.
3. It is **never** hardcoded.
4. It is **never** committed (`.env` is gitignored; only `.env.example` exists).
5. It is **never** logged (logger redacts anything matching `sk-...`).

## Sources & precedence (main process)
1. **Dev**: `process.env.OPENAI_API_KEY` (from `.env`, loaded only in dev).
2. **User-provided**: pasted in Settings → encrypted at rest in SQLite.

Resolution order at call time: env var (if set) → decrypted stored key. If
neither exists, OpenAI calls fail fast with a clear "No API key configured" error
and the UI prompts the user to add one.

## Storage at rest
Primary backend: **Electron `safeStorage`**.
```ts
import { safeStorage } from 'electron';
// save:
const cipher = safeStorage.encryptString(plaintextKey);     // Buffer
settings.set('openai_api_key_enc', cipher.toString('base64'));
settings.set('openai_api_key_present', '1');
// load (main only):
const enc = settings.get('openai_api_key_enc');
const key = enc ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : null;
```
- `safeStorage` uses the OS keychain/DPAPI under the hood (macOS Keychain,
  Windows DPAPI, libsecret on Linux) to protect the encryption key.
- **Fallback**: if `safeStorage.isEncryptionAvailable()` is false (some Linux
  setups), warn the user and optionally fall back to `keytar`, behind the same
  `ApiKeyStore` interface. Never silently store plaintext.

## Interface (`services/security/apiKey.ts`)
```ts
interface ApiKeyStore {
  isPresent(): boolean;          // safe to expose via IPC (boolean only)
  set(plaintext: string): void;  // encrypts + persists
  clear(): void;
  getDecrypted(): string | null; // MAIN ONLY — never crosses IPC
}
```

## What the renderer can know
- Only a boolean `apiKeyPresent` (from `settings:get`).
- A masked display like `sk-…last4` is **not** provided by default (last-4 could
  be added later if desired; MVP exposes presence only).

## Keys per provider (v2.2, `services/security/providerKeys.ts`)
Every cloud provider in `shared/providers.ts` gets its own key under exactly
the rules above — the principles are per key, not per vendor:
- **Storage**: `provider_key_enc:<provider>` (safeStorage ciphertext, base64) +
  `provider_key_present:<provider>` ('1'/'0') in the settings table. `openai`
  delegates to `apiKeyStore`, so there is ONE OpenAI key wherever it was
  entered (old field, Language Models panel, or the dev env var).
- **Interface**: `isPresent(p)` / `presence()` (booleans — the only shape that
  crosses IPC), `set(p, plaintext)`, `clear(p)`, and `getDecrypted(p)` — **MAIN
  ONLY**, never returned over IPC.
- **Resolution at call time**: an adapter asks `providers/keys.ts`
  (`requireProviderKey`) when a task actually routes to it — the store is
  imported lazily there so the registry stays loadable without the DB. No key
  → the call fails fast with "<Provider> needs an API key — add one in
  Settings → Language Models." Clients are cached per key fingerprint
  (`length:last4`), never the key itself, and rebuilt when it changes.
- **Test flow**: `providers/testKey.ts` does a cheap `GET /models` per provider
  and returns `{ ok, model }` or a user-safe `{ ok:false, error }` — vendor
  SDK errors are normalized (`normalizeProviderError` / `normalizeCompatError`)
  and never carry the key.
- **Logging**: the logger's `sk-…` redaction covers OpenAI, Anthropic (`sk-ant-`)
  and OpenRouter (`sk-or-`) keys; Google and Groq keys are never logged either
  — adapters log nothing about a request but its outcome.

## Test flow
`settings:test-api-key` does a cheap call (e.g. list models / tiny embedding) in
main and returns `{ ok, model }` or `{ ok:false, error }` — without revealing the
key.

## Logging & telemetry
- Central logger redacts `sk-[A-Za-z0-9_\-]+` from all output.
- No analytics/telemetry leaves the machine in MVP.

## Threat notes
- A compromised renderer cannot exfiltrate the key (it never has it).
- Disk theft is mitigated by OS-backed encryption; not a substitute for full-disk
  encryption, which we recommend in docs.

## Memory privacy

The local memory subsystem's standing guarantees:
- **No capture before consent**: the global switch (`memory_enabled`) defaults
  OFF; extraction and recall are both gated on it (plus a per-Space opt-out).
- **Sensitive content is never stored**: `services/memory/sensitiveFilter.ts`
  rejects secrets/credentials, payment data, government IDs, health details,
  and sensitive personal attributes BEFORE persistence — extraction drops the
  candidate, and review/edit paths refuse the write. Prompt-level instructions
  are defense in depth, the filter is the gate.
- **No cloud sync**: memories live only in the local SQLite database.
- **Deletion is complete**: the embedding lives ON the memory row, so deleting
  a memory removes its vector in the same statement; profile deletion (and the
  data wipe) cascades through `memories` via FK.
- **Provenance is visible**: every recalled memory appears in the Cue Card's
  "data sent" panel and in the contribution's sourceRefs.

## Voice privacy

The voice/summon layer's standing guarantees:
- **Push-to-talk only**: the microphone opens exclusively for an explicit
  summon (hotkey or Cue Card button) and is released when the turn ends —
  there is no standing voice capture. PCM frames are buffered in the MAIN
  process only while the dialogue state is `listening`, sent to the STT
  provider once, and dropped; they are never persisted or echoed back.
- **Key isolation unchanged**: STT and TTS both run in main through the
  provider capability seam. The renderer receives only synthesized audio
  segments and state events — never the API key or raw request material.
- **Nothing is spoken unprompted**: only summoned replies reach TTS (ambient
  cards are text-only by construction), the hard mute wins over everything,
  and a hard-paused session pauses voice with it.
- **No audio in logs**: log lines carry messages/lengths only — never PCM
  buffers or base64 segments (pinned by `voiceService.test.ts`).
- **Persistence follows user settings**: an in-session summon persists exactly
  like a typed ask (part of that session); a no-session quick ask is ephemeral
  unless `saveQuickAsks` is enabled (see 04-DATABASE `voice_prefs`).

### Encryption at rest — design (implementation deferred)

Goal: memory `content` unreadable if `app.db` is copied off the machine,
without breaking migrations or packaging.

- **Key**: one random 256-bit data key, generated on first use, wrapped with
  Electron `safeStorage` (DPAPI / Keychain / libsecret) and stored in the
  settings table (`memory_key_enc`). The PLAINTEXT data key exists only in
  main-process memory. This is the same trust anchor as the API key — no new
  primitives.
- **Cipher**: AES-256-GCM per row (`iv ‖ tag ‖ ciphertext` in a BLOB column),
  Node `crypto` only — no native deps, so electron-builder packaging and the
  better-sqlite3 ABI story are untouched (packaging-safe).
- **Scope**: encrypt `memories.content` (and future memory exports) ONLY.
  Embedding vectors stay plaintext — they are not meaningfully invertible and
  must remain scannable for recall; FTS/lexical search moves in-process after
  decrypt (recall already loads candidate rows).
- **Migration story**: a lazy dual-read (`content` TEXT nullable +
  `content_enc` BLOB nullable): new writes encrypt; reads prefer `content_enc`;
  a one-time background pass re-encrypts old rows, then `content` is dropped in
  a later migration. Rollback-safe at every step.
- **Failure modes (why it's deferred)**: `safeStorage` unavailable (some Linux
  keyrings) would need an explicit user choice (plaintext with a warning vs no
  memory); OS-profile loss orphans the wrapped key (memory becomes
  unrecoverable — acceptable for memory, must be TOLD to the user). Shipping
  this needs those two UX decisions, not more code.
