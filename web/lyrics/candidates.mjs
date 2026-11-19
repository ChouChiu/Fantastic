// Try the next source if a candidate is empty, malformed or has no timed lines.
export function selectLyrics(candidates, parse, priority) {
  for (const source of priority) {
    for (const candidate of candidates || []) {
      if (candidate.source !== source || typeof candidate.text !== 'string' || !candidate.text.trim()) continue;
      try {
        const song = parse(candidate.text, source);
        if (song?.lines?.length) return { source, text: candidate.text, song, authors: [], amllStatus: null };
      } catch { /* fall through to the next candidate */ }
    }
  }
  return { song: null };
}
