import test from 'node:test';
import assert from 'node:assert/strict';
import { document, ids } from '../support/ui-dom.mjs';
import { mount } from '../../web/views/ncm-song.mjs';
const settle = () => new Promise(setImmediate);
function browser(t) {
  const saved = Object.fromEntries(['document','window','matchMedia','fetch','MediaSource','localStorage'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const storage = new Map();
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const controller = new AbortController();
  t.after(() => { controller.abort(); for (const [k,v] of Object.entries(saved)) { if (v) Object.defineProperty(globalThis,k,v); else delete globalThis[k]; } });
  globalThis.document = document;
  globalThis.window = { FANTASTIC_HOST: { ncmEnabled: true }, AmI18n: { t: (key) => key }, AmHook: { formatTime: String, detectQqModes: () => ['native'] } };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.MediaSource = { isTypeSupported: () => true };
  return controller.signal;
}

test('NCM song renders quality groups, plays/enqueues NCM identity and downloads original lyric formats', async (t) => {
  const signal = browser(t);
  const root = ids('title','subtitle','meta','badges','art','radiosity','enqueue','play-best','variant-list','quality-status','lyrics','lyrics-source',
    'lyrics-actions','lyrics-preview','lyrics-qrc','lyrics-trans','lyrics-roma','lyrics-lines','alert','info','facts','intro');
  const played = [], queued = [];
  let rerender;
  const player = { current: null, onChange() {}, transport: () => ({ paused: true }), play: (item) => played.push(item), appendQueue: (item) => queued.push(item) };
  globalThis.fetch = async (path) => ({ ok: true, json: async () => path.endsWith('/qualities') ? { qualities: [
    { quality: 'standard', available: true, sizeBytes: 1000 }, { quality: 'lossless', available: true, sizeBytes: 2000 }] }
    : path.endsWith('/lyrics') ? { candidates: [{ source: 'yrc', text: '[1000,500](1000,200,0)海(1200,300,0)阔天空' }], rawYrc: true }
      : { id: '347230', name: '海阔天空', artists: [{ name: 'Beyond', mid: '11127' }], albumMid: '34209', album: '乐与怒', vip: true } });
  mount({ root, signal, player, url: new URL('https://test/https://music.163.com/song?id=347230'), onLangChange: (fn) => { rerender = fn; }, toast() {} });
  await settle();
  assert.equal(root.querySelector('#title').textContent, '海阔天空');
  assert.equal(root.querySelector('#subtitle').querySelector('a').href, '/https://music.163.com/artist?id=11127');
  assert.ok(root.querySelector('#badges').textContent.includes('source.ncm'));
  const groups = root.querySelector('#variant-list').children;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.querySelectorAll('.variant').map((n) => n.dataset.quality)), [['lossless'], ['standard']]);
  await root.querySelector('#play-best').click();
  assert.equal(played[0].source, 'ncm'); assert.equal(played[0].quality, 'lossless');
  assert.equal(played[0].streamUrl, '/ncm/song/347230/play?quality=lossless');
  assert.equal(localStorage.getItem('am-hook:ncm:quality'), 'lossless');
  await root.querySelector('#enqueue').click(); assert.equal(queued[0].key, 'ncm:347230');
  await root.querySelector('#lyrics-preview').click();
  assert.equal(root.querySelector('#lyrics-lines').textContent, '海阔天空');
  assert.equal(root.querySelector('#lyrics-qrc').href, '/ncm/song/347230/lyrics/raw?kind=yrc');
  rerender(); assert.equal(root.querySelector('#lyrics-lines').textContent, '海阔天空');
});

test('NCM routes official query paths and legacy aliases behind the enable gate', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('../../web/app.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const LIBRARY_PATH');
  const end = source.indexOf('/* ---------- 常驻', start);
  const code = source.slice(start, end).replace('export function route', 'function route');
  const env = (enabled) => ({
    location: new URL('https://test/'), window: { FANTASTIC_HOST: { ncmEnabled: enabled } },
    regionlessResource: () => null, PAGES: [], CHARTS_PATH: /$^/,
  });
  const route = (enabled) => runInNewContext(`${code}\nroute`, env(enabled));
  const on = route(true);
  for (const kind of ['song', 'album', 'artist', 'playlist']) {
    assert.equal(on(new URL(`https://test/https://music.163.com/${kind}?id=347230`)), `ncm-${kind}`);
    assert.equal(on(new URL(`https://test/ncm-${kind}/347230`)), `ncm-${kind}`);
    assert.equal(on(new URL(`https://test/https:/music.163.com/${kind}?id=347230`)), `ncm-${kind}`);
    assert.equal(on(new URL(`https://test/https://music.163.com/${kind}?id=0`)), null);
  }
  const off = route(false);
  assert.equal(off(new URL('https://test/https://music.163.com/song?id=347230')), null);
  assert.equal(off(new URL('https://test/ncm-song/347230')), null);
});

test('settings contain no cookie controls or requests', async () => {
  const { readFileSync } = await import('node:fs');
  for (const ext of ['html', 'mjs', 'css']) {
    const source = readFileSync(new URL(`../../web/views/settings.${ext}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /cookie|settings-ncm/i);
  }
});

test('NCM album, artist and playlist render local navigation and play source-specific queues', async (t) => {
  const signal = browser(t);
  // Views use browser-only actions; inject those controls while executing the real view bodies.
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const ncm = await import('../../web/sources/ncm.mjs');
  const song = { id: '347230', name: '海阔天空', artists: [{ mid: '11127', name: 'Beyond' }], album: '乐与怒', albumMid: '34209' };
  const album = { mid: '34209', name: '乐与怒', artists: song.artists, size: 1 };
  for (const kind of ['album','artist','playlist']) {
    const root = ids('hero','title','artist','art','radiosity','sub','notes','notes-text','notes-more','play-all','shuffle','alert','tracks','footer','creator','more',
      'name','hero-art','portrait','portrait-glow','counts','bio','born','bio-text','bio-more','shelves');
    for (const node of root.children) node.classList.remove = () => {};
    const buttons = document.createElement('div'); buttons.className = 'detail-actions'; root.querySelector('#hero').append(buttons);
    const played = [];
    const player = { current: null, onChange() {}, playQueue: (items) => played.push(items) };
    globalThis.fetch = async () => ({ ok: true, json: async () => kind === 'album' ? { album, songs: [song] }
      : kind === 'artist' ? { artist: { mid: '11127', name: 'Beyond' }, songs: [song], albums: [album] }
        : { playlist: { id: '1', name: 'Playlist' }, songs: [song], more: false } });
    const source = readFileSync(new URL(`../../web/views/ncm-${kind}.mjs`, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const mountView = runInNewContext(`${source}\nmount`, { window, document, ncm, artUrl: (v) => v?.url || v || '', trackKey: ncm.trackKey,
      createActions: () => ({ headerMenu: () => document.createElement('button'), moreButton: () => document.createElement('button') }),
      createDetailHeader: () => () => {}, syncTrackRows() {},
      trackRow: (track) => { const row = document.createElement('a'); row.href = track.href; row.textContent = track.name; return { row, track }; } });
    mountView({ root, signal, player, url: new URL(`https://test/ncm-${kind}/${kind === 'album' ? '34209' : '1'}`), navigate() {}, onLangChange() {}, toast() {} });
    await settle();
    assert.equal(root.querySelector('#alert').hidden, true, `${kind} must render without errors`);
    await root.querySelector('#play-all').click();
    assert.equal(played[0][0].key, 'ncm:347230');
    if (kind === 'artist') {
      assert.equal(root.querySelector('#shelves').querySelector('a').href, '/https://music.163.com/album?id=34209');
      assert.equal(root.querySelector('#tracks').querySelector('.track-artist').querySelector('a').href, '/https://music.163.com/album?id=34209');
    }
    if (kind === 'album') assert.equal(root.querySelector('#artist').querySelector('a').href, '/https://music.163.com/artist?id=11127');
  }
});

test('NCM search uses four groups without MV and passes NCM targets and queues to existing controls', async (t) => {
  browser(t);
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const ncm = await import('../../web/sources/ncm.mjs');
  const source = readFileSync(new URL('../../web/views/search-results.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const targets = [], requests = [], played = [];
  const createResults = runInNewContext(`${source}\ncreateResults`, { window, document, ncm, qq: {}, AbortController, URLSearchParams,
    trackKey: ncm.trackKey, artUrl: () => '', amp() { assert.fail('NCM search must not request Apple'); } });
  globalThis.fetch = async (path) => {
    const kind = new URL(path, 'https://test').searchParams.get('kind'); requests.push(kind);
    return { ok: true, json: async () => ({ total: 1, [kind === 'song' ? 'songs' : `${kind}s`]: kind === 'song'
      ? [{ id: '347230', name: '海阔天空' }] : kind === 'playlist' ? [{ id: '1', name: kind }] : [{ mid: '1', name: kind }] }) };
  };
  const nodes = ids('section','title','tabs','body'); nodes.querySelector('#tabs').contains = () => false;
  const els = Object.fromEntries(['section','title','tabs','body'].map((id) => [id, nodes.querySelector(`#${id}`)]));
  const wrap = (node, target) => { targets.push(target); return node; };
  const results = createResults({ els, source: () => 'ncm', player: { current: null, playQueue: (entries) => played.push(entries) },
    ready() { assert.fail('NCM search does not wait for wrapper status'); }, actions: { wrapRow: wrap, wrapCard: wrap } });
  await results.run('海阔天空');
  assert.deepEqual(requests.sort(), ['album','artist','playlist','song']);
  assert.equal(targets.length, 4); assert.ok(targets.every((target) => target.source === 'ncm'));
  targets.find((target) => target.kind === 'song').onPlay();
  assert.equal(played[0][0].key, 'ncm:347230');
});
