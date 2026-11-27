const utf8 = new TextEncoder();

export const INTENT_DIGEST_DOMAIN = utf8.encode('sayso:intent:v1\0');
/** The digest domain of a transcript-only intent (`CreateIntentOptions.transcriptOnly`). */
export const TRANSCRIPT_INTENT_DIGEST_DOMAIN = utf8.encode('sayso:intent:transcript:v1\0');
export const SPOKEN_TEXT_DIGEST_DOMAIN = utf8.encode('sayso:spoken:v1\0');
export const MAX_SENTENCE_WORDS = 16;

const MONEY_SYMBOLS: ReadonlyArray<readonly [string, string, string]> = [
  ['$', 'dollar', 'dollars'],
  ['\u20ac', 'euro', 'euros'],
  ['\u00a3', 'pound', 'pounds'],
];

const BELOW_TWENTY = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export interface SaySoIntentInput {
  user_id: string;
  action: string;
  payload_sha256_hex: string;
  sentence: string;
  /** Present only when the intent has guarded words. See `CreateIntentOptions.guardedWordIndexes`. */
  guarded_word_indexes?: number[];
  /** Present only for a transcript-only intent. See `CreateIntentOptions.transcriptOnly`. */
  transcript_only?: true;
}

export interface CreateIntentOptions {
  /** Any application user identifier (1..128 printable non-whitespace UTF-8 bytes), e.g. `alice@acme.com` or `usr_123`. */
  userId: string;
  /** Namespaced action identifier (1..64 chars of `a-z`, `0-9`, `.`, `_`, `-`, `:`, `/`), e.g. `stripe/payout`. */
  action: string;
  /** Raw payload bytes or UTF-8 string to hash with SHA-256. Mutually exclusive with `payloadSha256`. */
  payload?: Uint8Array | string;
  /** Pre-computed 32-byte or 64-char hex SHA-256 of the payload. Mutually exclusive with `payload`. */
  payloadSha256?: Uint8Array | string;
  /** Spoken sentence the user must say aloud (1..16 words; supports currency/numbers like `Approve payout $45`). */
  sentence: string;
  /**
   * Positions in `expectedTokens` where a misheard word is never forgiven, for example the
   * words of an amount and a recipient. Strictly ascending. The `intentDigest` covers them,
   * so a verdict for the same sentence without them does not match.
   */
  guardedWordIndexes?: readonly number[];
  /**
   * SaySo checks the speaker and the audio but not the words. An accepted verdict carries the
   * transcript as written in `heard`, and you decide whether it says the request. The
   * `intentDigest` has its own domain, so such a verdict never matches the digest of an intent
   * whose words SaySo checks. It cannot be used with `guardedWordIndexes`.
   */
  transcriptOnly?: boolean;
}

export interface BuiltSaySoIntent {
  /** Wire object sent to `/v1/stream`, `/v1/verify`, and `/v1/render`. */
  intent: SaySoIntentInput;
  /** Normalized lowercase spoken sentence (`approve payout forty five dollars`). */
  canonicalSentence: string;
  /** Expected canonical spoken tokens. */
  expectedTokens: string[];
  /** SHA-256 intent digest (32 bytes) to pass to `verifyVerdict({ intentDigest })`. */
  intentDigest: Uint8Array<ArrayBuffer>;
  /** SHA-256 spoken text digest (32 bytes). */
  spokenTextDigest: Uint8Array<ArrayBuffer>;
}

/**
 * Mirrors `sayso_wasm::words::normalize_sentence_tokens` so client and Worker compute
 * identical canonical sentences and `intent_digest` values.
 */
export function normalizeSentenceTokens(text: string): string[] | null {
  const out: string[] = [];
  for (const raw of text.trim().split(/\s+/)) {
    const edgeTrimmed = raw.replace(/^[,!?;:"().]+|[,!?;:"().]+$/g, '');
    if (!edgeTrimmed) continue;
    const lower = edgeTrimmed.toLowerCase();

    const money = MONEY_SYMBOLS.find(([sym]) => lower.startsWith(sym));
    if (money) {
      const rest = lower.slice(money[0].length);
      const expanded = expandNumberToken(rest);
      if (!expanded) return null;
      const isOne = rest.replace(/,/g, '').replace(/^0+/, '') === '1';
      out.push(...expanded, isOne ? money[1] : money[2]);
      continue;
    }

    if (lower.endsWith('%')) {
      const expanded = expandNumberToken(lower.slice(0, -1));
      if (!expanded) return null;
      out.push(...expanded, 'percent');
      continue;
    }

    const directNum = expandNumberToken(lower);
    if (directNum) {
      out.push(...directNum);
      continue;
    }

    for (const piece of lower.split(/[-/]/)) {
      if (!piece) continue;
      const num = expandNumberToken(piece);
      if (num) {
        out.push(...num);
        continue;
      }
      // Each run of letters is a word and each run of digits is a number, so "acct7" reads
      // "acct seven" and never the same as "acct9".
      const cleaned = piece.replace(/[^a-z0-9]/g, '');
      if (!cleaned) return null;
      for (const run of cleaned.match(/[a-z]+|[0-9]+/g) ?? []) {
        if (/^[0-9]/.test(run)) {
          const digits = expandNumberToken(run);
          if (!digits) return null;
          out.push(...digits);
        } else {
          out.push(run);
        }
      }
    }
  }
  return out.length > 0 ? out : null;
}

function expandNumberToken(token: string): string[] | null {
  const compact = token.replace(/,/g, '');
  if (!compact) return null;
  if (compact.includes('.')) {
    const parts = compact.split('.');
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
    const whole = integerToWords(Number(parts[0]));
    if (!whole) return null;
    const frac = Array.from(parts[1], (ch) => BELOW_TWENTY[Number(ch)]);
    return [...whole, 'point', ...frac];
  }
  if (!/^\d+$/.test(compact)) return null;
  if (compact.length > 1 && compact.startsWith('0')) {
    return Array.from(compact, (ch) => BELOW_TWENTY[Number(ch)]);
  }
  return integerToWords(Number(compact));
}

function integerToWords(n: number): string[] | null {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000) return null;
  if (n === 0) return ['zero'];
  const out: string[] = [];
  const thousands = Math.floor(n / 1_000);
  const rem = n % 1_000;
  if (thousands > 0) {
    pushUnderThousand(thousands, out);
    out.push('thousand');
  }
  if (rem > 0) pushUnderThousand(rem, out);
  return out;
}

function pushUnderThousand(n: number, out: string[]): void {
  const hundreds = Math.floor(n / 100);
  const rem = n % 100;
  if (hundreds > 0) out.push(BELOW_TWENTY[hundreds], 'hundred');
  if (rem >= 20) {
    out.push(TENS[Math.floor(rem / 10)]);
    if (rem % 10 > 0) out.push(BELOW_TWENTY[rem % 10]);
  } else if (rem > 0) {
    out.push(BELOW_TWENTY[rem]);
  }
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function resolvePayloadSha256(options: CreateIntentOptions): Promise<Uint8Array<ArrayBuffer>> {
  if ((options.payload === undefined) === (options.payloadSha256 === undefined)) {
    throw new RangeError('Provide either payload or payloadSha256 (not both).');
  }
  if (options.payload !== undefined) {
    const bytes = typeof options.payload === 'string' ? utf8.encode(options.payload) : options.payload;
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  }
  const digest = options.payloadSha256!;
  if (digest instanceof Uint8Array) {
    if (digest.length !== 32) throw new RangeError('payloadSha256 must be 32 bytes');
    return new Uint8Array(digest);
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new RangeError('payloadSha256 must be 64 lowercase hex characters');
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Builds a validated SaySo intent and computes its canonical SHA-256 `intentDigest`
 * and `spokenTextDigest` using standard WebCrypto (zero chain/Borsh dependencies).
 */
export async function createIntent(options: CreateIntentOptions): Promise<BuiltSaySoIntent> {
  const userBytes = utf8.encode(options.userId);
  if (userBytes.length === 0 || userBytes.length > 128 || userBytes.some((b) => b < 0x21 || b === 0x7f)) {
    throw new RangeError('userId must be 1..128 printable non-whitespace UTF-8 bytes');
  }
  if (!/^[a-z0-9._:/-]{1,64}$/.test(options.action)) {
    throw new RangeError('action must be 1..64 characters of a-z, 0-9, ".", "_", "-", ":", "/"');
  }
  const trimmedSentence = options.sentence.trim();
  if (!trimmedSentence || trimmedSentence.length > 160) {
    throw new RangeError('sentence must be 1..160 characters');
  }
  const expectedTokens = normalizeSentenceTokens(trimmedSentence);
  if (!expectedTokens || expectedTokens.length === 0 || expectedTokens.length > MAX_SENTENCE_WORDS) {
    throw new RangeError(`sentence must normalize to 1..${MAX_SENTENCE_WORDS} speakable words`);
  }
  const guardedWordIndexes = [...(options.guardedWordIndexes ?? [])];
  const ascendsInSentence = guardedWordIndexes.every(
    (index, at) =>
      Number.isInteger(index) &&
      index >= 0 &&
      index < expectedTokens.length &&
      (at === 0 || index > guardedWordIndexes[at - 1]),
  );
  if (!ascendsInSentence) {
    throw new RangeError('guardedWordIndexes must be strictly ascending positions in the normalized sentence');
  }
  const transcriptOnly = options.transcriptOnly === true;
  if (transcriptOnly && guardedWordIndexes.length > 0) {
    throw new RangeError('a transcriptOnly intent cannot have guardedWordIndexes');
  }
  const canonicalSentence = expectedTokens.join(' ');
  const payloadSha256 = await resolvePayloadSha256(options);

  // An intent with no guarded words keeps the digest that it had before guarded words.
  const intentPreimage = concatBytes([
    transcriptOnly ? TRANSCRIPT_INTENT_DIGEST_DOMAIN : INTENT_DIGEST_DOMAIN,
    lengthPrefixed(utf8.encode(options.userId)),
    lengthPrefixed(utf8.encode(options.action)),
    payloadSha256,
    lengthPrefixed(utf8.encode(canonicalSentence)),
    ...(guardedWordIndexes.length > 0 ? [lengthPrefixed(Uint8Array.from(guardedWordIndexes))] : []),
  ]);
  const spokenPreimage = concatBytes([SPOKEN_TEXT_DIGEST_DOMAIN, utf8.encode(canonicalSentence)]);

  const [intentDigestBuf, spokenTextDigestBuf] = await Promise.all([
    crypto.subtle.digest('SHA-256', intentPreimage),
    crypto.subtle.digest('SHA-256', spokenPreimage),
  ]);

  return {
    intent: {
      user_id: options.userId,
      action: options.action,
      payload_sha256_hex: toHex(payloadSha256),
      sentence: trimmedSentence,
      ...(guardedWordIndexes.length > 0 ? { guarded_word_indexes: guardedWordIndexes } : {}),
      ...(transcriptOnly ? { transcript_only: true as const } : {}),
    },
    canonicalSentence,
    expectedTokens,
    intentDigest: new Uint8Array(intentDigestBuf),
    spokenTextDigest: new Uint8Array(spokenTextDigestBuf),
  };
}
