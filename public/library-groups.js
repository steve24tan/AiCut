// Groups library assets by episode ("ep02", "EP 3", "第2集") and orders versions newest first
// ("v12" before "v11" before "v10"), so a growing pile of exports stays easy to scan.
// Pure functions only: the panel in library.js renders the result.
const EPISODE = [/(?:^|[^a-z])ep(?:isode)?[\s_.-]*(\d{1,4})/i, /第\s*(\d{1,4})\s*[集话話]/];
const VERSION = /(?:^|[^a-z])v(?:er)?[\s_.-]*(\d{1,4})(?![\d])/i;
const OTHER = '__other__';

export function parseName(name) {
  const text = String(name || '');
  let episode = null;
  for (const pattern of EPISODE) { const m = text.match(pattern); if (m) { episode = Number(m[1]); break; } }
  const v = text.match(VERSION);
  return { episode, version: v ? Number(v[1]) : null };
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
// Newest version first; unversioned files after the versioned ones, newest import first.
function byVersionDesc(a, b) {
  if (a.version != null && b.version != null && a.version !== b.version) return b.version - a.version;
  if ((a.version == null) !== (b.version == null)) return a.version == null ? 1 : -1;
  return String(b.asset.created_at || '').localeCompare(String(a.asset.created_at || '')) || collator.compare(a.asset.title, b.asset.title);
}

// Returns [{ key, label, episode, items: [asset…] }], episodes newest first, then "其他".
export function groupAssets(assets) {
  const groups = new Map();
  for (const asset of assets) {
    const parsed = parseName(asset.title);
    const fallback = parsed.episode == null ? parseName(asset.filename) : parsed;
    const episode = parsed.episode ?? fallback.episode, version = parsed.version ?? fallback.version;
    const key = episode == null ? OTHER : 'ep' + episode;
    if (!groups.has(key)) groups.set(key, { key, episode, label: episode == null ? '其他' : 'EP' + String(episode).padStart(2, '0'), entries: [] });
    groups.get(key).entries.push({ asset, version });
  }
  return [...groups.values()]
    .sort((a, b) => (a.episode == null) - (b.episode == null) || (b.episode ?? 0) - (a.episode ?? 0))
    .map(group => ({ key: group.key, label: group.label, episode: group.episode, items: group.entries.sort(byVersionDesc).map(entry => entry.asset) }));
}
