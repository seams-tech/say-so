/**
 * WebCrypto Ed25519 verdict signer (`extractable: false`) + speaker-embedding signature check.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SPEAKER_EMBED_DOMAIN = new TextEncoder().encode('seams:speaker-embedding:v1');

/** Standard PKCS#8 ASN.1 prefix for a 32-byte Ed25519 private seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface VerdictSigner {
  readonly publicKeyNear: string;
  readonly publicKeyBytes: Uint8Array;
  signMessageB64(messageB64: string): Promise<string>;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new RangeError('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i]];
  }
  return out;
}

/**
 * Imports a 32-byte hex Ed25519 seed into WebCrypto as a non-extractable signing key,
 * and derives its `ed25519:<base58>` public key.
 */
export async function createVerdictSignerFromSeedHex(seedHex: string): Promise<VerdictSigner> {
  const seed = fromHex(seedHex);
  if (seed.length !== 32) {
    throw new RangeError('VERDICT_SECRET_KEY_HEX must be 64 hex characters (32 bytes)');
  }
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);

  // Import once extractable strictly to derive the JWK `x` public key coordinate,
  // then wipe raw seed bytes and hold only a non-extractable CryptoKey in memory.
  const tempKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = (await crypto.subtle.exportKey('jwk', tempKey)) as JsonWebKey;
  pkcs8.fill(0);
  seed.fill(0);
  if (typeof jwk.x !== 'string' || jwk.x.length === 0) {
    throw new Error('Failed to derive Ed25519 public key from seed');
  }
  const b64 = jwk.x.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(jwk.x.length / 4) * 4, '=');
  const publicKeyBytes = fromBase64(b64);
  const publicKeyNear = `ed25519:${encodeBase58(publicKeyBytes)}`;

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, key_ops: ['sign'] },
    { name: 'Ed25519' },
    false,
    ['sign'],
  );

  return {
    publicKeyNear,
    publicKeyBytes,
    async signMessageB64(messageB64: string): Promise<string> {
      const msg = fromBase64(messageB64);
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, msg);
      return toBase64(new Uint8Array(sig));
    },
  };
}

/** Verifies the Ed25519 signature returned by `speaker-service` `/v1/embed`. */
export async function verifySpeakerServiceReply(params: {
  embeddingB64: string;
  audioDigestHex: string;
  nonceHex: string;
  modelSha256Hex: string;
  publicKeyHex: string;
  signatureHex: string;
  expectedAudioDigestHex: string;
  expectedNonceHex: string;
  expectedModelSha256Hex: string;
  pinnedPublicKeyHex?: string;
}): Promise<boolean> {
  if (
    params.audioDigestHex.toLowerCase() !== params.expectedAudioDigestHex.toLowerCase() ||
    params.nonceHex.toLowerCase() !== params.expectedNonceHex.toLowerCase() ||
    params.modelSha256Hex.toLowerCase() !== params.expectedModelSha256Hex.toLowerCase()
  ) {
    return false;
  }
  if (
    params.pinnedPublicKeyHex &&
    params.publicKeyHex.toLowerCase() !== params.pinnedPublicKeyHex.toLowerCase()
  ) {
    return false;
  }
  const embeddingBytes = fromBase64(params.embeddingB64);
  if (embeddingBytes.length !== 192 * 4) return false;

  const audioDigest = fromHex(params.audioDigestHex);
  const nonce = fromHex(params.nonceHex);
  const modelSha = fromHex(params.modelSha256Hex);
  const pubKeyBytes = fromHex(params.publicKeyHex);
  const sigBytes = fromHex(params.signatureHex);
  if (pubKeyBytes.length !== 32 || sigBytes.length !== 64) return false;

  const preimage = new Uint8Array(
    SPEAKER_EMBED_DOMAIN.length + audioDigest.length + nonce.length + modelSha.length + embeddingBytes.length,
  );
  let offset = 0;
  for (const part of [SPEAKER_EMBED_DOMAIN, audioDigest, nonce, modelSha, embeddingBytes]) {
    preimage.set(part, offset);
    offset += part.length;
  }
  const message = new Uint8Array(await crypto.subtle.digest('SHA-256', preimage));
  const key = await crypto.subtle.importKey('raw', new Uint8Array(pubKeyBytes), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, new Uint8Array(sigBytes), message);
}
