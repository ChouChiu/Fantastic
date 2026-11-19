// Playback identity: old snapshots without a source belong to Apple Music.
export const sourceOf = (track) => ['qq', 'ncm'].includes(track?.source) ? track.source : 'apple';
export const trackKey = (track) => `${sourceOf(track)}:${String(track?.track ?? track?.id ?? '')}`;
export const withIdentity = (track) => ({ ...track, source: sourceOf(track), key: trackKey(track) });
