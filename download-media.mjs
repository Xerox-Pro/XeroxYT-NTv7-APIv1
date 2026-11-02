// Validate each bounded range before returning it to the browser.
export async function handleDownloadMedia(req, res, proxyFetch) {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  let parsed;
  try { parsed = new URL(url); } catch {}
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !/(^|\.)googlevideo\.com$/i.test(parsed.hostname)) return res.status(400).json({error:'不正なデータ要求です。'});
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  if (!range) return res.status(400).json({error:'取得範囲が不正です。'});
  const start = Number(range[1]), end = Number(range[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start >= 4 * 1024 * 1024) return res.status(400).json({error:'取得範囲が不正です。'});
  const expiry = parsed.searchParams.get('expire');
  const expired = expiry && /^\d+$/.test(expiry) && Number(expiry) * 1000 <= Date.now();
  res.set('Cache-Control', 'private, no-store');
  if (expired) return res.status(403).json({code:'MEDIA_URL_EXPIRED', error:'動画または音声のURLの有効期限が切れました。もう一度ダウンロードを開始してください。'});
  try {
    const upstream = await proxyFetch(url, { headers: { Range: `bytes=${start}-${end}` } }, req.headers.cookie || '');
    if (upstream.status !== 206) {
      const status = upstream.status;
      await upstream.body?.cancel();
      if (status === 403) return res.status(403).json({code:'MEDIA_FORBIDDEN', error:'動画配信元がアクセスを拒否しました。URLの署名や期限、アクセス制限が原因の可能性があります。'});
      if (status === 401) return res.status(401).json({code:'SESSION_EXPIRED', error:'ログイン状態を確認してください。'});
      if (status === 429) { const retry = upstream.headers.get('retry-after'); if (retry) res.set('Retry-After', retry); return res.status(429).json({code:'RATE_LIMITED', error:'アクセスが制限されています。時間をおいて再試行してください。'}); }
      if (status === 504) return res.status(504).json({code:'UPSTREAM_TIMEOUT', error:'動画配信元への接続がタイムアウトしました。'});
      return res.status(502).json({code:'UPSTREAM_ERROR', error:`動画配信元から正常な部分データを取得できませんでした（HTTP ${status}）。`});
    }
    const contentRange = upstream.headers.get('content-range') || '';
    const contentType = upstream.headers.get('content-type') || '';
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!match || Number(match[1]) !== start || Number(match[2]) !== end || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= end || !/^(video|audio)\//i.test(contentType)) {
      await upstream.body?.cancel(); return res.status(502).json({code:'INVALID_RANGE', error:'動画配信元から不正な範囲のデータが返されました。'});
    }
    const expected = end - start + 1, reader = upstream.body?.getReader();
    if (!reader) return res.status(502).json({code:'EMPTY_BODY', error:'データがありません。'});
    const parts = []; let received = 0;
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; received += chunk.value.byteLength; if (received > expected) { await reader.cancel(); return res.status(502).json({code:'INVALID_LENGTH', error:'データのサイズが不正です。'}); } parts.push(chunk.value); }
    if (received !== expected) return res.status(502).json({code:'INCOMPLETE_BODY', error:'データが途中で切れました。'});
    return res.status(206).set({'Content-Type':contentType,'Content-Range':contentRange,'Content-Length':String(received),'Accept-Ranges':'bytes'}).send(Buffer.concat(parts.map(p => Buffer.from(p))));
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return res.status(504).json({code:'UPSTREAM_TIMEOUT', error:'動画配信元への接続がタイムアウトしました。'});
    return res.status(502).json({code:'UPSTREAM_ERROR', error:'動画配信元への接続に失敗しました。'});
  }
}
