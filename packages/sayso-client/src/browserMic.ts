import { float32ToPcm16, SAMPLE_RATE } from './pcm.ts';

export interface LivePcmCaptureOptions {
  /** RMS level threshold for speech activity. Default: 0.008. */
  rmsThreshold?: number;
  /** Silence pause after speech begins before triggering `onSpeechEnd`. Default: 480 ms. */
  silenceEndMs?: number;
  /** Max capture duration in ms. Default: 8,000 ms. */
  maxDurationMs?: number;
  signal?: AbortSignal;
  onFrame: (pcmFrame: Int16Array, rms: number, speaking: boolean) => void;
  onSpeechEnd?: () => void;
}

const WORKLET_CODE = `
class SaySoPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const take = Math.min(512 - this.offset, channel.length - i);
      this.buf.set(channel.subarray(i, i + take), this.offset);
      this.offset += take;
      i += take;
      if (this.offset === 512) {
        const out = this.buf.slice();
        this.port.postMessage(out, [out.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('sayso-pcm-frames', SaySoPcmProcessor);
`;

/**
 * Captures 16 kHz mono PCM16 frames directly from an `AudioWorklet` with zero
 * `MediaRecorder` / `OfflineAudioContext` post-stop overhead.
 */
export async function startLiveMicrophonePcm(options: LivePcmCaptureOptions): Promise<{ stop: () => Promise<void> }> {
  const rmsThreshold = options.rmsThreshold ?? 0.008;
  const silenceEndMs = options.silenceEndMs ?? 480;
  const maxDurationMs = options.maxDurationMs ?? 8_000;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
  let closed = false;
  let hasSpoken = false;
  let voicedMs = 0;
  let lastSpeechAt = 0;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(maxTimer);
    URL.revokeObjectURL(blobUrl);
    for (const track of stream.getTracks()) track.stop();
    await context.close().catch(() => {});
  };

  const maxTimer = setTimeout(() => {
    options.onSpeechEnd?.();
    void cleanup();
  }, maxDurationMs);

  options.signal?.addEventListener(
    'abort',
    () => {
      void cleanup();
    },
    { once: true },
  );

  try {
    await context.audioWorklet.addModule(blobUrl);
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, 'sayso-pcm-frames');
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (closed) return;
      const floatFrame = event.data;
      let energy = 0;
      for (let i = 0; i < floatFrame.length; i += 1) {
        energy += floatFrame[i] * floatFrame[i];
      }
      const rms = Math.sqrt(energy / floatFrame.length);
      const speaking = rms >= rmsThreshold;
      const now = performance.now();
      const frameMs = (floatFrame.length / SAMPLE_RATE) * 1_000;

      if (speaking) {
        voicedMs += frameMs;
        if (voicedMs >= 160) {
          hasSpoken = true;
          lastSpeechAt = now;
        }
      } else if (hasSpoken && voicedMs >= 640 && now - lastSpeechAt >= silenceEndMs) {
        options.onSpeechEnd?.();
      }

      const pcm16 = float32ToPcm16(floatFrame);
      floatFrame.fill(0);
      options.onFrame(pcm16, rms, speaking);
    };
    source.connect(worklet);
    worklet.connect(context.destination);
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { stop: cleanup };
}
