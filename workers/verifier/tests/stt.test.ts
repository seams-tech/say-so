import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkersAiSttProvider, firstAnswer } from '../src/stt.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A call whose n-th run (from 1) answers `answers[n - 1]` after `delays[n - 1]` ms. */
function scripted(delays: number[], answers: Array<string | null | Error>) {
  let runs = 0;
  const call = async () => {
    const n = runs++;
    await wait(delays[n]);
    const answer = answers[n];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { call, runs: () => runs };
}

test('A fast turbo answer makes one call', async () => {
  const s = scripted([5], ['first']);
  const ms: Record<string, number> = {};
  assert.equal(await firstAnswer(s.call, 50, ms), 'first');
  await wait(70);
  assert.equal(s.runs(), 1);
  assert.deepEqual(ms, { stt_calls: 1, stt_answer: 1 });
});

test('A slow turbo call starts a second one, and the first answer wins', async () => {
  const second = scripted([200, 10], ['first', 'second']);
  const ms: Record<string, number> = {};
  const started = Date.now();
  assert.equal(await firstAnswer(second.call, 30, ms), 'second');
  assert.ok(Date.now() - started < 150, 'the second call did not wait for the first');
  assert.deepEqual(ms, { stt_calls: 2, stt_answer: 2 });

  // The first call can still win after the second one started.
  const first = scripted([60, 200], ['first', 'second']);
  const ms2: Record<string, number> = {};
  assert.equal(await firstAnswer(first.call, 30, ms2), 'first');
  assert.deepEqual(ms2, { stt_calls: 2, stt_answer: 1 });
});

test('A failed turbo call starts the second one at once, and two failures give null', async () => {
  const retry = scripted([5, 5], [new Error('capacity'), 'second']);
  const ms: Record<string, number> = {};
  const started = Date.now();
  assert.equal(await firstAnswer(retry.call, 1_000, ms), 'second');
  assert.ok(Date.now() - started < 500, 'the retry did not wait for the hedge delay');
  assert.deepEqual(ms, { stt_calls: 2, stt_answer: 2 });

  const none = scripted([5, 5], [null, new Error('capacity')]);
  const ms2: Record<string, number> = {};
  assert.equal(await firstAnswer(none.call, 1_000, ms2), null);
  assert.equal(none.runs(), 2);
  assert.deepEqual(ms2, { stt_calls: 2, stt_answer: 0 });
});

test('The Workers AI provider sends the same request twice and trims the text', async () => {
  const requests: unknown[] = [];
  const ai = {
    async run(model: string, inputs: Record<string, unknown>) {
      requests.push({ model, ...inputs });
      await wait(requests.length === 1 ? 200 : 5);
      return { text: requests.length === 1 ? ' slow ' : ' send ten near ' };
    },
  };
  const stt = createWorkersAiSttProvider(ai, { hedgeAfterMs: 20 });
  const ms: Record<string, number> = {};
  assert.equal(await stt.transcribeBatch('UklGRg==', ms), 'send ten near');
  assert.deepEqual(ms, { stt_calls: 2, stt_answer: 2 });
  const one = { model: '@cf/openai/whisper-large-v3-turbo', audio: 'UklGRg==', language: 'en' };
  assert.deepEqual(requests, [one, one]);

  // An empty transcript is an answer, not a failure.
  const quiet = createWorkersAiSttProvider({ async run() { return { text: '  ' }; } }, { hedgeAfterMs: 1_000 });
  const ms2: Record<string, number> = {};
  assert.equal(await quiet.transcribeBatch('UklGRg==', ms2), null);
  assert.deepEqual(ms2, { stt_calls: 1, stt_answer: 1 });
});
