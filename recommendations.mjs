// Keep a home read inside the gateway deadline. The browser already sends its
// learned terms; fetching metadata for twenty history entries delays every visit.
export function registerRecommendations(app, getYoutube, formatVideo, unwanted) {
  app.get('/api/recommendations', async (req, res) => {
    const page = Number(req.query.page || 1);
    if (!Number.isInteger(page) || page < 1 || page > 20) return res.status(400).json({error:'ページが無効です。'});
    const keywords = String(req.query.keywords || '').trim().slice(0,160);
    const history = String(req.query.historyIds || '').split(',').filter(id => /^[\w-]{11}$/.test(id)).slice(0,1);
    const topics = ['日本 人気動画', '音楽 ライブ', '料理 レシピ', '科学 技術', 'ゲーム 実況', '旅行 日本'];
    try {
      const yt = await getYoutube();
      const queries = [...new Set([keywords || topics[(page-1)%topics.length], topics[page%topics.length]])];
      const pools = await Promise.allSettled(queries.map(async query => {
        let feed = await yt.search(query, {type:'video'});
        for (let i=1; i<Math.min(page,3); i++) {
          if (!feed.has_continuation) return [];
          feed = await feed.getContinuation();
        }
        return feed.videos || [];
      }).concat(history.map(async id => (await yt.getBasicInfo(id)).watch_next_feed || [])));
      const videos = [...new Map(pools.flatMap(result => result.status==='fulfilled' ? result.value : []).map(formatVideo).filter(v => v?.videoId && !unwanted(v)).map(v => [v.videoId,v])).values()].slice(0,40);
      if (!videos.length) {
        const failure = pools.find(result => result.status==='rejected');
        throw failure?.reason || new Error('Empty YouTube recommendations');
      }
      res.setHeader('Cache-Control','private, no-store');
      return res.json({videos, hasMore:page<20, source:'public-discovery', personalized:false});
    } catch {
      return res.status(502).json({error:'おすすめを取得できませんでした。再試行してください。',code:'YOUTUBE_RECOMMENDATIONS_FAILED'});
    }
  });
}
