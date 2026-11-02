import { discoveryQueries, diversifyShorts } from './shorts-discovery.mjs';
// Shorts are identified by YouTube's renderer/endpoint AND a portrait thumbnail,
// never by a title, hashtag or duration. Playback verifies actual video dimensions.
export function hasShortsTag(item) {
  const text = value => typeof value === 'string' ? value : value?.text || '';
  return /#shorts(?![\p{L}\p{N}_])/iu.test([text(item?.title), text(item?.description), text(item?.short_description), ...(item?.hashtags || []).map(tag => '#' + String(tag).replace(/^#/, ''))].join(' '));
}
export function isShortAspect(width, height) {
  const ratio = Number(width) / Number(height);
  return Number(width) > 0 && Number(height) > 0 && ratio >= 0.48 && ratio <= 0.65;
}

export function normalizeShort(item) {
  if (!item || typeof item !== 'object') return null;
  const endpoint = item.on_tap_endpoint || item.endpoint;
  const nativeShort = ['ShortsLockupView', 'ReelItem'].includes(item.type) ||
    item.content_type === 'SHORT' || endpoint?.metadata?.api_url?.includes('/reel/') ||
    endpoint?.name === 'reelWatchEndpoint';
  const tagged = hasShortsTag(item);
  if (!nativeShort && !tagged) return null;
  const videoId = endpoint?.payload?.videoId || item.id || item.content_id ||
    (typeof item.entity_id === 'string' ? item.entity_id.replace(/^shorts-shelf-item-/, '') : '');
  if (!/^[\w-]{11}$/.test(videoId)) return null;
  const thumbnails = [item.thumbnail, item.thumbnails, item.content_image?.image, endpoint?.payload?.thumbnail?.thumbnails].filter(Array.isArray).flat();
  const portrait = Array.isArray(thumbnails) ? thumbnails.filter(t => isShortAspect(t.width, t.height)) : [];

  const text = value => typeof value === 'string' ? value : value?.text || '';
  return {
    videoId, type: 'video', isShort: true, shortSource: 'youtube',
    title: text(item.overlay_metadata?.primary_text) || text(item.title) || text(item.metadata?.title) || 'ショート動画',
    author: item.author?.name || (typeof item.author === 'string' ? item.author : '') || 'チャンネル',
    authorId: item.author?.id,
    authorAvatar: item.author?.thumbnails?.[0]?.url,
    originalAspect: endpoint?.payload?.thumbnail?.isOriginalAspectRatio === true
      ? portrait.find(t => endpoint.payload.thumbnail.thumbnails?.some(original => original.url === t.url && original.width === t.width && original.height === t.height))
      : undefined,
    viewCount: 0,
    viewCountText: text(item.overlay_metadata?.secondary_text) || text(item.views),
    publishedText: '', lengthSeconds: 0, videoThumbnails: portrait.length ? portrait : thumbnails.length ? thumbnails : [{ url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }],
  };
}

export function collectShorts(feed) {
  const result = new Map();
  const seen = new WeakSet();
  let visited = 0;
  function walk(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 16 || visited++ > 12000) return;
    seen.add(value);
    const short = normalizeShort(value);
    if (short) result.set(short.videoId, short);
    if (value instanceof Map) { for (const entry of value.values()) walk(entry, depth + 1); }
    else for (const child of Object.values(value)) walk(child, depth + 1);
  }
  walk(feed?.videos);
  walk(feed?.watch_next_feed);
  walk(feed?.page);
  walk(feed);
  return [...result.values()];
}

export function descriptionText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.runs)) return value.runs.map(run => run.text || '').join('');
  return '';
}
export function shortDescription(info) {
  const direct = [info.secondary_info?.description, info.basic_info?.short_description, info.basic_info?.description];
  for (const item of direct) { const text = descriptionText(item); if (text.trim()) return text; }
  const visited = new WeakSet(); let count = 0;
  function find(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12 || count++ > 3000 || visited.has(node)) return '';
    visited.add(node);
    if (/ExpandableVideoDescriptionBody|VideoDescriptionBody|DescriptionPreviewView/i.test(node.type || '')) {
      for (const item of [node.description, node.attributed_description, node.content]) { const text = descriptionText(item); if (text.trim()) return text; }
    }
    for (const child of Object.values(node)) { const text = find(child, depth + 1); if (text) return text; }
    return '';
  }
  return find(info.page);
}
export function shortDetails(info, videoId, originalAspect, fallbackTitle = '') {
  const basic = info.basic_info || {};
  const formats = [...(info.streaming_data?.adaptive_formats || []), ...(info.streaming_data?.formats || [])];
  const dimensions = formats.find(f => f.width > 0 && f.height > 0) || originalAspect;
  const owner = info.secondary_info?.owner;
  return { video: {
    videoId, type: 'video', isShort: true, shortSource: 'youtube', aspectVerified: Boolean(dimensions && isShortAspect(dimensions.width, dimensions.height)), shortEligible: true,
    width: dimensions?.width, height: dimensions?.height,
    title: basic.title || info.primary_info?.title?.text || originalAspect?.title || fallbackTitle || 'ショート動画',
    author: owner?.author?.name || basic.author || originalAspect?.author || 'チャンネル',
    authorId: owner?.author?.id || basic.channel_id,
    authorAvatar: owner?.author?.thumbnails?.[0]?.url,
    description: shortDescription(info),
    viewCount: basic.view_count || 0,
    likeCount: Number.isFinite(basic.like_count) ? basic.like_count : undefined,
    publishedText: info.primary_info?.published?.text || '',
    lengthSeconds: basic.duration || 0, videoThumbnails: basic.thumbnail || [],
  } };
}

export function registerShortsRoutes(app, getYoutube) {
  // Public feed cache, bounded and independent of serverless affinity. Cold instances
  // replay real continuations, rather than inventing another search query per page.
  const cache = new Map();
  const inflight = new Map();
  const originalAspects = new Map();
  function rememberOriginalAspects(videos) {
    for (const video of videos) if (video.originalAspect) {
      if (originalAspects.size >= 500) originalAspects.delete(originalAspects.keys().next().value);
      originalAspects.set(video.videoId, { ...video, ...video.originalAspect, expires: Date.now() + 300000 });
    }
  }
  const cached = async (key, load) => {
    const old = cache.get(key);
    if (old && old.expires > Date.now()) {
      cache.delete(key); cache.set(key, old);
      return old.value;
    }
    if (old) cache.delete(key);
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      const value = await load();
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: Date.now() + 300000 });
      return value;
    })();
    // Limit bookkeeping; requests beyond the cap still execute normally.
    if (inflight.size < 100) inflight.set(key, promise);
    try { return await promise; }
    finally { if (inflight.get(key) === promise) inflight.delete(key); }
  };
  app.get('/api/shorts', async (req, res) => {
    const source = req.query.source || 'home';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const interest = typeof req.query.interest === 'string' ? req.query.interest.trim() : '';
    let interests = [];
    try { interests = req.query.interests ? JSON.parse(String(req.query.interests)) : []; } catch { return res.status(400).json({ error: 'ハッシュタグの指定を確認してください。' }); }
    if (!Array.isArray(interests) || interests.length > 5 || interests.some(tag => typeof tag !== 'string' || tag.length > 160 || !/^#[\p{L}\p{N}_]+$/u.test(tag))) return res.status(400).json({ error: 'ハッシュタグは最大5個まで指定できます。' });
    const videoId = typeof req.query.videoId === 'string' ? req.query.videoId : '';
    const page = Number(req.query.page || 1);
    const session = typeof req.query.session === 'string' ? req.query.session : '';
    const excludeText = typeof req.query.exclude === 'string' ? req.query.exclude : '';
    const excluded = excludeText ? excludeText.split(',') : [];
    if (!['home', 'search', 'related'].includes(source) || q.length > 200 || interest.length > 160 ||
      (session && !/^[\w-]{1,80}$/.test(session)) || excluded.length > 300 || excluded.some(id => !/^[\w-]{11}$/.test(id)) ||
      !Number.isInteger(page) || page < 1 || page > 20 ||
      (source === 'search' && !q) || (source === 'related' && !/^[\w-]{11}$/.test(videoId))) {
      return res.status(400).json({ error: 'ショートの取得条件を確認してください。' });
    }
    try {
      if (session) {
        const youtube = await getYoutube();
        let context = q;
        let primary = [];
        if (source === 'related') {
          try {
            const info = await cached(`info:${videoId}`, () => youtube.getInfo(videoId));
            context = info.basic_info?.title?.replace(/#[^\s]+/g, '').slice(0, 100) || '';
            if (page === 1) primary = collectShorts(info);
          } catch { /* Topic discovery still works if the source metadata is unavailable. */ }
        }
        const queries = source === 'search' ? [q] : discoveryQueries(session, page, context);
        const round = source === 'search' ? page - 1 : Math.floor((page - 1) / 10);
        const tasks = queries.map(async query => {
          let feed = await cached(`discovery:${query}`, async () => {
            let search = await youtube.search(query, { type: 'all' });
            const chip = search.refinement_filters?.find(name => /^(shorts|ショート(?:動画)?)$/i.test(name));
            if (chip) search = await search.applyRefinement(chip);
            return search;
          });
          for (let index = 0; index < round; index++) {
            if (!feed.has_continuation) return [];
            const previous = feed;
            feed = await cached(`discovery-continuation:${query}:${index}`, () => previous.getContinuation());
          }
          return collectShorts(feed);
        });
        if (source === 'home' && !q && page === 1) tasks.push((async () => {
          try { return collectShorts(await cached('home-feed', () => youtube.getHomeFeed())); } catch { return []; }
        })());
        const terms = source === 'search' ? [] : [...new Set([...interests, interest].filter(Boolean))];
        const personalTask = Promise.all(terms.map(async rawTerm => {
          const term = rawTerm.replace(/#shorts(?![\p{L}\p{N}_])/giu, '').trim();
          if (!term) return [];
          let feed = await cached(`personal-shorts:${term}`, async () => {
            let search = await youtube.search(`${term} #shorts`, { type: 'all' });
            const chip = search.refinement_filters?.find(name => /^(shorts|ショート(?:動画)?)$/i.test(name));
            if (chip) search = await search.applyRefinement(chip);
            return search;
          });
          const found = new Map();
          for (let round = 0; round < 3; round++) {
            for (const video of collectShorts(feed)) if (!excluded.includes(video.videoId) && video.videoId !== videoId) found.set(video.videoId, video);
            if (found.size >= 10 || !feed.has_continuation) break;
            const previous = feed;
            feed = await cached(`personal-continuation:${term}:${round}`, () => previous.getContinuation());
          }
          return [...found.values()].slice(0, 10);
        }).map(task => task.catch(() => []))).then(pools => {
          // Round-robin the selected tags so one tag cannot occupy every slot.
          const result = [];
          for (let i = 0; i < 10; i++) for (const pool of pools) if (pool[i]) result.push(pool[i]);
          return result;
        });
        const [results, personal] = await Promise.all([Promise.allSettled(tasks), personalTask]);
        const pools = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
        if (!primary.length && !personal.length && results.every(result => result.status === 'rejected')) throw new Error('All discovery sources failed');
        const candidates = [...primary, ...pools];
        rememberOriginalAspects(candidates);
        let videos = diversifyShorts(candidates, `${session}:${page}`, [...excluded, videoId].filter(Boolean));
        if (personal.length) {
          // Ranking still occupies half the final feed. Personalize 60% of
          // this non-ranking pool to target 30% overall (3 of every 10 clips).
          const picks = [...new Map(personal.map(video => [video.videoId, video])).values()].slice(0, 18);
          const pickIds = new Set(picks.map(v => v.videoId));
          const general = videos.filter(v => !pickIds.has(v.videoId));
          const mixed = [];
          for (let i = 0; i < 30 && (general.length || picks.length); i++) {
            const preferPersonal = i % 5 === 0 || i % 5 === 2 || i % 5 === 4;
            if (preferPersonal && picks.length) mixed.push(picks.shift());
            else if (general.length) mixed.push(general.shift());
            else if (picks.length) mixed.push(picks.shift());
          }
          videos = mixed;
          rememberOriginalAspects(personal);
        }
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ videos, hasMore: page < 20, page });
      }
      const result = await cached(JSON.stringify([source, q, videoId, page]), async () => {
        const youtube = await getYoutube();
        let query = q;
        let relatedShorts = [];
        let feed;
        if (source === 'home' && !q) {
          try {
            const home = await cached('home-feed', () => youtube.getHomeFeed());
            if (collectShorts(home).length) feed = home;
          } catch { /* Some anonymous sessions have no home feed. */ }
        }
        if (source === 'related') {
          const info = await cached(`info:${videoId}`, () => youtube.getInfo(videoId));
          if (page === 1) relatedShorts = collectShorts(info).filter(v => v.videoId !== videoId);
          query = info.basic_info?.title?.slice(0, 160) || '';
        }
        if (!feed) {
          feed = await cached(`search-feed:${query}`, async () => {
            let search = await youtube.search(query || '日本 ショート', { type: 'all' });
            const refinement = search.refinement_filters?.find(name => /^(shorts|ショート(?:動画)?)$/i.test(name));
            if (refinement) search = await search.applyRefinement(refinement);
            return search;
          });
        }
        for (let index = 1; index < page; index++) {
          if (!feed.has_continuation) return { videos: [], hasMore: false, page };
          const previous = feed;
          feed = await cached(`continuation:${source}:${query}:${videoId}:${index}`, () => previous.getContinuation());
        }
        return {
          videos: [...new Map([...relatedShorts, ...collectShorts(feed)].filter(v => v.videoId !== videoId).map(v => [v.videoId, v])).values()],
          hasMore: Boolean(feed.has_continuation) && page < 20, page,
        };
      });
      rememberOriginalAspects(result.videos);
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      res.json(result);
    } catch (error) {
      console.error('[Shorts feed]', error?.message);
      res.status(502).json({ error: 'ショート動画を取得できませんでした。時間をおいて再試行してください。' });
    }
  });
  app.get('/api/shorts/:id', async (req, res) => {
    if (!/^[\w-]{11}$/.test(req.params.id)) return res.status(400).json({ error: '動画IDが正しくありません。' });
    try {
      const info = await cached(`info:${req.params.id}`, async () => (await getYoutube()).getInfo(req.params.id));
      let original = originalAspects.get(req.params.id);
      if (original?.expires < Date.now()) original = undefined;
      const fallbackTitle = typeof req.query.title === 'string' ? req.query.title.slice(0, 500) : '';
      const result = shortDetails(info, req.params.id, original, fallbackTitle);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.setHeader('Cache-Control', 'public, s-maxage=300');
      return res.json(result.video);
    } catch (error) {
      console.error('[Shorts details]', error?.message);
      return res.status(502).json({ error: 'ショートの動画情報を取得できませんでした。再試行してください。' });
    }
  });
}
