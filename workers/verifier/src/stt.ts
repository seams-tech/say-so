/**
 * Cloudflare Workers AI Speech-to-Text (`@cf/deepgram/nova-3` WebSocket streaming
 * + `@cf/openai/whisper-large-v3-turbo` batch fallback).
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
  transcribeBatch(canonicalWavB64: string): Promise<string | null>;
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

export function createWorkersAiSttProvider(ai: WorkersAiBinding): SttProvider {
  return {
    async openStream(onTranscript) {
      const response = (await ai.run(
        '@cf/deepgram/nova-3',
        {
          encoding: 'linear16',
          sample_rate: '16000',
          channels: '1',
          interim_results: 'true',
          numerals: 'true',
          smart_format: 'true',
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

    async transcribeBatch(canonicalWavB64: string): Promise<string | null> {
      try {
        const result = (await ai.run('@cf/openai/whisper-large-v3-turbo', {
          audio: canonicalWavB64,
          language: 'en',
        })) as { text?: string };
        return result.text?.trim() || null;
      } catch {
        return null;
      }
    },
  };
}
