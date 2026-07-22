# API Key Security Plan

> v2 provider layer: `src/main/providers/*` never reads or stores keys — every
> OpenAI adapter delegates to the existing service modules, so the key still
> flows exclusively through `services/openai/client.ts` (and `realtime.ts` for
> the socket header). Additional providers must follow the same shape: keys
> live in the main process behind safeStorage, resolved per provider at call
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
