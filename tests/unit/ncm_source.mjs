import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import * as ncm from '../../web/sources/ncm.mjs';
import * as library from '../../web/library.mjs';
import { sourceOf, trackKey, withIdentity } from '../../web/sources/track.mjs';
import { duetSides } from '../../web/lyrics/ttml.mjs';
const { AmPlayer, trackKey: playerKey, usePlaybackSettings } = createRequire(import.meta.url)('../../web/player/player.js');
const saved = Object.fromEntries(['window', 'document', 'fetch', 'MediaSource', 'AmWrapper', 'AmI18n', 'localStorage']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
beforeEach(() => {
  const storage = new Map();
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.window = {};
  globalThis.document = { createElement: () => ({ canPlayType: () => 'probably' }) };
  globalThis.MediaSource = { isTypeSupported: () => true };
  globalThis.AmWrapper = { songMaster() { assert.fail('NCM must never request an Apple master'); } };
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
  }
  usePlaybackSettings(null);
});
const dto = { id: '347230', name: '海阔天空', artists: [{ mid: '11127', name: 'Beyond' }],
  album: '乐与怒', albumMid: '34209', durationMs: 300000, cover: 'https://p1.music.126.net/cover.jpg', vip: true };
const yrc = '\n{"t":0,"c":[{"tx":"作词："},{"tx":"黄家驹"}]}\n[1000,900](1000,200,0)海(1200,200,0)阔(1400,500,0)天空\n\n[3000,600](3000,600,0)你与我\n';
const lrc = '[00:01.00]海阔天空\n[00:03.00]你与我\n';

test('NCM identity, DTO links and library snapshots cannot collide with Apple or QQ', () => {
  const track = ncm.toTrack({ ...dto, cookie: 'private', url: 'private' });
  assert.equal(track.key, 'ncm:347230');
  assert.equal(sourceOf(track), 'ncm');
  assert.equal(trackKey(ncm.entryOf(track)), track.key);
  assert.equal(playerKey(ncm.entryOf(track)), track.key);
  assert.deepEqual(new Set(['apple', 'qq', 'ncm'].map((source) => trackKey({ source, id: dto.id }))).size, 3);
  assert.equal(withIdentity({ id: dto.id }).source, 'apple');
  assert.equal(track.href, '/ncm-song/347230');
  assert.equal(track.albumHref, '/ncm-album/34209');
  assert.equal(track.artists[0].href, '/ncm-artist/11127');
  assert.equal(ncm.webUrl(track.href), 'https://music.163.com/song?id=347230');
  assert.equal(JSON.stringify(track).includes('private'), false);
  library.addToLibrary([track]);
  const ncmTrack = library.libraryItem('song', dto.id, 'ncm');
  assert.equal(ncmTrack.source, 'ncm');
  assert.equal(ncmTrack.href, track.href);
  assert.equal(library.entryOf(ncmTrack).key, track.key);
  library.addToLibrary([{ ...track, source: 'apple' }, { ...track, source: 'qq' }]);
  for (const source of ['apple', 'qq', 'ncm']) assert.ok(library.libraryItem('song', dto.id, source));
  assert.equal(library.keyOf('song', dto.id, 'ncm'), 'ncm:song:347230');
  library.removeFromLibrary('song', dto.id, 'ncm');
  assert.ok(library.libraryItem('song', dto.id, 'apple'));
  assert.ok(library.libraryItem('song', dto.id, 'qq'));
});

test('NCM IDs and raw lyric/quality URLs are validated before sending requests', () => {
  for (const id of [undefined, null, '0', '01', '../cookie', 'a1', '9223372036854775808', 9007199254740992]) {
    assert.throws(() => ncm.songPath(id)); assert.throws(() => ncm.playUrl(id));
  }
  assert.equal(ncm.numericId('9223372036854775807'), '9223372036854775807');
  assert.throws(() => ncm.downloadUrl('1', 'HQ'));
  assert.throws(() => ncm.rawLyricsUrl('1', 'qrc'));
  assert.equal(ncm.playUrl('1', 'hires'), '/ncm/song/1/play?quality=hires');
});

test('NCM remembers manual quality across adapter reloads using its own storage key and falls back when unavailable', async () => {
  localStorage.setItem('am-hook:qq:quality', 'SQ');
  localStorage.setItem('am-hook:settings', '{"playback":{"wifi":"hires"}}');
  const rows = ncm.qualityRows({ qualities: ncm.QUALITY_IDS.map((quality) => ({ quality, available: true })) }, dto.id);
  ncm.rememberQuality('higher');
  const reloaded = await import(`../../web/sources/ncm.mjs?quality-reload=${Date.now()}`);
  assert.equal(reloaded.pickDefaultQuality(rows, 'hires').quality, 'higher');
  assert.equal(localStorage.getItem('am-hook:qq:quality'), 'SQ');
  assert.equal(localStorage.getItem('am-hook:settings'), '{"playback":{"wifi":"hires"}}');
  ncm.rememberQuality('lossless');
  assert.equal(reloaded.pickDefaultQuality(rows.filter((r) => r.quality !== 'lossless'), 'hires').quality, 'exhigh');
  localStorage.setItem('am-hook:ncm:quality', 'invalid');
  assert.equal(ncm.pickDefaultQuality(rows, 'standard').quality, 'standard');
  assert.throws(() => ncm.rememberQuality('SQ'));
});

test('YRC skips metadata and blank lines, preserving every word and absolute millisecond timing', () => {
  const song = ncm.parseYrc(yrc);
  assert.equal(song.timing, 'Word'); assert.equal(song.lines.length, 2);
  assert.equal(song.lines[0].text, '海阔天空');
  assert.deepEqual(song.lines[0].tokens.map((t) => [t.text, t.begin, t.end]), [['海',1000,1200], ['阔',1200,1400], ['天空',1400,1900]]);
  assert.deepEqual([song.lines[1].begin, song.lines[1].end], [3000,3600]);
  assert.equal(ncm.parseYrc('{"t":0,"c":[]}\n\n').lines.length, 0);
  assert.equal(ncm.parseYrc('[0,120](0,60)海(60,60)阔').lines[0].tokens[1].begin, 60);
});

test('YRC has priority over LRC regardless of order; malformed or empty YRC falls back', () => {
  const candidates = [{ source: 'lrc', text: lrc }, { source: 'yrc', text: yrc }];
  assert.equal(ncm.selectLyrics(candidates).source, 'yrc');
  for (const text of ['\n', '{"t":0,"c":[]}', '[1,2]no word timing']) {
    assert.equal(ncm.selectLyrics([{ source: 'yrc', text }, candidates[0]]).source, 'lrc');
  }
  assert.deepEqual(ncm.selectLyrics([]), { song: null });
  const song = ncm.parseLrc('[offset:50]\n[00:01.2][00:03.005]同一句\n');
  assert.deepEqual(song.lines.map((l) => l.begin), [1250, 3055]);
});

function amllConverter() {
  const source = fs.readFileSync(new URL('../../web/lyrics/panel.mjs', import.meta.url), 'utf8');
  const helpers = source.match(/const validTokens =[^]*?const same =[^]*?;\n/)[0];
  const voice = source.match(/function amllLine\([^]*?\n\}/)[0];
  const convert = source.match(/export function toAmllLines\([^]*?\n\}/)[0].replace('export ', '');
  return vm.runInNewContext(`${helpers}\n${voice}\n${convert}\ntoAmllLines`, { duetSides });
}
test('timed translation and romanization flow through the existing LyricLine converter and toggles', () => {
  const song = ncm.attachLyrics(ncm.parseYrc(yrc), { trans: '[00:03.00]You and me\n[00:01.00]Broad sky\n[00:09.00]unrelated',
    roma: '[00:01.00]fallback roma', yroma: '[1000,900](1000,200,0)hoi(1200,200,0)fut(1400,500,0)tin hung\n[3000,600](3000,600,0)nei jyu ngo' });
  assert.deepEqual(song.lines.map((l) => l.translation), ['Broad sky', 'You and me']);
  assert.equal(song.lines[0].pronunciationTokens[0].text, 'hoi');
  const toAmll = amllConverter();
  const lines = toAmll(song, { translation: true, pronunciation: true });
  assert.equal(lines[0].translatedLyric, 'Broad sky');
  assert.equal(lines[0].words[1].romanWord, 'fut');
  assert.deepEqual(Array.from(lines[0].words, (w) => [w.word,w.startTime,w.endTime]), [['海',1000,1200],['阔',1200,1400],['天空',1400,1900]]);
  const hidden = toAmll(song, { translation: false, pronunciation: false });
  assert.equal(hidden[0].translatedLyric, ''); assert.equal(hidden[0].romanLyric, '');
  assert.equal(hidden[0].words[0].romanWord, undefined);
  const lineTimed = ncm.attachLyrics(ncm.parseLrc(lrc), { roma: '[00:01.00]hoi fut tin hung' });
  assert.equal(toAmll(lineTimed, { pronunciation: true })[0].romanLyric, 'hoi fut tin hung');
});

test('NCM requests use kind for search and fetch secondary lyrics without losing main lyrics on 404', async () => {
  const calls = [];
  const controller = new AbortController();
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path.includes('/search')) return { ok: true, json: async () => ({ songs: [dto], total: 1 }) };
    if (path.endsWith('/lyrics')) return { ok: true, json: async () => ({ candidates: [{ source: 'yrc', text: yrc }], rawTrans: true, rawRoma: true }) };
    if (path.endsWith('kind=trans')) return { ok: true, text: async () => '[00:01.00]Broad sky' };
    if (path.endsWith('kind=yroma')) return { ok: true, text: async () => '[1000,900](1000,200,0)hoi(1200,200,0)fut(1400,500,0)tin hung' };
    return { ok: false, status: 404 };
  };
  const result = await ncm.search('海阔天空', 'song', { signal: controller.signal });
  assert.equal(new URL(calls[0].path, 'https://test').searchParams.get('kind'), 'song');
  assert.equal(result.items[0].key, 'ncm:347230');
  const lyrics = await ncm.lyrics('347230', () => assert.fail('YRC must not be parsed as TTML'), controller.signal);
  assert.equal(lyrics.song.lines[0].translation, 'Broad sky');
  assert.equal(lyrics.rawRomaKind, 'yroma');
  assert.ok(calls.every((c) => c.path.startsWith('/ncm/') && c.options.signal === controller.signal));
});

function playerHarness() {
  const p = Object.create(AmPlayer.prototype);
  Object.assign(p, { volume: 0.5, mixGain: 1, mixer: { volumeChanged() {} }, source: 'apple', current: null, queue: null,
    sourceContexts: new Map(), playToken: 0, queueSerial: 0, nextSerial: 0, shuffle: false, repeat: 'off', root: { hidden: true }, unsupportedListeners: new Set(),
    audio: { paused: true, currentTime: 0, duration: 300, canPlayType: () => 'probably', async play() { this.paused = false; }, pause() { this.paused = true; }, load() {}, addEventListener() {} } });
  p.clock = p.audio;
  for (const name of ['closeQualityPanel','layout','emit','renderQueue','renderModes','setLoading','renderToggle','renderTrackText','renderArtwork','renderMode','updateMediaSession','renderProgress','prepareNext','extendQueue','show']) p[name] = () => {};
  p.showError = (error) => { p.error = error; }; p.teardown = () => p.audio.pause();
  return p;
}
test('NCM queue playback resolves JSON, switches quality at current time and retains a separate source context', async () => {
  const calls = [];
  globalThis.fetch = async (path) => {
    calls.push(path);
    if (path.endsWith('/qualities')) return { ok: true, json: async () => ({ qualities: [{ quality: 'standard', available: true }, { quality: 'lossless', available: true }] }) };
    const quality = new URL(path, 'https://test').searchParams.get('quality');
    return { ok: true, json: async () => ({ quality, url: `https://m701.music.126.net/audio.${quality === 'lossless' ? 'flac' : 'mp3'}?fresh=1`, format: quality === 'lossless' ? 'FLAC' : 'MP3', bitrate: 128000 }) };
  };
  const p = playerHarness();
  await p.playQueue([ncm.entryOf(ncm.toTrack(dto))]);
  assert.equal(p.current.key, 'ncm:347230'); assert.equal(p.current.quality, 'lossless');
  assert.equal(p.audio.src, 'https://m701.music.126.net/audio.flac?fresh=1');
  assert.equal(p.current.streamUrl, '/ncm/song/347230/play?quality=lossless');
  assert.equal(JSON.stringify(p.queue).includes('fresh=1'), false);
  assert.equal(localStorage.getItem('am-hook:ncm:quality'), null);
  p.audio.currentTime = 19;
  await p.switchVariant(ncm.qualityVariant('standard'));
  assert.equal(p.audio.currentTime, 19); assert.equal(p.current.quality, 'standard');
  assert.equal(localStorage.getItem('am-hook:ncm:quality'), 'standard');
  p.switchSource('qq', false);
  assert.equal(p.sourceContexts.get('ncm').queue.entries[0].quality, 'standard');
  assert.equal(p.source, 'qq');
  assert.ok(calls.every((url) => url.startsWith('/ncm/')));
});

test('NCM default tier honors the shared ladder and native capability filtering', () => {
  const rows = ncm.qualityRows({ qualities: ncm.QUALITY_IDS.map((quality) => ({ quality, available: true })) }, '347230');
  assert.equal(ncm.pickDefaultQuality(rows, 'hires').quality, 'jymaster');
  assert.equal(ncm.pickDefaultQuality(rows, 'lossless').quality, 'lossless');
  assert.equal(ncm.pickDefaultQuality(rows, 'high').quality, 'exhigh');
  assert.equal(ncm.pickDefaultQuality(rows, 'standard').quality, 'standard');
  assert.equal(ncm.pickDefaultQuality(ncm.qualityRows({ qualities: [{ quality: 'hires', available: true }] }, '347230', () => [])), null);
});
