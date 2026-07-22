/**
 * The hard privacy gate for memory extraction: content matching any of these
 * classes is NEVER stored — not flagged, not queued, REJECTED before it
 * touches the database. Deterministic and conservative by design (a false
 * positive costs one lost memory; a false negative stores a secret).
 */

interface SensitiveRule {
  reason: string;
  pattern: RegExp;
}

const RULES: SensitiveRule[] = [
  // Secrets & credentials
  {
    reason: 'credential',
    pattern:
      /\b(password|passcode|passphrase|api[ -]?key|secret[ -]?key|access[ -]?token|private[ -]?key|2fa|otp|recovery (code|phrase)|seed phrase)\b/i,
  },
  { reason: 'credential', pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/ }, // OpenAI-style keys
  { reason: 'credential', pattern: /\bAKIA[0-9A-Z]{16}\b/ }, // AWS access key ids
  { reason: 'credential', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },

  // Payment data
  { reason: 'payment', pattern: /\b(?:\d[ -]?){13,19}\b/ }, // card-number shapes
  {
    reason: 'payment',
    pattern: /\b(cvv|cvc|card number|credit card|debit card|iban|swift|routing number|account number|bank account)\b/i,
  },

  // Government identifiers
  { reason: 'government-id', pattern: /\b\d{3}-\d{2}-\d{4}\b/ }, // SSN shape
  {
    reason: 'government-id',
    pattern: /\b(social security|passport number|driver'?s licen[cs]e number|national id)\b/i,
  },

  // Health details
  {
    reason: 'health',
    pattern:
      /\b(diagnos\w+|medication|prescri\w+|therap(y|ist)|psychiatr\w+|mental health|chronic (illness|condition)|disease|disorder|cancer|hiv|aids|diabet\w+|pregnan\w+|surgery)\b/i,
  },

  // Highly sensitive personal attributes
  {
    reason: 'sensitive-personal',
    pattern:
      /\b(religio\w+|political (affiliation|party|views)|sexual orientation|sexuality|immigration status|criminal record|ethnicity)\b/i,
  },
];

export interface SensitiveVerdict {
  sensitive: boolean;
  reason: string | null;
}

export function checkSensitive(content: string): SensitiveVerdict {
  for (const rule of RULES) {
    if (rule.pattern.test(content)) return { sensitive: true, reason: rule.reason };
  }
  return { sensitive: false, reason: null };
}
