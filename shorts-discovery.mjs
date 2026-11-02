// A fresh session changes both the topic itinerary and the order within each pool.
export const DISCOVERY_TOPICS = [
  '動物 猫 犬', '科学 実験', '料理 レシピ', '音楽 楽器 演奏', 'ゲーム',
  'スポーツ 神技', '旅行 日本 絶景', 'コメディ コント', 'ものづくり 工作', 'ダンス',
  'アニメ', '技術 ガジェット', '数学 雑学', 'イラスト メイキング', '鉄道',
  '自然 生き物', 'マジック', '英語 学習', '日常 あるある', 'アート',
];
export function seedHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}
export function shuffleSeeded(values, seed) {
  const result = [...values]; let state = seedHash(seed) || 1;
  for (let i = result.length - 1; i > 0; i--) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const index = (state >>> 0) % (i + 1);
    [result[i], result[index]] = [result[index], result[i]];
  }
  return result;
}
export function discoveryQueries(session, page, context = '') {
  const topics = shuffleSeeded(DISCOVERY_TOPICS, session);
  const offset = (page - 1) * 2;
  const choices = [topics[offset % topics.length], topics[(offset + 1) % topics.length]];
  // Context keeps search/related recommendations relevant, while two other
  // categories prevent a single query or creator from dominating the feed.
  if (context) choices.unshift(context);
  return [...new Set(choices)].map(query => `${query} #shorts`);
}
export function diversifyShorts(videos, session, excluded = [], limit = 30) {
  const seen = new Set(excluded);
  const channels = new Map();
  for (const video of shuffleSeeded(videos, session)) {
    if (!video?.videoId || seen.has(video.videoId)) continue;
    seen.add(video.videoId);
    const channel = video.authorId || (video.author && !['チャンネル', 'Unknown', 'YouTube'].includes(video.author) ? video.author : video.videoId);
    if (!channels.has(channel)) channels.set(channel, []);
    channels.get(channel).push(video);
  }
  const result = [];
  const queues = [...channels.values()];
  for (let round = 0; round < 2; round++) for (const queue of queues) {
    if (queue[round]) result.push(queue[round]);
    if (result.length >= limit) return result;
  }
  return result;
}
