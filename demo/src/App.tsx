import { useEffect, useMemo, useState } from 'react';
import {
  pcm16ToCanonicalWav,
  SaySoClient,
  startLiveMicrophonePcm,
  type SaySoRequestInput,
  type VerifyWireOutput,
} from '@seams/sayso-client';
import { confirmationRequest, type VerdictCheck } from '@seams/voice-verdict';

const DEFAULT_WORKER_URL = import.meta.env.VITE_SAYSO_URL ?? 'http://localhost:8787';

interface BrowserSpeechRecognitionEvent {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: BrowserSpeechRecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

interface Preset {
  id: string;
  label: string;
  owner: string;
  request: SaySoRequestInput;
  payloadText?: string;
}

const PRESETS: Preset[] = [
  {
    id: 'agent-payout',
    label: 'AI Agent Payout ($45)',
    owner: 'app:sayso-demo',
    payloadText: '{"recipient":"acct_9182","amount_usd":45}',
    request: {
      kind: 'confirmation',
      context: 'stripe/payout',
      payload_sha256_hex: '0'.repeat(64),
      summary: 'approve payout forty five dollars',
    },
  },
  {
    id: 'agent-deploy',
    label: 'DevOps Production Deploy',
    owner: 'app:sayso-demo',
    payloadText: '{"service":"payments-api","release":"2.4"}',
    request: {
      kind: 'confirmation',
      context: 'github/deploy',
      payload_sha256_hex: '0'.repeat(64),
      summary: 'deploy release two four to production',
    },
  },
  {
    id: 'near-transfer',
    label: 'NEAR Transfer (2 NEAR)',
    owner: 'demo.testnet',
    request: {
      kind: 'transfer',
      receiver: 'alice.testnet',
      amount_yocto: '2000000000000000000000000',
    },
  },
];

function makeSyntheticTone(ms: number, freqStep = 0.11): Int16Array {
  const count = Math.floor((ms * 16_000) / 1_000);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = Math.round(Math.sin(i * freqStep) * 7_000);
  }
  return out;
}

export function App() {
  const [workerUrl, setWorkerUrl] = useState(DEFAULT_WORKER_URL);
  const [publicKey, setPublicKey] = useState<string>('');
  const [isMockWorker, setIsMockWorker] = useState<boolean>(false);
  const [presetId, setPresetId] = useState<string>(PRESETS[0].id);
  const [expectedTokens, setExpectedTokens] = useState<string[]>([]);
  const [displayText, setDisplayText] = useState<string>('');
  const [matchedCount, setMatchedCount] = useState<number>(0);
  const [liveHeard, setLiveHeard] = useState<string>('');
  const [status, setStatus] = useState<string>('Idle');
  const [enrollEpoch, setEnrollEpoch] = useState<number | null>(null);
  const [clipsRecorded, setClipsRecorded] = useState<Uint8Array[]>([]);
  const [lastResult, setLastResult] = useState<{
    wire: VerifyWireOutput;
    checked: VerdictCheck;
    closedBy: string;
    postSpeechMs: number | null;
  } | null>(null);

  const preset = useMemo(() => PRESETS.find((p) => p.id === presetId) ?? PRESETS[0], [presetId]);

  useEffect(() => {
    fetch(`${workerUrl.replace(/\/+$/, '')}/healthz`)
      .then((r) => r.json())
      .then((d: { public_key?: string; mock?: boolean }) => {
        if (d.public_key) setPublicKey(d.public_key);
        setIsMockWorker(Boolean(d.mock));
      })
      .catch(() => {
        setPublicKey('');
        setIsMockWorker(false);
      });
  }, [workerUrl]);

  useEffect(() => {
    if (!publicKey) return;
    void (async () => {
      const client = new SaySoClient({ baseUrl: workerUrl, verifierPublicKey: publicKey });
      let req = preset.request;
      if (req.kind === 'confirmation' && preset.payloadText) {
        const built = await confirmationRequest({
          owner: preset.owner,
          context: req.context,
          payload: new TextEncoder().encode(preset.payloadText),
          summary: req.summary,
        });
        req = built.request;
      }
      const rendered = await client.render(preset.owner, req);
      setExpectedTokens(rendered.expected_tokens ?? []);
      setDisplayText(rendered.display_text ?? rendered.sentence ?? '');
      setMatchedCount(0);
      setLiveHeard('');
    })();
  }, [workerUrl, publicKey, preset]);

  async function buildCurrentRequest(): Promise<{ request: SaySoRequestInput; expectedDigest?: Uint8Array }> {
    let req = preset.request;
    let expectedDigest: Uint8Array | undefined;
    if (req.kind === 'confirmation' && preset.payloadText) {
      const built = await confirmationRequest({
        owner: preset.owner,
        context: req.context,
        payload: new TextEncoder().encode(preset.payloadText),
        summary: req.summary,
      });
      req = built.request;
      expectedDigest = built.digest;
    }
    return { request: req, expectedDigest };
  }

  async function recordOneClipForEnrollment() {
    if (!publicKey) return;
    const chunks: Int16Array[] = [];
    let total = 0;
    setStatus(`Recording enrollment sample ${clipsRecorded.length + 1}/3...`);
    const handle = await startLiveMicrophonePcm({
      silenceEndMs: 500,
      maxDurationMs: 4_000,
      onFrame(frame) {
        chunks.push(frame);
        total += frame.length;
      },
      onSpeechEnd() {
        void finish();
      },
    });

    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      await handle.stop();
      const merged = new Int16Array(total);
      let at = 0;
      for (const c of chunks) {
        merged.set(c, at);
        at += c.length;
      }
      const wav = pcm16ToCanonicalWav(merged);
      const next = [...clipsRecorded, wav];
      if (next.length < 3) {
        setClipsRecorded(next);
        setStatus(`Captured clip ${next.length}/3. Record ${3 - next.length} more.`);
        return;
      }
      setStatus('Enrolling 3 voice clips into AccountVoiceDO...');
      const client = new SaySoClient({ baseUrl: workerUrl, verifierPublicKey: publicKey });
      const res = await client.enroll(preset.owner, [next[0], next[1], next[2]]);
      setClipsRecorded([]);
      if (res.outcome === 'accept') {
        setEnrollEpoch(res.template_epoch);
        setStatus(`Enrolled ${preset.owner} (epoch ${res.template_epoch}, agreement ${res.agreement_milli}‰)`);
      } else {
        setStatus(`Enrollment refused: ${res.reason}`);
      }
    };
  }

  async function startStreamingApproval() {
    if (!publicKey) return;
    setLastResult(null);
    setMatchedCount(0);
    setLiveHeard('');
    setStatus('Opening WebSocket stream to SaySo Worker...');

    const client = new SaySoClient({ baseUrl: workerUrl, verifierPublicKey: publicKey });
    const { request: req, expectedDigest } = await buildCurrentRequest();

    let lastSpeechFrameMs = performance.now();
    const session = client.streamVerify({
      owner: preset.owner,
      request: req,
      expectedRequestDigest: expectedDigest,
      acceptStepUp: true,
      onReady(info) {
        setExpectedTokens(info.expectedTokens);
        setStatus(
          info.mock
            ? 'Listening (offline mock mode) — say the exact sentence aloud...'
            : 'Listening live (Nova-3) — say the exact sentence aloud...',
        );
      },
      onTranscript(t) {
        setLiveHeard(t.heard);
        setMatchedCount(t.matchedPrefixCount);
      },
    });

    // In opt-in offline mock mode, bridge browser SpeechRecognition into the Worker's mock STT.
    let recognition: BrowserSpeechRecognition | null = null;
    if (isMockWorker) {
      const win = window as unknown as {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
      };
      const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
      if (Ctor) {
        recognition = new Ctor();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.onresult = (ev) => {
          let combined = '';
          let isFinal = false;
          for (let i = 0; i < ev.results.length; i += 1) {
            combined += `${ev.results[i][0].transcript} `;
            if (ev.results[i].isFinal) isFinal = true;
          }
          session.sendMockTranscript(combined.trim(), isFinal, false);
        };
        recognition.start();
      }
    }

    const mic = await startLiveMicrophonePcm({
      silenceEndMs: 480,
      onFrame(frame, _rms, speaking) {
        if (speaking) lastSpeechFrameMs = performance.now();
        session.sendPcmFrame(frame);
      },
      onSpeechEnd() {
        session.finishSpeech();
      },
    });

    try {
      const outcome = await session.result;
      const postSpeechMs = Math.max(0, Math.round(performance.now() - lastSpeechFrameMs));
      recognition?.stop();
      await mic.stop();
      setLastResult({
        wire: outcome.wire,
        checked: outcome.checked,
        closedBy: outcome.closedBy,
        postSpeechMs,
      });
      setStatus(
        outcome.checked.ok
          ? `Approved in ${postSpeechMs} ms post-speech (${outcome.closedBy})!`
          : `Refused (${outcome.checked.refusal.code})`,
      );
    } catch (err) {
      recognition?.stop();
      await mic.stop();
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function runOfflineSimulation() {
    if (!publicKey || !isMockWorker) return;
    setLastResult(null);
    setMatchedCount(0);
    setLiveHeard('');
    const client = new SaySoClient({ baseUrl: workerUrl, verifierPublicKey: publicKey });

    setStatus('Enrolling synthetic offline speaker...');
    const enrolled = await client.enroll(preset.owner, [
      pcm16ToCanonicalWav(makeSyntheticTone(850, 0.11)),
      pcm16ToCanonicalWav(makeSyntheticTone(900, 0.111)),
      pcm16ToCanonicalWav(makeSyntheticTone(950, 0.109)),
    ]);
    if (enrolled.outcome !== 'accept') {
      setStatus(`Mock enroll refused: ${enrolled.reason}`);
      return;
    }
    setEnrollEpoch(enrolled.template_epoch);

    const { request: req, expectedDigest } = await buildCurrentRequest();
    const tokens = expectedTokens.length > 0 ? expectedTokens : displayText.toLowerCase().split(/\s+/);
    let speechEndedMs = performance.now();

    const session = client.streamVerify({
      owner: preset.owner,
      request: req,
      expectedRequestDigest: expectedDigest,
      acceptStepUp: true,
      onTranscript(t) {
        setLiveHeard(t.heard);
        setMatchedCount(t.matchedPrefixCount);
      },
    });

    const pcm = makeSyntheticTone(960, 0.11);
    for (let offset = 0; offset < pcm.length; offset += 1_600) {
      session.sendPcmFrame(pcm.subarray(offset, offset + 1_600));
    }
    for (let i = 1; i <= tokens.length; i += 1) {
      await new Promise((r) => setTimeout(r, 90));
      const partial = tokens.slice(0, i).join(' ');
      if (i === tokens.length) speechEndedMs = performance.now();
      session.sendMockTranscript(partial, i === tokens.length, false);
    }

    const outcome = await session.result;
    const postSpeechMs = Math.max(0, Math.round(performance.now() - speechEndedMs));
    setLastResult({
      wire: outcome.wire,
      checked: outcome.checked,
      closedBy: outcome.closedBy,
      postSpeechMs,
    });
    setStatus(
      outcome.checked.ok
        ? `Offline mock approved in ${postSpeechMs} ms post-speech (${outcome.closedBy})`
        : `Refused (${outcome.checked.refusal.code})`,
    );
  }

  return (
    <div style={{ maxWidth: 820, margin: '40px auto', padding: '0 24px' }}>
      <header style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 13, color: '#7ee787', fontWeight: 600, letterSpacing: 1 }}>
          CLOUDFLARE-NATIVE SPOKEN-INTENT AUTHORIZATION
        </div>
        <h1 style={{ margin: '6px 0 8px', fontSize: 34 }}>SaySo</h1>
        <p style={{ margin: 0, color: '#8b949e', lineHeight: 1.5 }}>
          Nothing moves without your say-so. Live 16 kHz AudioWorklet PCM streams over WebSocket to
          Cloudflare Workers + Deepgram Nova-3 + ReDimNet Container + SQLite Durable Objects.
        </p>
      </header>

      <section
        style={{
          background: '#161b22',
          border: '1px solid #30363d',
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
        }}
      >
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#8b949e' }}>Worker URL:</label>
          <input
            value={workerUrl}
            onChange={(e) => setWorkerUrl(e.target.value)}
            style={{
              background: '#0d1117',
              color: '#e6edf3',
              border: '1px solid #30363d',
              borderRadius: 6,
              padding: '6px 10px',
              width: 260,
            }}
          />
          <span style={{ fontSize: 12, color: publicKey ? '#7ee787' : '#f85149' }}>
            {publicKey ? `Pinned Key: ${publicKey.slice(0, 22)}…` : 'Worker offline (run pnpm dev:worker)'}
          </span>
          {isMockWorker && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: '3px 8px',
                borderRadius: 999,
                background: '#9e6a0333',
                border: '1px solid #d29922',
                color: '#e3b341',
              }}
            >
              OFFLINE MOCK MODE (sayso/0.1.0+mock)
            </span>
          )}
        </div>
      </section>

      <section
        style={{
          background: '#161b22',
          border: '1px solid #30363d',
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
        }}
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPresetId(p.id)}
              style={{
                background: p.id === presetId ? '#238636' : '#21262d',
                color: '#fff',
                border: '1px solid #30363d',
                borderRadius: 8,
                padding: '8px 14px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 13, color: '#8b949e', marginBottom: 8 }}>
          Owner: <code>{preset.owner}</code>{' '}
          {enrollEpoch !== null && <span style={{ color: '#7ee787' }}>(Enrolled epoch {enrollEpoch})</span>}
        </div>

        <div
          style={{
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: 10,
            padding: 18,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 8 }}>
            SAY EXACTLY ({displayText}):
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {expectedTokens.map((tok, idx) => {
              const matched = idx < matchedCount;
              return (
                <span
                  key={`${tok}-${idx}`}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 999,
                    fontSize: 18,
                    fontWeight: 600,
                    background: matched ? '#1f6feb33' : '#21262d',
                    border: `1px solid ${matched ? '#3fb950' : '#30363d'}`,
                    color: matched ? '#7ee787' : '#e6edf3',
                    transition: 'all 120ms ease',
                  }}
                >
                  {tok}
                </span>
              );
            })}
          </div>
          {liveHeard && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#8b949e' }}>
              Live transcript: <strong style={{ color: '#e6edf3' }}>{liveHeard}</strong>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => void recordOneClipForEnrollment()}
            disabled={!publicKey}
            style={{
              background: '#21262d',
              color: '#e6edf3',
              border: '1px solid #30363d',
              borderRadius: 8,
              padding: '10px 16px',
              cursor: publicKey ? 'pointer' : 'not-allowed',
              fontWeight: 600,
            }}
          >
            1. Enroll Voice ({clipsRecorded.length}/3 clips)
          </button>

          <button
            onClick={() => void startStreamingApproval()}
            disabled={!publicKey}
            style={{
              background: '#238636',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 20px',
              cursor: publicKey ? 'pointer' : 'not-allowed',
              fontWeight: 700,
            }}
          >
            2. Speak to Authorize (WebSocket Stream)
          </button>

          {isMockWorker && (
            <button
              onClick={() => void runOfflineSimulation()}
              style={{
                background: '#9e6a03',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '10px 16px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Simulate Offline (No Mic)
            </button>
          )}

          <span style={{ fontSize: 13, color: '#58a6ff' }}>{status}</span>
        </div>
      </section>

      {lastResult && (
        <section
          style={{
            background: '#161b22',
            border: `1px solid ${lastResult.checked.ok ? '#238636' : '#f85149'}`,
            borderRadius: 12,
            padding: 20,
          }}
        >
          <h3 style={{ marginTop: 0 }}>
            {lastResult.checked.ok ? 'Verified Ed25519 SaySo Verdict' : 'Refused Verdict'}
          </h3>
          <div style={{ fontSize: 13, color: '#8b949e', marginBottom: 12 }}>
            Closed by: <code>{lastResult.closedBy}</code> | Post-speech wait:{' '}
            <strong>{lastResult.postSpeechMs} ms</strong> | Worker stages:{' '}
            <code>{JSON.stringify(lastResult.wire.ms)}</code>
          </div>
          <pre
            style={{
              background: '#0d1117',
              padding: 14,
              borderRadius: 8,
              overflowX: 'auto',
              fontSize: 12,
              margin: 0,
            }}
          >
            {JSON.stringify(JSON.parse(lastResult.wire.verdict_json), null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
