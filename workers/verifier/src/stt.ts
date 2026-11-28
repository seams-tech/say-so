/**
 * Cloudflare Workers AI Speech-to-Text (`@cf/deepgram/nova-3` WebSocket streaming
 * + `@cf/openai/whisper-large-v3-turbo` batch, with a hedged second call).
 */

export interface SttTranscriptEvent {
  transcript: string;
  isFinal: boolean;
  speechFinal: boolean;
}

export interface SttLiveStream {
  sendPcmChunk(pcmLeBytes: Uint8Array): void;
  injectMockTranscript?(ev: SttTranscriptEvent): void;
  finishAndFlush(): Promise<string | null>;
  close(): void;
}

export interface SttProvider {
  openStream(onTranscript: (ev: SttTranscriptEvent) => void): Promise<SttLiveStream>;
  /** `ms`, when given, receives `stt_calls` and `stt_answer` (see `firstAnswer`). */
  transcribeBatch(canonicalWavB64: string, ms?: Record<string, number>): Promise<string | null>;
}

/**
 * The batch call starts a second, equal call when the first has not answered in this time.
 * The time of one turbo call on Workers AI has a long tail that does not depend on the audio
 * (0.6 s to 5.6 s for 2 s of audio, bench/g3), so a second call often answers first.
 */
export const STT_HEDGE_AFTER_MS = 1_500;

/**
 * Runs `call`, and runs it once more when it has not answered after `hedgeAfterMs` or when it
 * fails before then. Gives the first answer; `null` from `call` is a failure. Gives `null` only
 * when every call failed. Records in `ms` the number of calls (`stt_calls`) and which call gave
 * the answer (`stt_answer`: 1 or 2, or 0 for none). The other call is not stopped, and Workers
 * AI bills it.
 */
export function firstAnswer<T>(
  call: () => Promise<T | null>,
  hedgeAfterMs: number,
  ms?: Record<string, number>,
): Promise<T | null> {
  return new Promise((resolve) => {
    let started = 0;
    let failed = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (answer: T | null, index: number) => {
      settled = true;
      clearTimeout(timer);
      if (ms) ms.stt_answer = index;
      resolve(answer);
    };
    const launch = () => {
      started += 1;
      const index = started;
      if (ms) ms.stt_calls = started;
      void Promise.resolve()
        .then(call)
        .catch(() => null)
        .then((answer) => {
          if (settled) return;
          if (answer !== null) return settle(answer, index);
          failed += 1;
          if (started < 2) {
            clearTimeout(timer);
            launch();
          } else if (failed === started) {
            settle(null, 0);
          }
        });
    };
    launch();
    timer = setTimeout(() => {
      if (!settled && started < 2) launch();
    }, hedgeAfterMs);
  });
}

interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

interface DeepgramWsMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string }>;
  };
}

export function createWorkersAiSttProvider(
  ai: WorkersAiBinding,
  options: { hedgeAfterMs?: number } = {},
): SttProvider {
  const hedgeAfterMs = options.hedgeAfterMs ?? STT_HEDGE_AFTER_MS;
  return {
    async openStream(onTranscript) {
      const response = (await ai.run(
        '@cf/deepgram/nova-3',
        {
          encoding: 'linear16',
          sample_rate: '16000',
          channels: '1',
          interim_results: 'true',
          // No `numerals` and no `smart_format`: the words as spoken. With them, Nova-3 drops
          // a spoken "point", so "nine hundred sixty two point one" reads "9621" and pays a
          // request for 9,621 (bench/stt1, 2026-11-27). Without them it also reads more of the
          // STT-1 sentences correctly.
          endpointing: '300',
        },
        { websocket: true },
      )) as Response & { webSocket?: WebSocket };

      const ws = response.webSocket;
      if (!ws) {
        throw new Error('Workers AI @cf/deepgram/nova-3 did not return an upgraded WebSocket');
      }
      ws.accept();

      const finalizedSegments: string[] = [];
      let latestInterim = '';
      let closed = false;
      let resolveFlush: ((text: string | null) => void) | null = null;

      const fullTranscript = () =>
        [...finalizedSegments, latestInterim]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(' ');

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let parsed: DeepgramWsMessage;
        try {
          parsed = JSON.parse(event.data) as DeepgramWsMessage;
        } catch {
          return;
        }
        if (parsed.type === 'Metadata' || parsed.type === 'UtteranceEnd') {
          if (parsed.type === 'UtteranceEnd' && resolveFlush) {
            const done = resolveFlush;
            resolveFlush = null;
            done(fullTranscript() || null);
          }
          return;
        }
        const piece = parsed.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
        const isFinal = Boolean(parsed.is_final);
        const speechFinal = Boolean(parsed.speech_final);
        if (isFinal) {
          if (piece) finalizedSegments.push(piece);
          latestInterim = '';
        } else {
          latestInterim = piece;
        }
        const combined = fullTranscript();
        if (combined) {
          onTranscript({
            transcript: combined,
            isFinal,
            speechFinal,
          });
        }
        if (speechFinal && resolveFlush) {
          const done = resolveFlush;
          resolveFlush = null;
          done(combined || null);
        }
      });

      ws.addEventListener('close', () => {
        closed = true;
        if (resolveFlush) {
          const done = resolveFlush;
          resolveFlush = null;
          done(fullTranscript() || null);
        }
      });

      return {
        sendPcmChunk(pcmLeBytes: Uint8Array) {
          if (!closed && ws.readyState === WebSocket.OPEN) {
            ws.send(pcmLeBytes);
          }
        },
        finishAndFlush(): Promise<string | null> {
          if (closed || ws.readyState !== WebSocket.OPEN) {
            return Promise.resolve(fullTranscript() || null);
          }
          return new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => {
              resolveFlush = null;
              resolve(fullTranscript() || null);
            }, 350);
            resolveFlush = (val) => {
              clearTimeout(timer);
              resolve(val);
            };
            try {
              ws.send(JSON.stringify({ type: 'CloseStream' }));
            } catch {
              clearTimeout(timer);
              resolve(fullTranscript() || null);
            }
          });
        },
        close() {
          if (!closed) {
            closed = true;
            try {
              ws.close();
            } catch {
              // Ignore already-closed WebSocket.
            }
          }
        },
      };
    },

    async transcribeBatch(canonicalWavB64, ms) {
      const once = async () => {
        const result = (await ai.run('@cf/openai/whisper-large-v3-turbo', {
          audio: canonicalWavB64,
          language: 'en',
        })) as { text?: string };
        return { text: result.text?.trim() || null };
      };
      const answer = await firstAnswer(once, hedgeAfterMs, ms);
      return answer?.text ?? null;
    },
  };
}
