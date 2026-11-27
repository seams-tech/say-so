import assert from 'node:assert/strict';
import test from 'node:test';
import { SpeakerContainer } from '../src/speaker.ts';

// A container that, as on Cloudflare, reports `running` as soon as `start()` returns but
// listens on its port only some time later.
function fakeContainer(listenAfterMs: number) {
  let listening = false;
  const state = {
    starts: 0,
    container: {
      running: false,
      start() {
        state.starts += 1;
        state.container.running = true;
        setTimeout(() => (listening = true), listenAfterMs);
      },
      getTcpPort() {
        return {
          async fetch(input: RequestInfo | URL) {
            if (!listening) throw new Error('The container is not listening in the TCP address 10.0.0.1:8080');
            const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
            return Response.json({ path });
          },
        };
      },
    },
  };
  return state;
}

test('A stopped speaker container starts once, and requests that arrive during the start wait for it', async () => {
  const state = fakeContainer(400);
  const speaker = new SpeakerContainer(state as unknown as DurableObjectState);

  // An enrollment sends its three recordings at the same time.
  const replies = await Promise.all(
    [1, 2, 3].map(() => speaker.fetch(new Request('http://container/v1/embed', { method: 'POST' }))),
  );
  assert.deepEqual(replies.map((r) => r.status), [200, 200, 200]);
  assert.equal(state.starts, 1);

  // While it runs, a request does not start it again.
  assert.equal((await speaker.fetch(new Request('http://container/v1/embed', { method: 'POST' }))).status, 200);
  assert.equal(state.starts, 1);

  // After it sleeps, the next request starts it again.
  state.container.running = false;
  assert.equal((await speaker.fetch(new Request('http://container/v1/embed', { method: 'POST' }))).status, 200);
  assert.equal(state.starts, 2);
});
