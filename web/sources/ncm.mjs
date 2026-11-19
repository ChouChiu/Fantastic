// Native NetEase adapter. Account cookies stay in the server jar.
import { withIdentity } from './track.mjs';
import { playbackQualityChain } from '../playback-quality.mjs';
import { selectLyrics as selectCandidates } from '../lyrics/candidates.mjs';
export { trackKey } from './track.mjs';
export const enabled = () => globalThis.window?.FANTASTIC_HOST?.ncmEnabled === true;
export function numericId(value) {
  const id = String(value ?? '');
  if (!['string', 'number'].includes(typeof value) || !/^[1-9][0-9]{0,18}$/.test(id)
    || BigInt(id) > 9223372036854775807n || (typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error('Invalid NCM ID');
  return id;
}
export const QUALITY_IDS = ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jymaster'];
const fallback = QUALITY_IDS.map((quality, i) => ({ quality, defaultCodec: i < 3 ? 'mp3' : 'flac',
  contentType: i < 3 ? 'audio/mpeg' : 'audio/flac', playbackClass: 'native', sizeField: ['l', 'm', 'h', 'sq', 'hr', 'jm'][i] }));
let table = fallback;
export const capabilitiesReady = typeof globalThis.window !== 'undefined' && enabled() && typeof fetch === 'function'
  ? fetch('/ncm/capabilities', { cache: 'force-cache' }).then((r) => r.ok ? r.json() : null).then((data) => {
    if (data?.enabled && Array.isArray(data.qualities) && data.qualities.length === QUALITY_IDS.length
      && QUALITY_IDS.every((q) => data.qualities.some((r) => r.quality === q && ['mp3', 'flac'].includes(r.defaultCodec)
        && typeof r.contentType === 'string' && r.playbackClass === 'native'))) table = data.qualities;
    return capabilities();
  }).catch(() => null) : Promise.resolve(null);
export const capabilities = () => table.map((r) => ({ ...r }));
export function qualityId(value = 'standard') {
  if (!QUALITY_IDS.includes(value)) throw new Error('Invalid NCM quality');
  return value;
}
const QUALITY_STORAGE_KEY = 'am-hook:ncm:quality';
export function rememberQuality(quality) {
  qualityId(quality);
  try { globalThis.localStorage?.setItem(QUALITY_STORAGE_KEY, quality); } catch {}
}
function rememberedQuality() {
  try {
    const quality = globalThis.localStorage?.getItem(QUALITY_STORAGE_KEY);
    return QUALITY_IDS.includes(quality) ? quality : null;
  } catch { return null; }
}
const query = (q) => q === undefined ? '' : `?quality=${qualityId(q)}`;
export const songPath = (id) => `/ncm-song/${numericId(id)}`;
export const albumPath = (id) => `/ncm-album/${numericId(id)}`;
export const artistPath = (id) => `/ncm-artist/${numericId(id)}`;
export const playlistPath = (id) => `/ncm-playlist/${numericId(id)}`;
export const playUrl = (id, q) => `/ncm/song/${numericId(id)}/play${query(q)}`;
export const downloadUrl = (id, q) => `/ncm/song/${numericId(id)}/download${query(q)}`;
export function rawLyricsUrl(id, kind) {
  if (!['yrc', 'lrc', 'trans', 'roma', 'yroma'].includes(kind)) throw new Error('Invalid NCM raw lyric kind');
  return `/ncm/song/${numericId(id)}/lyrics/raw?kind=${kind}`;
}
export function webUrl(path) {
  const match = String(path || '').match(/^\/ncm-(song|album|artist|playlist)\/([1-9][0-9]{0,18})\/?$/);
  return match ? `https://music.163.com/${match[1]}?id=${numericId(match[2])}` : '';
}
export function artworkUrl(value) { return (typeof value === 'string' ? value : value?.url) || ''; }
export function toTrack(dto) {
  const id = numericId(dto.id);
  const albumId = dto.albumMid ? numericId(dto.albumMid) : '';
  const artists = (dto.artists || []).map((a) => typeof a === 'string' ? { name: a, href: '' }
    : { name: String(a.name || ''), href: a.mid ? artistPath(a.mid) : '' });
  return withIdentity({ source: 'ncm', kind: 'song', id, name: String(dto.name || ''), title: String(dto.name || ''),
    artists, artist: artists.map((a) => a.name).join(' / '), album: String(dto.album || ''), albumId,
    albumHref: albumId ? albumPath(albumId) : '', href: songPath(id), country: '',
    duration: Number.isFinite(dto.durationMs) ? Math.max(0, dto.durationMs) : 0,
    artwork: { url: artworkUrl(dto.cover) }, explicit: false, ncm: { id, albumId, vip: dto.vip === true } });
}
export function fromSnapshot(snapshot) {
  const id = numericId(snapshot.id);
  return withIdentity({ ...snapshot, source: 'ncm', kind: 'song', id, title: snapshot.name || '',
    artwork: { url: artworkUrl(snapshot.artwork) }, ncm: { id, albumId: snapshot.albumId || '', vip: snapshot.vip === true } });
}
export const entryOf = (track) => withIdentity({ ...track, track: track.id, artwork: artworkUrl(track.artwork) });
export function playbackInfo(quality = 'standard', row = {}) {
  const cap = table.find((r) => r.quality === qualityId(quality));
  const codec = row.codec || cap.defaultCodec;
  return { playback: 'native', codec, codecs: codec, contentType: row.contentType || cap.contentType };
}
export const qualityVariant = (q, row = {}) => ({ source: 'ncm', group_id: qualityId(q), quality: q,
  ...playbackInfo(q, row), format: row.format || '', bandwidth: row.bitrate || 0 });
export function variantItem(id, variant) {
  const q = qualityId(variant.quality);
  return { id: `ncm:${numericId(id)}:${q}`, quality: q, ...playbackInfo(q, variant), variant,
    streamUrl: playUrl(id, q), downloadUrl: downloadUrl(id, q), label: `NCM · ${q}` };
}
export const qualityEntry = (track, q = 'standard', row) => ({ ...entryOf(track), quality: qualityId(q), ...playbackInfo(q, row) });
export const qualityItem = (track, q = 'standard', row) => ({ ...qualityEntry(track, q, row), ...variantItem(track.id, qualityVariant(q, row)), title: track.name });
export const qualityVariants = (rows) => rows.filter((r) => r.available && r.playable !== false && r.playback === 'native').map((r) => qualityVariant(r.quality, r));
export const QUALITY_GROUPS = [
  { id: 'lossless', title: 'q.lossless', titleKey: true, qualities: ['jymaster', 'hires', 'lossless'] },
  { id: 'mp3', title: 'MP3', titleKey: false, qualities: ['exhigh', 'higher', 'standard'] },
];
export const QUALITY_GROUP_ORDER = QUALITY_GROUPS.map((g) => g.id);
export const QUALITY_GROUPS_BY_ID = new Map(QUALITY_GROUPS.map((g) => [g.id, g]));
export const qualityGroupFor = (q) => QUALITY_GROUPS.find((g) => g.qualities.includes(q))?.id || 'other';
export const qualityGroupTitle = (group, row = {}) => QUALITY_GROUPS_BY_ID.get(group)?.title || row.format || row.quality || group;
async function request(path, signal) {
  const response = await fetch(path, { signal });
  if (!response.ok) { const error = new Error(`NCM HTTP ${response.status}`); error.status = response.status; throw error; }
  return response.json();
}
const SEARCH_KEYS = { song: 'songs', album: 'albums', artist: 'artists', playlist: 'playlists' };
export const SEARCH_TYPES = Object.keys(SEARCH_KEYS);
export async function search(q, type = 'song', { limit = 30, offset = 0, signal } = {}) {
  if (!SEARCH_KEYS[type]) throw new Error('Invalid NCM search type');
  const data = await request(`/ncm/search?${new URLSearchParams({ q, kind: type, limit, offset })}`, signal);
  const items = data[SEARCH_KEYS[type]] || [];
  return { items: type === 'song' ? items.map(toTrack) : items, total: Number(data.total) || 0 };
}
export async function searchSongs(q, options) { const result = await search(q, 'song', options); return { songs: result.items, total: result.total }; }
export const suggest = (q, signal) => request(`/ncm/suggest?${new URLSearchParams({ q })}`, signal);
export async function song(id, signal) { const data = await request(`/ncm/song/${numericId(id)}`, signal); return { ...toTrack(data), meta: data.meta || null }; }
export const album = (id, signal) => request(`/ncm/album/${numericId(id)}`, signal);
export const artist = (id, signal) => request(`/ncm/artist/${numericId(id)}`, signal);
const page = ({ limit, offset = 0 }) => new URLSearchParams({ ...(limit ? { limit } : {}), offset });
export async function artistSongs(id, { limit, offset, signal } = {}) {
  const data = await request(`/ncm/artist/${numericId(id)}/songs?${page({ limit, offset })}`, signal);
  return { ...data, songs: (data.songs || []).map(toTrack) };
}
export const artistAlbums = (id, { limit, offset, signal } = {}) => request(`/ncm/artist/${numericId(id)}/albums?${page({ limit, offset })}`, signal);
export async function playlist(id, { limit, offset, signal } = {}) {
  const data = await request(`/ncm/playlist/${numericId(id)}?${page({ limit, offset })}`, signal);
  return { ...data, songs: (data.songs || []).map(toTrack) };
}
export function qualityRows(data, id, detect = globalThis.window?.AmHook?.detectQqModes) {
  return QUALITY_IDS.map((quality) => {
    const row = data?.qualities?.find((r) => r.quality === quality);
    const available = row?.available === true;
    const info = playbackInfo(quality, row);
    const playable = available && (!detect || detect(info).length > 0);
    return { ...row, quality, group: qualityGroupFor(quality), available, playable, ...info,
      ...(available ? { downloadUrl: downloadUrl(id, quality) } : {}), ...(playable ? { playUrl: playUrl(id, quality) } : {}) };
  });
}
export async function qualities(id, signal) { await capabilitiesReady; return qualityRows(await request(`/ncm/song/${numericId(id)}/qualities`, signal), id); }
export function pickDefaultQuality(rows, preference = 'hires') {
  const choices = { hires: ['jymaster', 'hires'], lossless: ['lossless'], high: ['exhigh', 'higher'], standard: ['standard'] };
  const saved = rememberedQuality();
  if (saved) {
    const selected = rows.find((r) => r.quality === saved && r.available && r.playable !== false);
    if (selected) return selected;
    preference = Object.keys(choices).find((tier) => choices[tier].includes(saved));
  }
  for (const tier of playbackQualityChain(preference)) for (const q of choices[tier] || []) {
    const row = rows.find((r) => r.quality === q && r.available && r.playable !== false);
    if (row) return row;
  }
  return null;
}
/** Resolve immediately before audio.src; expiring CDN links never enter saved queues. */
export async function resolvePlay(id, quality, signal) {
  const data = await request(playUrl(id, quality), signal);
  const url = new URL(data.url);
  if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)music\.(126\.net|163\.com)$/.test(url.hostname)) throw new Error('Invalid NCM audio URL');
  return { ...data, quality: qualityId(data.quality), url: url.href };
}

const voice = () => ({ text: '', tokens: [], translation: '', pronunciation: '', pronunciationTokens: [] });
function model(lines, timing) {
  return { source: 'ncm', timing, language: '', duration: Math.max(0, ...lines.map((l) => l.end)), audioOffsets: {}, agents: {},
    sections: [{ begin: lines[0]?.begin || 0, end: lines.at(-1)?.end || 0, type: 'verse', lines }], lines,
    credits: [], authors: [], translation: { language: '', type: '', automatic: false }, pronunciation: { language: '', automatic: false } };
}
/** YRC word timestamps are absolute milliseconds, preceding each word. */
export function parseYrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const match = raw.trim().match(/^\[(\d+),(\d+)\](.*)$/);
    if (!match) continue; // includes blank lines and {"t":...,"c":[...]} credits
    const begin = Number(match[1]); const end = begin + Number(match[2]);
    const tokens = [...match[3].matchAll(/\((\d+),(\d+)(?:,\d+)?\)([^]*?)(?=\(\d+,\d+(?:,\d+)?\)|$)/g)]
      .map((m) => ({ begin: Number(m[1]), end: Number(m[1]) + Number(m[2]), text: m[3], spaceAfter: false }));
    if (!tokens.length || !tokens.some((t) => t.text.trim())) continue;
    lines.push({ ...voice(), key: `ncm:${lines.length}`, begin, end: Math.max(end, ...tokens.map((t) => t.end)),
      text: tokens.map((t) => t.text).join(''), tokens, agent: 'v1', background: voice() });
  }
  return model(lines.sort((a, b) => a.begin - b.begin), 'Word');
}
export function parseLrc(text) {
  const lines = [];
  const offset = Number(String(text || '').match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0);
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!words) continue;
    for (const m of tags) lines.push({ ...voice(), key: `ncm:${lines.length}`, begin: Math.max(0, Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number((m[3] || '').padEnd(3, '0')) + offset),
      end: 0, text: words, agent: 'v1', background: voice() });
  }
  lines.sort((a, b) => a.begin - b.begin);
  lines.forEach((l, i) => { l.end = lines[i + 1]?.begin ?? l.begin + 5000; });
  return model(lines, 'Line');
}
export const LYRIC_PRIORITY = ['amll', 'yrc', 'lrc'];
export function selectLyrics(candidates, parse) {
  return selectCandidates(candidates, (text, source) => source === 'amll' ? parse(text)
    : source === 'yrc' ? parseYrc(text) : parseLrc(text), LYRIC_PRIORITY);
}
/** Attach secondary lyrics by line timestamps; translated text never becomes a main candidate. */
export function attachLyrics(song, { trans = '', roma = '', yroma = '' } = {}) {
  const translations = parseLrc(trans).lines;
  const romans = parseLrc(roma).lines;
  const wordRomans = parseYrc(yroma).lines;
  const aligned = (lines, time) => lines.reduce((best, l) => Math.abs(l.begin - time) <= 500
    && (!best || Math.abs(l.begin - time) < Math.abs(best.begin - time)) ? l : best, null);
  for (const line of song.lines) {
    line.translation = aligned(translations, line.begin)?.text || '';
    const timed = aligned(wordRomans, line.begin);
    if (timed && timed.tokens.length === line.tokens.length && line.tokens.length) line.pronunciationTokens = timed.tokens;
    else line.pronunciation = timed?.text || aligned(romans, line.begin)?.text || '';
  }
  return song;
}
export const lyricLines = (result) => (result?.song?.lines || []).map((l) => ({ text: l.text, translation: l.translation || '' }));
export async function lyrics(id, parse, signal) {
  const data = await request(`/ncm/song/${numericId(id)}/lyrics`, signal);
  const result = selectLyrics(data.candidates, parse);
  if (result.song) {
    const raw = async (kind) => { const r = await fetch(rawLyricsUrl(id, kind), { signal }); if (r.status === 404) return ''; if (!r.ok) throw new Error(`NCM HTTP ${r.status}`); return r.text(); };
    const optional = (kind, present) => present ? raw(kind).catch((e) => { if (e.name === 'AbortError') throw e; return ''; }) : '';
    const [trans, roma, yroma] = await Promise.all([optional('trans', data.rawTrans), optional('roma', data.rawRoma), optional('yroma', data.rawRoma)]);
    if (result.source !== 'amll') attachLyrics(result.song, { trans, roma, yroma });
    result.rawRomaKind = roma ? 'roma' : yroma ? 'yroma' : 'roma';
  }
  return { ...result, rawYrc: data.rawYrc === true, rawLrc: (data.candidates || []).some((c) => c.source === 'lrc'), rawTrans: data.rawTrans === true, rawRoma: data.rawRoma === true };
}
export function download(track, quality) {
  const link = Object.assign(document.createElement('a'), { href: downloadUrl(track.track ?? track.id, quality), download: '' });
  document.body.append(link); link.click(); link.remove();
}
