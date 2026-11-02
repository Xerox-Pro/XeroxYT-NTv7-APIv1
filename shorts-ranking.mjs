const RANKING_URL = 'https://shorts-ranking.com/latest.json';
export function parseRanking(data) {
  if (!data || !Array.isArray(data.items)) throw new Error('ランキングのデータ形式が変わりました。');
  const seen = new Set();
  const videos = [...data.items].sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0)).flatMap(item => {
    const id = item.video_id;
    if (!/^[\w-]{11}$/.test(id) || seen.has(id)) return [];
    // Only IDs are used to construct playback URLs; arbitrary upstream URLs are ignored.
    seen.add(id);
    return [{ videoId: id, type: 'video', isShort: true, shortSource: 'ranking',
      title: String(item.title || 'ショート動画').slice(0, 500),
      author: String(item.channel_title || 'チャンネル').slice(0, 200),
      viewCount: Math.max(0, Number(item.views) || 0), publishedText: '', lengthSeconds: 0,
      videoThumbnails: [{ url: `https://i.ytimg.com/vi/${id}/frame0.jpg` }],
    }];
  }).slice(0, 200);
  return { videos, count: videos.length, limit: 200, updatedAt: typeof data.updated_at === 'string' ? data.updated_at.slice(0, 100) : '', sourceUrl: 'https://shorts-ranking.com/' };
}
export function createRankingLoader(fetchUpstream = fetch) {
  let pending;
  return async () => {
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchUpstream(`${RANKING_URL}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10000), redirect: 'error', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`ランキング取得失敗（${response.status}）`);
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('ランキングのデータが大きすぎます。');
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new Error('ランキングのデータが大きすぎます。'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return parseRanking(JSON.parse(new TextDecoder().decode(bytes)));
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
export function registerRankingRoute(app, load = createRankingLoader()) {
  app.get('/api/shorts-ranking', async (_req, res) => {
    try { const result = await load(); res.setHeader('Cache-Control', 'private, no-store'); return res.json(result); }
    catch (error) { console.error('[Shorts ranking]', error.message); return res.status(502).json({ error: 'ランキングを取得できませんでした。通常のショート候補を表示します。' }); }
  });
}
