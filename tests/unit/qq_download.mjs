import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

const saved = Object.fromEntries(['window', 'document', 'fetch', 'AmWrapper', 'AmI18n', 'performance', 'setTimeout']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const links = [];
const realSetTimeout = globalThis.setTimeout;

before(() => {
  globalThis.addEventListener ??= () => {};
  globalThis.performance = { now: () => Date.now() };
  globalThis.document = {
    body: { append() {} },
    createElement() {
      return { style: {}, click() { links.push(this.href); }, remove() {} };
    },
  };
  globalThis.URL.createObjectURL = () => 'blob:qq-test';
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.window = {
    AmDecrypt: {},
    AmWrapper: { throttle: { remaining: () => 0, limit: (n) => n, wait: async () => {}, ok() {} } },
    AmI18n: { t: (key) => key, catalogLang: () => 'en' },
  };
  globalThis.AmWrapper = window.AmWrapper;
  globalThis.AmI18n = window.AmI18n;
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
  }
});

let downloads;
const track = { id: '0039MnYb0qxYhV', name: '晴天', artists: [{ name: '周杰伦' }] };
let fetchCalls;
async function waitDone(job) {
  for (let i = 0; i < 100 && ['preparing', 'running', 'queued', 'packing'].includes(downloads.jobState(job)); i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 2));
  }
  return job;
}

test('QQ browser download saves a metadata filename through the download center', async () => {
  ({ downloads } = await import(`../../web/download/downloads.mjs?qq-test=${Date.now()}`));
  globalThis.setTimeout = (...args) => { const timer = realSetTimeout(...args); timer.unref?.(); return timer; };
  fetchCalls = [];
  globalThis.fetch = async (url) => { fetchCalls.push(url); return new Response(new Uint8Array([1, 2, 3]), {
    status: 200, headers: { 'content-length': '3', 'content-type': 'audio/mpeg' },
  }); };
  const job = await downloads.add({ source: 'qq', kind: 'song', id: track.id, tracks: [track], quality: 'HQ' });
  await waitDone(job);
  assert.equal(job.tasks[0].state, 'done');
  assert.deepEqual(job.tasks[0].path, ['周杰伦 - 晴天.mp3']);
  assert.equal(job.tasks[0].result.file.size, 3);
  assert.deepEqual(fetchCalls, ['/qq/song/0039MnYb0qxYhV/download?quality=HQ']);
  downloads.clearFinished();
  globalThis.setTimeout = realSetTimeout;
});

test('QQ browser download falls back to an ordinary link when fetch fails', async () => {
  ({ downloads } = await import(`../../web/download/downloads.mjs?qq-test=${Date.now()}`));
  globalThis.setTimeout = (...args) => { const timer = realSetTimeout(...args); timer.unref?.(); return timer; };
  links.length = 0;
  globalThis.fetch = async () => { throw new TypeError('CORS failure'); };
  const job = await downloads.add({ source: 'qq', kind: 'song', id: track.id, tracks: [track], quality: 'HQ' });
  await waitDone(job);
  assert.equal(job.tasks[0].state, 'done');
  assert.deepEqual(links, ['/qq/song/0039MnYb0qxYhV/download?quality=HQ']);
  downloads.clearFinished();
  globalThis.setTimeout = realSetTimeout;
});
