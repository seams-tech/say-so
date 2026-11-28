// The test voice of the G3 tools: macOS `say` (Samantha), so no recording of a person leaves
// this machine. Gives the canonical 16 kHz WAV in base64 and its length.
import { execFileSync } from 'node:child_process';
import { pcm16ToCanonicalWav } from '../../packages/sayso-verdict/src/index.ts';

export const VOICE = 'Samantha';

export function speak(work: string, text: string, name: string): { b64: string; seconds: number } {
  const aiff = `${work}/${name}.aiff`;
  execFileSync('say', ['-v', VOICE, '-r', '180', '-o', aiff, text]);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  return { b64: Buffer.from(pcm16ToCanonicalWav(pcm)).toString('base64'), seconds: pcm.length / 16_000 };
}

export function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
