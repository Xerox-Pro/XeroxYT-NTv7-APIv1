import {playlistCard,readYouTubeMix} from "./youtube-mix.mjs";
import {fetchPublicWatchNext} from "./watch-next.mjs";
import { registerYouTubeAccount } from "./youtube-account.mjs";
import { registerFilteredSearch } from "./filtered-search.mjs";
import express from "express";
import { registerShortsRoutes, normalizeShort } from "./shorts.mjs";
import { registerRankingRoute } from "./shorts-ranking.mjs";
import path from "path";
import crypto from "crypto";
import { Innertube, UniversalCache, YT, YTNodes, ClientType, Mixins, Log } from "youtubei.js";
import axios from "axios";

// Suppress noisy youtubei.js internal logs
const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args) => {
  const msg = args.map((a) => String(a)).join(" ");
  if (
    msg.includes("[YOUTUBEJS][Parser]:") ||
    msg.includes("PlayerInterstitial") ||
    msg.includes("InterstitialView") ||
    msg.includes("ERROR_HANDLER")
  )
    return;
  originalWarn.apply(console, args);
};
console.error = (...args) => {
  const msg = args.map((a) => String(a)).join(" ");
  if (
    msg.includes("[YOUTUBEJS][Parser]:") ||
    msg.includes("PlayerInterstitial") ||
    msg.includes("InterstitialView") ||
    msg.includes("ERROR_HANDLER")
  )
    return;
  originalError.apply(console, args);
};


let yt: Innertube | null = null;
let ytInstancePromise: Promise<Innertube> | null = null;

async function getYt() {
  if (yt) return yt;
  if (ytInstancePromise) return ytInstancePromise;

  ytInstancePromise = (async () => {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        attempts++;
        console.log(`[YT] Initializing Innertube (Attempt ${attempts})...`);
        const instance = await Innertube.create({
          cache: new UniversalCache(false),
          location: "JP",
          lang: "ja",
          retrieve_player: false,
        });
        
        yt = instance;
        console.log("[YT] Innertube initialized successfully");
        return instance;
      } catch (err) {
        console.error(`[YT] Initialization error (Attempt ${attempts}):`, err);
        if (attempts >= maxAttempts) {
          ytInstancePromise = null;
          throw err;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error("Failed to initialize YT after multiple attempts");
  })();

  return ytInstancePromise;
}

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yt.drgnz.club",
  "https://invidious.jing.rocks",
  "https://invidious.private.coffee",
  "https://invidious.drgns.space",
];

async function fetchInvidiousChannel(channelId: string) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const resp = await axios.get(
        `${instance}/api/v1/channels/${encodeURIComponent(channelId)}`,
        {
          timeout: 3500,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        },
      );
      if (resp.data && (resp.data.author || resp.data.authorId)) {
        const d = resp.data;
        const videos = (d.latestVideos || [])
          .map((v: any) => ({
            videoId: v.videoId,
            title: v.title,
            author: d.author || v.author || "チャンネル",
            authorId: d.authorId || channelId,
            authorAvatar:
              d.authorThumbnails?.[d.authorThumbnails.length - 1]?.url || "",
            viewCount: v.viewCount || 0,
            publishedText: v.publishedText || "",
            lengthSeconds: v.lengthSeconds || 0,
            videoThumbnails: v.videoThumbnails || [
              {
                url: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
                width: 480,
                height: 360,
              },
            ],
            type: "video",
          }))
          .filter((v: any) => v && v.videoId);

        const shorts = videos.filter(
          (v: any) =>
            v &&
            v.title &&
            (v.title.toLowerCase().includes("short") ||
              (v.lengthSeconds > 0 && v.lengthSeconds <= 60)),
        );
        return {
          id: d.authorId || channelId,
          title: d.author || "チャンネル",
          description: d.description || "",
          avatar:
            d.authorThumbnails?.[d.authorThumbnails.length - 1]?.url ||
            `https://ui-avatars.com/api/?name=${encodeURIComponent(d.author || "C")}&background=random`,
          banner: d.authorBanners?.[d.authorBanners.length - 1]?.url || "",
          subCountText: d.subCount
            ? `${d.subCount >= 10000 ? (d.subCount / 10000).toFixed(1) + "万人" : d.subCount + "人"}のチャンネル登録者`
            : "",
          videosCountText: `${videos.length} 本の動画`,
          featuredVideo: videos[0] || null,
          videos: videos,
          shortVideos: shorts,
          playlists: [],
        };
      }
    } catch (e) {
      // try next instance
    }
  }
  return null;
}

async function fetchYouTubeRssChannel(channelId: string) {
  try {
    const url = channelId.startsWith("UC")
      ? `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
      : `https://www.youtube.com/feeds/videos.xml?user=${channelId}`;
    const resp = await axios.get(url, { timeout: 3500 });
    const xml = resp.data;
    if (typeof xml === "string" && xml.includes("<entry>")) {
      const channelTitleMatch = xml.match(/<title>([^<]+)<\/title>/);
      const channelTitle = channelTitleMatch
        ? channelTitleMatch[1].replace(" - YouTube", "")
        : "チャンネル";

      const entries = xml.split("<entry>").slice(1);
      const videos = entries
        .map((entry) => {
          const idMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
          const titleMatch = entry.match(/<title>([^<]+)<\/title>/);
          const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
          const videoId = idMatch ? idMatch[1] : null;
          const title = titleMatch ? titleMatch[1] : "タイトルなし";
          if (!videoId) return null;
          return {
            videoId,
            title,
            author: channelTitle,
            authorId: channelId,
            authorAvatar: "",
            viewCount: 0,
            publishedText: publishedMatch
              ? new Date(publishedMatch[1]).toLocaleDateString("ja-JP")
              : "",
            lengthSeconds: 0,
            videoThumbnails: [
              {
                url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                width: 480,
                height: 360,
              },
            ],
            type: "video",
          };
        })
        .filter(Boolean);

      const shorts = videos.filter(
        (v: any) => v && v.title && v.title.toLowerCase().includes("short"),
      );
      return {
        id: channelId,
        title: channelTitle,
        description: "",
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(channelTitle)}&background=random`,
        banner: "",
        subCountText: "",
        videosCountText: `${videos.length} 本の動画`,
        featuredVideo: videos[0] || null,
        videos: videos,
        shortVideos: shorts,
        playlists: [],
      };
    }
  } catch (e) {
    // RSS failed
  }
  return null;
}

function parseCount(input?: any): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === "number") {
    return isNaN(input) ? 0 : Math.floor(input);
  }

  let str = "";
  if (typeof input === "string") {
    str = input;
  } else if (typeof input === "object") {
    str =
      input.text ||
      input.simpleText ||
      input.runs?.[0]?.text ||
      (typeof input.toString === "function" ? input.toString() : "");
  }

  if (!str || typeof str !== "string") return 0;
  if (str === "[object Object]") return 0;

  const clean = str.replace(/,/g, "").trim().toLowerCase();
  if (!clean) return 0;

  // "回視聴", "views", "view", "視聴", "人" などを含む部分の数値を優先抽出
  const viewPattern =
    /([\d.]+\s*(?:億|万|k|m|b)?)\s*(?:回視聴|views|view|回|人|人が視聴中)/i;
  const viewMatch = clean.match(viewPattern);

  let targetStr = clean;
  if (viewMatch && viewMatch[1]) {
    targetStr = viewMatch[1].trim();
  } else {
    const simplePattern = /([\d.]+\s*(?:億|万|k|m|b)?)/i;
    const simpleMatch = clean.match(simplePattern);
    if (simpleMatch && simpleMatch[1]) {
      targetStr = simpleMatch[1].trim();
    }
  }

  let multiplier = 1;
  if (targetStr.includes("億")) {
    multiplier = 100000000;
    targetStr = targetStr.replace("億", "");
  } else if (targetStr.includes("万")) {
    multiplier = 10000;
    targetStr = targetStr.replace("万", "");
  } else if (targetStr.includes("b")) {
    multiplier = 1000000000;
    targetStr = targetStr.replace("b", "");
  } else if (targetStr.includes("m")) {
    multiplier = 1000000;
    targetStr = targetStr.replace("m", "");
  } else if (targetStr.includes("k")) {
    multiplier = 1000;
    targetStr = targetStr.replace("k", "");
  }

  const numStr = targetStr.replace(/[^0-9.]/g, "");
  if (!numStr) return 0;
  const num = parseFloat(numStr);
  if (isNaN(num)) return 0;

  return Math.floor(num * multiplier);
}

function extractViewCount(v: any): number {
  if (!v) return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : Math.floor(v);
  if (typeof v === "string") return parseCount(v);

  const candidates = [
    v.view_count,
    v.short_view_count,
    v.views,
    v.viewCount,
    v.video_info?.view_count,
    v.metadata?.view_count,
    v.overlay_metadata?.secondary_text,
  ];

  for (const cand of candidates) {
    if (cand !== undefined && cand !== null) {
      const parsed = parseCount(cand);
      if (parsed > 0) return parsed;
    }
  }

  if (v.metadata?.metadata?.metadata_rows) {
    for (const row of v.metadata.metadata.metadata_rows) {
      for (const part of row?.metadata_parts || []) {
        const txt = part?.text?.text || part?.text;
        if (
          txt &&
          typeof txt === "string" &&
          (txt.includes("視聴") ||
            txt.includes("views") ||
            txt.includes("view"))
        ) {
          const parsed = parseCount(txt);
          if (parsed > 0) return parsed;
        }
      }
    }
  }

  return 0;
}

const getGithubHeaders = () => ({
  Authorization: `token ${process.env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github.v3+json",
});

const encryptData = (data: any) => {
  const secret =
    process.env.ENCRYPTION_KEY ||
    "default_secret_key_needs_to_be_32_bytes_long".substring(0, 32);
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(JSON.stringify(data), "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return { iv: iv.toString("hex"), authTag, encrypted };
};

const decryptData = (encryptedData: any) => {
  const secret =
    process.env.ENCRYPTION_KEY ||
    "default_secret_key_needs_to_be_32_bytes_long".substring(0, 32);
  const key = crypto.createHash("sha256").update(secret).digest();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encryptedData.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(encryptedData.authTag, "hex"));
  let decrypted = decipher.update(encryptedData.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
};

async function startServer() {
  const app = express();

  // The account Worker validates the session before access to site APIs and streams.
  app.use(async (req, res, next) => {
    if (!/^\/(api|stream|360|edu|scratch-edu)(?:\/|$)/.test(req.path)) return next();
    try {
      const session = await fetch(new URL('/api/account/session', process.env.ACCOUNT_API_URL).href, {
        headers: { cookie: req.headers.cookie || '' }, signal: AbortSignal.timeout(5000)
      });
      if (session.status === 401) return res.status(401).json({ error: 'ログインが必要です。' });
      if (!session.ok) return res.status(503).json({ error: '認証サービスに接続できません。' });
      const account = await session.json() as { user?: { id?: string } };
      if (!account.user?.id) return res.status(401).json({ error: 'ログインが必要です。' });
      res.locals.siteAccountId = account.user.id;
      return next();
    } catch {
      return res.status(503).json({ error: '認証サービスに接続できません。' });
    }
  });

  // --- Bot & Aggressive Crawler Protection (Save Vercel Serverless CPU time) ---
  app.use((req, res, next) => {
    const userAgent = (req.headers["user-agent"] || "").toLowerCase();
    const isBot = /gptbot|chatgpt|ccbot|bytespider|claudebot|anthropic|amazonbot|facebookbot|semrush|ahrefs|dotbot|yandexbot|petalbot|dataforseo/i.test(userAgent);
    
    if (isBot && (req.path.startsWith("/api/") || req.path.startsWith("/stream") || req.path.startsWith("/edu") || req.path.startsWith("/360"))) {
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.status(403).json({ error: "Automated API access is not allowed." });
    }
    next();
  });

  // --- Daily Quotas & Rate Limiting System (Protect Vercel Serverless CPU & Bandwidth) ---
  const DAILY_VIDEO_LIMIT = Math.max(1, parseInt(process.env.DAILY_VIDEO_LIMIT || "15", 10));
  const DAILY_SEARCH_LIMIT = Math.max(1, parseInt(process.env.DAILY_SEARCH_LIMIT || "100", 10));
  const DAILY_TOTAL_LIMIT = 0; // Total requests are unlimited; retain usage counting.
  const BURST_LIMIT_PER_MINUTE = Math.max(1, parseInt(process.env.BURST_LIMIT_PER_MINUTE || "80", 10));
  const USAGE_SECRET = process.env.LIMIT_SECRET || "xerox-daily-limit-secret-salt-2026";

  interface ClientDailyRecord {
    videos: number;
    searches: number;
    total: number;
    burstCount: number;
    burstWindowStart: number;
    lastSeen: number;
  }

  const dailyQuotaMap = new Map<string, ClientDailyRecord>();

  // JST 日付 (UTC+9) の "YYYY-MM-DD"
  function getJstDateString(d = new Date()): string {
    const jstTime = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return jstTime.toISOString().slice(0, 10);
  }

  // JST 午前0時までの残り秒数
  function getSecondsUntilJstMidnight(): number {
    const now = new Date();
    const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const jstTomorrow = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate() + 1));
    const nextResetUtc = new Date(jstTomorrow.getTime() - 9 * 60 * 60 * 1000);
    return Math.max(1, Math.floor((nextResetUtc.getTime() - now.getTime()) / 1000));
  }

  // JST 次回リセット時刻 (ISO文字列)
  function getNextJstMidnightIso(): string {
    const now = new Date();
    const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const jstTomorrow = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate() + 1));
    const nextResetUtc = new Date(jstTomorrow.getTime() - 9 * 60 * 60 * 1000);
    return nextResetUtc.toISOString();
  }

  // クライアント識別子の抽出 (ブラウザUUIDを最優先し、IP変更に左右されない安定識別子)
  function getClientIdentifier(req: express.Request): string {
    const clientHeader = (req.headers["x-client-id"] as string) || "";
    if (clientHeader && /^[a-zA-Z0-9_-]{6,64}$/.test(clientHeader)) {
      return clientHeader;
    }
    const forwardedFor = (req.headers["x-forwarded-for"] as string) || "";
    const vercelIp = (req.headers["x-vercel-ip"] as string) || (req.headers["x-real-ip"] as string) || "";
    const ip = vercelIp || forwardedFor.split(",")[0].trim() || req.socket.remoteAddress || "unknown-ip";
    return ip;
  }

  // HMAC 署名トークン (サーバーレス環境でインスタンス再起動時も引き継ぎ可能)
  function signUsage(clientId: string, day: string, videos: number, searches: number, total: number): string {
    const payload = `${clientId}|${day}|${videos}|${searches}|${total}`;
    const sig = crypto.createHmac("sha256", USAGE_SECRET).update(payload).digest("hex").slice(0, 16);
    return `${payload}|${sig}`;
  }

  function parseUsageToken(token: string): { clientId: string; day: string; videos: number; searches: number; total: number } | null {
    if (!token) return null;
    const parts = token.split("|");
    if (parts.length !== 6) return null;
    const [clientId, day, videosStr, searchesStr, totalStr, sig] = parts;
    const payload = `${clientId}|${day}|${videosStr}|${searchesStr}|${totalStr}`;
    const expectedSig = crypto.createHmac("sha256", USAGE_SECRET).update(payload).digest("hex").slice(0, 16);
    if (sig !== expectedSig) return null;
    return {
      clientId,
      day,
      videos: parseInt(videosStr, 10) || 0,
      searches: parseInt(searchesStr, 10) || 0,
      total: parseInt(totalStr, 10) || 0,
    };
  }

  // レコード取得 & トークンマージ
  function getOrCreateRecord(clientId: string, today: string, req: express.Request): ClientDailyRecord {
    const key = `${clientId}:${today}`;
    let record = dailyQuotaMap.get(key);
    const now = Date.now();

    if (!record) {
      record = {
        videos: 0,
        searches: 0,
        total: 0,
        burstCount: 0,
        burstWindowStart: now,
        lastSeen: now,
      };
      dailyQuotaMap.set(key, record);
    }

    // 1. クライアント署名トークンから復元
    const clientToken = (req.headers["x-usage-token"] as string) || "";
    if (clientToken) {
      const parsed = parseUsageToken(clientToken);
      if (parsed && parsed.day === today && parsed.clientId === clientId) {
        record.videos = Math.max(record.videos, parsed.videos);
        record.searches = Math.max(record.searches, parsed.searches);
        record.total = Math.max(record.total, parsed.total);
      }
    }

    // 2. クライアントのローカル記録からも同期（インスタンス冷起動・再読み込み対策）
    const clientUsageHeader = (req.headers["x-client-usage"] as string) || "";
    if (clientUsageHeader) {
      const [uDay, uVid, uSearch, uTot] = clientUsageHeader.split("|");
      if (uDay === today) {
        record.videos = Math.max(record.videos, parseInt(uVid, 10) || 0);
        record.searches = Math.max(record.searches, parseInt(uSearch, 10) || 0);
        record.total = Math.max(record.total, parseInt(uTot, 10) || 0);
      }
    }

    record.lastSeen = now;
    return record;
  }

  // 日付の変わった古いレコードの自動破棄 (10分ごと)
  setInterval(() => {
    const today = getJstDateString();
    for (const key of dailyQuotaMap.keys()) {
      if (!key.endsWith(`:${today}`)) {
        dailyQuotaMap.delete(key);
      }
    }
  }, 10 * 60 * 1000).unref?.();

  // 利用制限・ステータス確認エンドポイント
  app.get(["/api/limits", "/api/usage"], (req, res) => {
    const clientId = getClientIdentifier(req);
    const today = getJstDateString();
    const record = getOrCreateRecord(clientId, today, req);
    const isVideoLimited = record.videos >= DAILY_VIDEO_LIMIT;
    const isSearchLimited = record.searches >= DAILY_SEARCH_LIMIT;
    const isTotalLimited = false;

    const token = signUsage(clientId, today, record.videos, record.searches, record.total);
    res.setHeader("X-Daily-Usage-Token", token);
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-RateLimit-Videos-Remaining, X-RateLimit-Searches-Remaining, X-RateLimit-Reset-Seconds, X-Daily-Usage-Token"
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    return res.json({
      token,
      videos: {
        used: record.videos,
        limit: DAILY_VIDEO_LIMIT,
        remaining: Math.max(0, DAILY_VIDEO_LIMIT - record.videos),
      },
      searches: {
        used: record.searches,
        limit: DAILY_SEARCH_LIMIT,
        remaining: Math.max(0, DAILY_SEARCH_LIMIT - record.searches),
      },
      total: {
        used: record.total,
        limit: DAILY_TOTAL_LIMIT,
        remaining: null,
      },
      resetAt: getNextJstMidnightIso(),
      resetSeconds: getSecondsUntilJstMidnight(),
      isLimited: isVideoLimited || isSearchLimited || isTotalLimited,
      limitedType: isVideoLimited ? "video" : isSearchLimited ? "search" : isTotalLimited ? "total" : null,
    });
  });

  // リセットエンドポイント (開発テスト用)
  app.post("/api/limits/reset", (req, res) => {
    const clientId = getClientIdentifier(req);
    const today = getJstDateString();
    dailyQuotaMap.delete(`${clientId}:${today}`);
    const token = signUsage(clientId, today, 0, 0, 0);
    res.setHeader("X-Daily-Usage-Token", token);
    return res.json({ success: true, message: "Limits reset successfully for client" });
  });

  // --- Daily Quotas & Rate Limiting Enforcement Middleware ---
  app.use((req, res, next) => {
    const p = req.path;
    // 静的ファイルや除外エンドポイントはスルー
    if (
      !p.startsWith("/api/") &&
      !p.startsWith("/stream") &&
      !p.startsWith("/edu") &&
      !p.startsWith("/360") &&
      !p.startsWith("/scratch-edu")
    ) {
      return next();
    }

    if (
      p === "/api/limits" ||
      p === "/api/usage" ||
      p === "/api/health" ||
      p === "/api/edukey" ||
      p === "/api/limits/reset"
    ) {
      return next();
    }

    const clientId = getClientIdentifier(req);
    const today = getJstDateString();
    const record = getOrCreateRecord(clientId, today, req);
    const now = Date.now();

    // 1. バースト保護 (短時間のアクセス集中を防止: 1分間)
    if (now - record.burstWindowStart > 60000) {
      record.burstCount = 0;
      record.burstWindowStart = now;
    }
    record.burstCount++;
    if (record.burstCount > BURST_LIMIT_PER_MINUTE) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({
        error: "短時間のアクセスが集中しています。サーバー負荷保護のため、1分ほど待ってから再試行してください。",
        code: "BURST_LIMIT_EXCEEDED",
        type: "burst",
        retryAfter: 60,
      });
    }

    // 3. 動画視聴リクエスト判定 (/api/video/:id, /stream/*, /edu/*, etc.)
    const isVideoViewRequest = (
      (p.startsWith("/api/video/") && !p.includes("/comments") && !p.includes("/related")) ||
      p.startsWith("/stream/") ||
      p.startsWith("/api/stream/") ||
      p.startsWith("/360/") ||
      p.startsWith("/api/360/") ||
      p.startsWith("/edu/") ||
      p.startsWith("/api/edu/") ||
      p.startsWith("/scratch-edu/") ||
      p.startsWith("/api/scratch-edu/")
    );

    if (isVideoViewRequest) {
      // Count usage without replacing metadata or related videos with placeholders.
      record.videos++;
    }

    // 4. 検索リクエスト判定 (/api/search, /api/search/channels)
    const isSearchRequest = p === "/api/search" || p === "/api/search/channels";
    if (isSearchRequest) {
      if (record.searches >= DAILY_SEARCH_LIMIT) {
        res.setHeader("Retry-After", String(getSecondsUntilJstMidnight()));
        return res.status(429).json({
          error: `本日の検索リクエスト上限（${DAILY_SEARCH_LIMIT}回）に達しました。Vercelサーバー負荷保護のため、明日午前0時(JST)のリセットまでお待ちください。`,
          code: "DAILY_SEARCH_LIMIT_EXCEEDED",
          type: "search",
          limit: DAILY_SEARCH_LIMIT,
          used: record.searches,
          remaining: 0,
          resetAt: getNextJstMidnightIso(),
          resetSeconds: getSecondsUntilJstMidnight(),
        });
      }
      record.searches++;
    }

    // 総リクエスト数をインクリメント
    record.total++;

    // レスポンスヘッダーに残り利用枠と署名トークンを付与
    const token = signUsage(clientId, today, record.videos, record.searches, record.total);
    res.setHeader("X-RateLimit-Videos-Remaining", String(Math.max(0, DAILY_VIDEO_LIMIT - record.videos)));
    res.setHeader("X-RateLimit-Searches-Remaining", String(Math.max(0, DAILY_SEARCH_LIMIT - record.searches)));
    res.setHeader("X-RateLimit-Reset-Seconds", String(getSecondsUntilJstMidnight()));
    res.setHeader("X-Daily-Usage-Token", token);
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-RateLimit-Videos-Remaining, X-RateLimit-Searches-Remaining, X-RateLimit-Reset-Seconds, X-Daily-Usage-Token, X-Player-Only-Mode"
    );

    next();
  });

  // --- In-Memory API Response Cache Helper ---
  interface CacheEntry {
    data: any;
    expires: number;
  }
  const memoryCache = new Map<string, CacheEntry>();

  function getFromMemoryCache<T>(key: string): T | null {
    const item = memoryCache.get(key);
    if (item && item.expires > Date.now()) {
      return item.data as T;
    }
    return null;
  }

  function setToMemoryCache(key: string, data: any, ttlMs: number = 15 * 60 * 1000) {
    memoryCache.set(key, { data, expires: Date.now() + ttlMs });
    if (memoryCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of memoryCache.entries()) {
        if (v.expires <= now) memoryCache.delete(k);
      }
    }
  }

  // --- /stream/:videoId (/360/:videoId) & /edu/:id (/scratch-edu/:id) Endpoints ---
  const streamCache = new Map<string, { url: string; expires: number }>();

  // メモリキャッシュの定期クリーンアップ (5分毎)
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of streamCache.entries()) {
      if (v.expires <= now) streamCache.delete(k);
    }
    for (const [k, v] of memoryCache.entries()) {
      if (v.expires <= now) memoryCache.delete(k);
    }
  }, 5 * 60 * 1000);

  const handleStreamRequest = async (req: express.Request, res: express.Response) => {
    try {
      const videoId = req.params.videoId || req.params.id;
      if (!videoId) return res.status(400).send("Video ID is required");

      const now = Date.now();
      const cached = streamCache.get(videoId);
      if (cached && cached.expires > now) {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.send(cached.url);
      }

      const apiUrl = `https://getlate.dev/api/tools/youtube-live-downloader?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv=${videoId}&formatId=2`;
      
      const response = await fetch(apiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        redirect: "follow"
      });

      if (!response.ok) {
        return res.status(500).send("Error fetching stream URL");
      }

      const finalUrl = response.url;
      streamCache.set(videoId, { url: finalUrl, expires: now + 60000 });

      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.send(finalUrl);
    } catch (err) {
      console.error("Stream API Error:", err);
      res.status(500).send("Internal Server Error");
    }
  };

  app.get(["/stream/:videoId", "/360/:videoId", "/api/stream/:videoId", "/api/360/:videoId"], handleStreamRequest);

  let cachedEduConfig: { params: string; expires: number } = {
    params: "?rel=0&autoplay=1",
    expires: 0,
  };

  const handleEduRequest = async (req: express.Request, res: express.Response) => {
    try {
      const id = req.params.id || req.params.videoId;
      if (!id) return res.status(400).send("ID is required");

      const now = Date.now();
      let params = cachedEduConfig.params;

      // 15分間メモリキャッシュしてGitHubへの無駄な毎アクセスを防止
      if (now > cachedEduConfig.expires) {
        try {
          const confRes = await fetch("https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json", {
            headers: { "Accept": "text/plain, application/json, */*" }
          });
          if (confRes.ok) {
            const rawText = await confRes.text();
            let clean = rawText.replace(/&amp;/g, '&').trim();
            if (clean.startsWith('{')) {
              try {
                const config = JSON.parse(clean);
                if (config && typeof config.params === "string") {
                  clean = config.params.replace(/&amp;/g, '&').trim();
                }
              } catch {}
            }
            const qIdx = clean.indexOf('?');
            if (qIdx !== -1) {
              clean = clean.substring(qIdx);
            } else if (clean && !clean.startsWith('&')) {
              clean = '?' + clean;
            }
            if (clean) {
              params = clean;
              cachedEduConfig = {
                params,
                expires: now + 15 * 60 * 1000,
              };
            }
          }
        } catch (e) {
          console.warn("Failed to fetch fresh edu config from Wista API, using fallback:", e);
        }
      }

      const eduUrl = `https://www.youtubeeducation.com/embed/${id}${params}`;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.send(eduUrl);
    } catch (err) {
      console.error("Edu API Error:", err);
      res.status(500).send("Internal Server Error");
    }
  };

  app.get(["/edu/:id", "/scratch-edu/:id", "/api/edu/:id", "/api/scratch-edu/:id"], handleEduRequest);


  const PORT = 3000;

  app.use(express.json({ limit: "10mb" }));

  // The legacy credential-id-only sync did not verify identity.
  app.post(["/api/sync/save", "/api/sync/load"], (_req, res) => res.status(410).json({ error: "Legacy sync disabled" }));

  // Request logger
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  // Health Check
  app.get("/api/health", (req, res) => {
    res.setHeader("Cache-Control", "public, s-maxage=60, max-age=60");
    return res.json({
      status: "ok",
      yt_initialized: !!yt,
      timestamp: new Date().toISOString(),
      node_version: process.version,
    });
  });

  // Debug API: Raw Search
  app.get("/api/debug/search", async (req, res) => {
    const q = (req.query.q as string) || "";
    try {
      const youtube = await getYt();
      const search = await youtube.search(q);
      res.json(search);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "サーバー内部エラー" });
    }
  });

  // Debug API: Raw Video Info
  app.get("/api/debug/video", async (req, res) => {
    const id = (req.query.id as string) || "";
    try {
      const youtube = await getYt();
      let info;
      try {
        info = await youtube.getInfo(id);
      } catch (e) {
        info = await youtube.getBasicInfo(id);
      }
      res.json(info);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "サーバー内部エラー" });
    }
  });

  // YouTubei.js Login API
  const authFlows = new Map<string, { flow: any; expires: number }>();

  registerYouTubeAccount(app, {
    store: authFlows, secret: process.env.API_SHARED_SECRET, createPublicClient: getYt,
    createClient: () => { Log.setLevel(Log.Level.NONE); return Innertube.create({ client_type: ClientType.TV, location: "JP", lang: "ja", retrieve_player: false, cache: new UniversalCache(false) }); },
    formatVideo: formatVideoObject, formatChannel: formatSearchChannel,
    Search: YT.Search, Feed: Mixins.Feed, ContinuationItem: YTNodes.ContinuationItem,
  });

  registerRankingRoute(app);
  registerShortsRoutes(app, getYt);

  // トレンド動画取得
  app.get("/api/trending", async (req, res) => {
    try {
      const cached = getFromMemoryCache<any[]>("trending:jp");
      if (cached && cached.length > 0) {
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.json(cached);
      }

      const youtube = await getYt();
      // 日本の人気動画を検索
      const search = await youtube.search("日本 トレンド 人気動画 2026", {
        type: "video",
      });

      const rawVideos = search.videos || [];
      const videos = rawVideos
        .filter((v: any) => !isUnwantedVideo(v))
        .map((v: any) => formatVideoObject(v));

      if (videos.length > 0) {
        setToMemoryCache("trending:jp", videos, 30 * 60 * 1000);
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.json(videos);
      }
      res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
      res.json([]);
    } catch (err) {
      console.error("Trending API error:", err);
      res.json([]);
    }
  });

  function isUnwantedVideo(v: any) {
    if (!v) return true;
    if(playlistCard(v))return false;
    const videoId = v.id || v.videoId || v.content_id || "";
    if (videoId === "dQw4w9WgXcQ" || videoId.includes("dQw4w9WgXcQ"))
      return true;

    const title = (v.title?.text || v.title || "").toLowerCase();
    const author = (v.author?.name || v.author || "").toLowerCase();
    const text = title + " " + author;

    // 特定の取得ミス動画・Rick Astleyの除外
    if (
      text.includes("never gonna give you up") ||
      text.includes("rick astley")
    ) {
      return true;
    }

    // 除外ワード (メドレーや作業用BGMをより強力に排除)
    const unwanted = [
      "メドレー",
      "medley",
      "作業用",
      "bgm",
      "mix",
      "ミックス",
      "詰め合わせ",
      "中国語",
      "中文",
      "華語",
      "台湾",
      "香港",
      "taiwan",
      "china",
      "chinese",
      "睡眠用",
      "勉強用",
      "リラックス",
      "healing",
      "relaxing",
      "study music",
      "フルメドレー",
      "full medley",
      "bgm用",
    ];

    return unwanted.some((kw) => text.includes(kw));
  }

  function isMetadataNotAuthor(text: string): boolean {
    if (!text || typeof text !== "string") return true;
    const t = text.trim().toLowerCase();
    if (!t) return true;
    if (
      t.includes("回視聴") ||
      t.includes("視聴") ||
      t.includes("views") ||
      t.includes("view") ||
      t.includes("前") ||
      t.includes("ago") ||
      t.includes("時間") ||
      t.includes("分") ||
      t.includes("日") ||
      t.includes("秒") ||
      t.includes("週") ||
      t.includes("月") ||
      t.includes("年") ||
      t.includes("公開") ||
      t.includes("配信") ||
      t.includes("生放送") ||
      t.includes("チャンネル登録者") ||
      t.includes("subscribers") ||
      /^\d+[\d,.\s]*(k|m|b|万|千|億)?/i.test(t)
    ) {
      return true;
    }
    return false;
  }

  function isValidChannelId(id?: string): boolean {
    return Boolean(
      id &&
      typeof id === "string" &&
      id.startsWith("UC") &&
      id.length >= 10
    );
  }

  function isValidAuthorName(name?: string): boolean {
    if (!name || typeof name !== "string") return false;
    const t = name.trim();
    if (t.length === 0) return false;
    if (
      t === "チャンネル" ||
      t === "Unknown" ||
      t === "Channel" ||
      t === "User" ||
      t === "undefined" ||
      t === "null"
    ) {
      return false;
    }
    if (isMetadataNotAuthor(t)) return false;
    return true;
  }

  function safeSetBatchChannelCache(
    key: string,
    info: { author: string; authorAvatar: string; authorId?: string }
  ) {
    if (!key || !info) return;
    if (!isValidAuthorName(key) && !isValidChannelId(key)) return;
    // 名前をキーにする場合は、必ず有効なUCチャンネルIDかアバターが存在する場合のみキャッシュ
    if (!isValidChannelId(key) && !isValidChannelId(info.authorId)) return;
    batchChannelCache.set(key, info);
  }

  // 複数チャンネル・コラボレーション動画からメインチャンネルの情報（アイコン・ID・名前）を抽出
  function extractCollabMainChannel(
    v: any,
  ): { name?: string; id?: string; avatar?: string } | null {
    if (!v) return null;
    try {
      const epCandidates = [
        v.author?.endpoint,
        v.author?.navigation_endpoint,
        v.owner?.endpoint,
        v.owner?.navigation_endpoint,
        v.short_byline?.endpoint,
        v.byline?.endpoint,
        v.navigation_endpoint,
        v.endpoint,
      ];

      for (const ep of epCandidates) {
        if (!ep) continue;
        const cmd =
          ep.command ||
          ep.payload?.command ||
          ep.show_dialog_command ||
          ep.payload?.show_dialog_command ||
          ep.showDialogCommand ||
          ep;
        const dialog =
          cmd.inline_content ||
          cmd.payload?.inline_content ||
          cmd.inlineContent ||
          cmd;
        const custom = dialog.custom_content || dialog.customContent || dialog;
        const items = custom.items || custom.contents;
        if (Array.isArray(items) && items.length > 0) {
          for (const main of items) {
            const id =
              main.endpoint?.payload?.browseId ||
              main.title?.endpoint?.payload?.browseId ||
              main.renderer_context?.command_context?.on_tap?.payload?.browseId ||
              main.renderer_context?.command_context?.on_tap?.innertubeCommand
                ?.browseEndpoint?.browseId ||
              main.command_context?.on_tap?.payload?.browseId;
            const name =
              main.title?.text ||
              main.title?.runs?.[0]?.text ||
              (typeof main.title === "string" ? main.title : undefined);
            const avatar =
              main.leading_accessory?.image?.[0]?.url ||
              main.leading_accessory?.avatarViewModel?.image?.sources?.[0]?.url ||
              main.leadingAccessory?.avatarViewModel?.image?.sources?.[0]?.url ||
              main.leading_accessory?.thumbnails?.[0]?.url ||
              main.thumbnail?.thumbnails?.[0]?.url;

            if (isValidChannelId(id) && isValidAuthorName(name)) {
              return {
                name: name?.trim(),
                id: id?.trim(),
                avatar: avatar?.startsWith("//") ? "https:" + avatar : avatar,
              };
            }
          }
        }
      }
    } catch {}
    return null;
  }

  // 安全で正確な動画オブジェクト正規化関数
  function formatVideoObject(
    v: any,
    defaultAuthor: string = "",
    channelId?: string,
  ) {
    if (!v) return null;
    const list=playlistCard(v);if(list)return list;
    if (isUnwantedVideo(v)) return null;

    if (v.type === "ShortsLockupView" || v.type === "ReelItem" || v.content_type === "SHORT") {
      return normalizeShort(v);
    }

    if (v.type === "LockupView") {
      const titleText =
        v.metadata?.title?.text ||
        (typeof v.metadata?.title === "string"
          ? v.metadata.title
          : "タイトルなし");
      const bottomOverlay = v.content_image?.overlays?.find(
        (o: any) => o.type === "ThumbnailBottomOverlayView",
      );
      const timeBadge = bottomOverlay?.badges?.[0]?.text;
      let lengthSeconds = 0;
      if (timeBadge) {
        const timeParts = timeBadge.split(":").reverse();
        lengthSeconds = timeParts.reduce(
          (acc: number, val: string, idx: number) =>
            acc + parseInt(val) * Math.pow(60, idx),
          0,
        );
      }
      const isLiveBadge = v.content_image?.overlays?.some((o: any) =>
        o.badges?.some((b: any) => b.text?.toLowerCase() === "live"),
      );
      const isLiveStream = Boolean(isLiveBadge || v.is_live);
      const isPremiere = Boolean(
        v.is_premiere ||
        titleText.includes("プレミア公開") ||
        v.badges?.some((b: any) => b.text?.includes("プレミア")),
      );

      let authorCandidate = "";
      let authorIdCandidate = "";
      let viewText = "";
      let publishedText = "";

      const rows = v.metadata?.metadata?.metadata_rows || [];
      for (const row of rows) {
        const parts = row?.metadata_parts || [];
        for (const part of parts) {
          const txt =
            part?.text?.text ||
            (typeof part?.text === "string" ? part.text : "");
          if (!txt) continue;
          if (!authorCandidate && isValidAuthorName(txt)) {
            authorCandidate = txt;
            const bId =
              part?.endpoint?.payload?.browseId ||
              part?.endpoint?.browse_endpoint?.browse_id ||
              part?.on_tap_endpoint?.payload?.browseId;
            if (isValidChannelId(bId)) {
              authorIdCandidate = bId;
            }
          } else if (
            txt.includes("視聴") ||
            txt.includes("views") ||
            /^\d+[\d,.\s]*(k|m|b|万|千|億)?/i.test(txt)
          ) {
            if (!viewText) viewText = txt;
          } else if (
            txt.includes("前") ||
            txt.includes("ago") ||
            txt.includes("配信") ||
            txt.includes("公開")
          ) {
            if (!publishedText) publishedText = txt;
          }
        }
      }

      if (!isValidAuthorName(authorCandidate)) {
        authorCandidate =
          v.short_byline?.text ||
          v.author?.name ||
          (isValidAuthorName(defaultAuthor) ? defaultAuthor : "チャンネル");
      }

      const collabInfo = extractCollabMainChannel(v);
      const cleanAuthorCandidate = (authorCandidate || "")
        .split(/、他|\s*and\s+\d+\s+other/i)[0]
        .trim();

      let finalAuthorId =
        authorIdCandidate ||
        (collabInfo?.id && isValidChannelId(collabInfo.id) ? collabInfo.id : undefined) ||
        (v.metadata?.avatar?.endpoint?.payload?.browseId && isValidChannelId(v.metadata.avatar.endpoint.payload.browseId) ? v.metadata.avatar.endpoint.payload.browseId : undefined) ||
        (v.content_image?.endpoint?.payload?.browseId && isValidChannelId(v.content_image.endpoint.payload.browseId) ? v.content_image.endpoint.payload.browseId : undefined) ||
        (isValidChannelId(channelId) ? channelId : undefined);

      let authorAvatar = "";
      const avatarCandidate =
        collabInfo?.avatar ||
        v.metadata?.avatar?.thumbnails?.[0]?.url ||
        v.metadata?.avatar?.[0]?.url ||
        v.author?.best_thumbnail?.url ||
        v.author?.thumbnails?.[0]?.url ||
        v.content_image?.avatar?.thumbnails?.[0]?.url ||
        v.channel_thumbnail?.url;
      if (avatarCandidate) {
        authorAvatar = avatarCandidate.startsWith("//")
          ? "https:" + avatarCandidate
          : avatarCandidate;
      }

      if (
        !authorAvatar &&
        isValidAuthorName(cleanAuthorCandidate) &&
        batchChannelCache.has(cleanAuthorCandidate)
      ) {
        const cached = batchChannelCache.get(cleanAuthorCandidate)!;
        authorAvatar = cached.authorAvatar;
        if (!finalAuthorId && isValidChannelId(cached.authorId)) {
          finalAuthorId = cached.authorId;
        }
      }

      if (authorAvatar) {
        if (isValidAuthorName(cleanAuthorCandidate) && isValidChannelId(finalAuthorId)) {
          safeSetBatchChannelCache(cleanAuthorCandidate, {
            author: cleanAuthorCandidate,
            authorAvatar,
            authorId: finalAuthorId,
          });
        }
      } else {
        authorAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanAuthorCandidate || authorCandidate)}&background=random&color=fff&size=128`;
      }

      const calculatedViews = extractViewCount(v) || parseCount(viewText) || 0;

      return {
        videoId: v.content_id,
        playlistId: undefined,
        type: "video",
        title: titleText,
        author: authorCandidate,
        authorId: finalAuthorId,
        authorAvatar: authorAvatar,
        viewCount: calculatedViews,
        publishedText: publishedText,
        lengthSeconds: lengthSeconds,
        videoThumbnails: v.content_image?.image || [
          {
            url: `https://i.ytimg.com/vi/${v.content_id}/hqdefault.jpg`,
            width: 480,
            height: 360,
          },
        ],
        isLive: isLiveStream && !isPremiere,
        isPremiere: isPremiere,
        liveViewerCount:
          isLiveStream && !isPremiere ? calculatedViews : undefined,
      };
    }

    const isPlaylist =
      v.type === "Playlist" || v.type === "Mix" || v.type === "CompactPlaylist";
    const videoId = isPlaylist
      ? v.first_video_id || undefined
      : v.id || v.videoId;
    const playlistId = isPlaylist
      ? v.id || v.playlistId
      : v.playlistId || undefined;

    if (!videoId && !playlistId) return null;

    const thumbnails = v.thumbnails || v.videoThumbnails || v.thumbnail || [];
    const title =
      v.title?.text ||
      (typeof v.title === "string" ? v.title : "") ||
      "タイトルなし";

    // チャンネル名とIDのあらゆる構造からの確実な抽出
    let authorName = "";
    if (v.author) {
      if (typeof v.author === "string") {
        authorName = v.author;
      } else if (typeof v.author.name === "string") {
        authorName = v.author.name;
      } else if (typeof v.author.text === "string") {
        authorName = v.author.text;
      }
    }
    if (!isValidAuthorName(authorName)) {
      const candidates = [
        v.short_byline?.text,
        v.short_byline?.runs?.[0]?.text,
        v.long_byline?.text,
        v.long_byline?.runs?.[0]?.text,
        v.owner?.title?.text,
        v.owner?.title?.runs?.[0]?.text,
        v.channel?.name,
        v.channel?.title,
        v.byline?.text,
        v.uploader_name,
        v.uploader,
        defaultAuthor,
      ];
      for (const cand of candidates) {
        if (isValidAuthorName(cand)) {
          authorName = cand.trim();
          break;
        }
      }
    }
    if (!isValidAuthorName(authorName)) {
      authorName = isValidAuthorName(defaultAuthor) ? defaultAuthor : "チャンネル";
    }

    const collabInfo = extractCollabMainChannel(v);
    const cleanAuthor = (authorName || "")
      .split(/、他|\s*and\s+\d+\s+other/i)[0]
      .trim();

    let finalAuthorId =
      (v.author?.id && isValidChannelId(v.author.id) ? v.author.id : undefined) ||
      (v.author?.endpoint?.browse_endpoint?.browse_id && isValidChannelId(v.author.endpoint.browse_endpoint.browse_id) ? v.author.endpoint.browse_endpoint.browse_id : undefined) ||
      (v.author?.endpoint?.payload?.browseId && isValidChannelId(v.author.endpoint.payload.browseId) ? v.author.endpoint.payload.browseId : undefined) ||
      (v.channel?.id && isValidChannelId(v.channel.id) ? v.channel.id : undefined) ||
      (v.owner?.endpoint?.browse_endpoint?.browse_id && isValidChannelId(v.owner.endpoint.browse_endpoint.browse_id) ? v.owner.endpoint.browse_endpoint.browse_id : undefined) ||
      (v.owner?.endpoint?.payload?.browseId && isValidChannelId(v.owner.endpoint.payload.browseId) ? v.owner.endpoint.payload.browseId : undefined) ||
      (collabInfo?.id && isValidChannelId(collabInfo.id) ? collabInfo.id : undefined) ||
      (isValidChannelId(channelId) ? channelId : undefined);

    if (!finalAuthorId && isValidAuthorName(cleanAuthor) && batchChannelCache.has(cleanAuthor)) {
      const cached = batchChannelCache.get(cleanAuthor);
      if (cached && isValidChannelId(cached.authorId)) {
        finalAuthorId = cached.authorId;
      }
    }

    // アバターURLの多階層探索
    let authorAvatar = "";
    const avatarCandidates = [
      collabInfo?.avatar,
      v.author?.best_thumbnail?.url,
      v.author?.thumbnails?.[v.author?.thumbnails?.length - 1]?.url,
      v.author?.thumbnails?.[0]?.url,
      v.author?.avatar?.[v.author?.avatar?.length - 1]?.url,
      v.author?.avatar?.[0]?.url,
      v.author?.avatar_thumbnail_url,
      v.author_thumbnails?.[0]?.url,
      v.channel_navigation_endpoint?.author?.thumbnails?.[0]?.url,
      v.channel_thumbnail_with_count?.thumbnail?.thumbnails?.[0]?.url,
      v.channel_thumbnail?.thumbnails?.[0]?.url,
      v.channel_thumbnail?.url,
      v.channel_thumbnails?.[0]?.url,
      v.channel_avatar?.url,
      v.owner?.thumbnails?.[v.owner?.thumbnails?.length - 1]?.url,
      v.owner?.thumbnails?.[0]?.url,
      v.owner?.avatar?.[0]?.url,
    ];

    for (const url of avatarCandidates) {
      if (url && typeof url === "string" && url.trim().length > 0) {
        authorAvatar = url.trim();
        break;
      }
    }

    if (!authorAvatar && isValidAuthorName(cleanAuthor) && batchChannelCache.has(cleanAuthor)) {
      const cached = batchChannelCache.get(cleanAuthor);
      if (cached?.authorAvatar) authorAvatar = cached.authorAvatar;
      if (!finalAuthorId && isValidChannelId(cached?.authorId)) {
        finalAuthorId = cached!.authorId;
      }
    }

    if (authorAvatar) {
      if (authorAvatar.startsWith("//")) {
        authorAvatar = "https:" + authorAvatar;
      }
      if (isValidAuthorName(cleanAuthor) && isValidChannelId(finalAuthorId)) {
        safeSetBatchChannelCache(cleanAuthor, {
          author: cleanAuthor,
          authorAvatar: authorAvatar,
          authorId: finalAuthorId,
        });
      }
    } else {
      authorAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanAuthor || authorName)}&background=random&color=fff&size=128`;
    }

    // ライブ判定とプレミア判定（プレミア公開を生配信と誤判定しない）
    const isPremiere = Boolean(
      v.is_premiere ||
      v.badges?.some(
        (b: any) =>
          (b.label || b.text || "").toLowerCase().includes("premiere") ||
          (b.label || b.text || "").includes("プレミア"),
      ) ||
      title.includes("プレミア公開"),
    );

    const isLiveStream = Boolean(
      !isPremiere &&
      (v.is_live === true ||
        v.badges?.some(
          (b: any) =>
            (b.label || b.text || "").toLowerCase() === "live" ||
            (b.label || b.text || "") === "ライブ",
        )),
    );

    const calculatedViews = extractViewCount(v);

    // 実データからの視聴者数
    let realLiveViewers: number | undefined = undefined;
    if (isLiveStream) {
      if (calculatedViews > 0) realLiveViewers = calculatedViews;
    }

    return {
      videoId: videoId,
      playlistId: playlistId,
      type: v.type?.toLowerCase() || (playlistId ? "playlist" : "video"),
      title: title,
      author: authorName,
      authorId: finalAuthorId,
      authorAvatar: authorAvatar,
      viewCount: calculatedViews,
      publishedText:
        v.published?.text || v.publishedText || v.video_count_short?.text || "",
      lengthSeconds: v.duration?.seconds || v.lengthSeconds || 0,
      videoThumbnails:
        thumbnails.length > 0
          ? thumbnails
          : [
              {
                url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                width: 480,
                height: 360,
              },
            ],
      isLive: isLiveStream,
      isPremiere: isPremiere,
      liveViewerCount: realLiveViewers,
    };
  }

  // チャンネルオブジェクトの安全な正規化関数
  function formatSearchChannel(ch: any) {
    if (!ch) return null;
    const id = ch.id || ch.author?.id || ch.endpoint?.payload?.browseId;
    const title = ch.author?.name || ch.title?.text || (typeof ch.title === "string" ? ch.title : "") || ch.name || "";
    if (!id || !title) return null;

    let avatar = "";
    const thumbs = ch.author?.thumbnails || ch.thumbnails;
    if (Array.isArray(thumbs) && thumbs.length > 0) {
      avatar = thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || "";
    }
    if (!avatar && ch.avatar?.url) avatar = ch.avatar.url;
    if (avatar && avatar.startsWith("//")) {
      avatar = "https:" + avatar;
    }
    if (!avatar) {
      avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(title)}&background=random&color=fff&size=128`;
    }

    let subscribers = ch.video_count?.text || ch.subscriber_count?.text || ch.subscribers?.text || "";
    let handle = "";
    if (typeof ch.subscriber_count?.text === "string" && ch.subscriber_count.text.startsWith("@")) {
      handle = ch.subscriber_count.text;
    } else if (typeof ch.author?.endpoint?.payload?.canonicalBaseUrl === "string") {
      handle = ch.author.endpoint.payload.canonicalBaseUrl.replace("/", "");
    }

    let videoCount = "";
    if (typeof ch.video_count?.text === "string" && !ch.video_count.text.includes("チャンネル登録者数")) {
      videoCount = ch.video_count.text;
    }

    const description =
      ch.description_snippet?.text ||
      ch.description?.text ||
      (typeof ch.description === "string" ? ch.description : "") ||
      "";
    const isVerified = Boolean(
      ch.author?.is_verified ||
      ch.badges?.some((b: any) =>
        (b.tooltip || b.label || b.text || "").includes("確認済み")
      )
    );

    return {
      id,
      title,
      handle,
      avatar,
      subscribers,
      videoCount,
      description,
      isVerified,
    };
  }

  // トレンド ＆ パーソナライズドおすすめAPI
  // Use YouTube's Home feed chips rather than a keyword search.
  app.get("/api/home/categories", async (req, res) => {
    try {
      const youtube = await getYt();
      const feed = await youtube.getHomeFeed();
      const categories = (feed.filters || []).filter((name: string) =>
        name && name !== "すべて" && name.toLowerCase() !== "all"
      );
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ categories });
    } catch (error: any) {
      console.error("[Home categories]", error?.message || error);
      return res.status(502).json({ error: "ホームのカテゴリを取得できませんでした。" });
    }
  });

  app.get("/api/home/category", async (req, res) => {
    const category = typeof req.query.name === "string" ? req.query.name.trim() : "";
    const page = Number(req.query.page || 1);
    if (!category || category.length > 100 || !Number.isInteger(page) || page < 1 || page > 8) {
      return res.status(400).json({ error: "カテゴリを確認してください。" });
    }
    try {
      const youtube = await getYt();
      let feed: any;
      try {
        const home = await youtube.getHomeFeed();
        if (home.filters?.includes(category)) feed = await home.applyFilter(category);
      } catch (error: any) {
        console.warn("[Home category filter]", error?.message || error);
      }
      // Some sessions do not receive Home chips. Keep categories usable in that case.
      if (!feed) feed = await youtube.search(category, { type: "video" });
      for (let index = 1; index < page; index++) {
        if (!feed.has_continuation) return res.json({ videos: [], hasMore: false });
        feed = await feed.getContinuation();
      }
      const videos = (feed.videos || []).map((item: any) => formatVideoObject(item)).filter((item: any) => item && item.videoId);
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ videos, hasMore: Boolean(feed.has_continuation) && page < 8 });
    } catch (error: any) {
      console.error("[Home category]", error?.message || error);
      return res.status(502).json({ error: "カテゴリのおすすめを取得できませんでした。" });
    }
  });

  app.get("/api/recommendations", async (req, res) => {
    const keywords = (req.query.keywords as string) || "";
    const historyIds = ((req.query.historyIds as string) || "")
      .split(",")
      .filter((id) => id && id.trim().length > 0);
    const userHashtagsParam = (req.query.userHashtags as string) || "";
    const page = parseInt((req.query.page as string) || "1", 10);
    const clientSeed = parseInt(
      (req.query.seed || req.query.refreshNonce) as string,
      10,
    );
    const seed = Number.isFinite(clientSeed)
      ? clientSeed
      : Date.now() + Math.floor(Math.random() * 100000);

    // ユーザーが見た動画のハッシュタグ頻度マップ（出没回数）
    const hashtagFrequencyMap: Record<string, number> = {};
    if (userHashtagsParam) {
      try {
        const parsed = JSON.parse(userHashtagsParam);
        if (typeof parsed === "object" && parsed !== null) {
          for (const [k, v] of Object.entries(parsed)) {
            const clean = k.replace(/^#/, "").toLowerCase().trim();
            if (clean && typeof v === "number" && v > 0) {
              hashtagFrequencyMap[clean] =
                (hashtagFrequencyMap[clean] || 0) + v;
            }
          }
        }
      } catch {}
    }

    // シード付き疑似乱数生成器
    const getSeedRandom = (offset: number = 0) => {
      const s = (seed + offset * 9301 + 49297) % 233280;
      const x = Math.sin(s) * 10000;
      return x - Math.floor(x);
    };

    try {
      const youtube = await getYt();

      let geminiKeywords: string[] = [];
      let usedAi = false;
      let historyVideoTitles: string[] = [];
      let historyAuthors: string[] = [];

      // 視聴履歴の動画情報を取得 (最大12件に拡張)
      if (historyIds.length > 0) {
        try {
          const sampleHistory = historyIds.slice(0, 12);
          const historyDetails = await Promise.all(
            sampleHistory.map(async (id) => {
              try {
                const info = await youtube.getBasicInfo(id);
                const basic = info.basic_info;
                // タイトルやタグからハッシュタグを抽出して頻度加算
                const title = basic.title || "";
                const hashMatches = (
                  title.match(
                    /#[a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]+/g,
                  ) || []
                ).map((h) => h.replace(/^#/, "").toLowerCase().trim());
                hashMatches.forEach((tag) => {
                  if (tag && tag.length >= 2)
                    hashtagFrequencyMap[tag] =
                      (hashtagFrequencyMap[tag] || 0) + 2;
                });
                if (Array.isArray(basic.keywords)) {
                  basic.keywords.forEach((k: string) => {
                    const tag = k.replace(/^#/, "").toLowerCase().trim();
                    if (tag && tag.length >= 2) {
                      hashtagFrequencyMap[tag] =
                        (hashtagFrequencyMap[tag] || 0) + 1;
                    }
                  });
                }
                return {
                  title: basic.title || "",
                  author: basic.author || "",
                };
              } catch {
                return null;
              }
            }),
          );
          historyVideoTitles = historyDetails
            .filter(Boolean)
            .map((h) => h!.title)
            .filter((t) => t.length > 0);
          historyAuthors = Array.from(
            new Set(
              historyDetails
                .filter(Boolean)
                .map((h) => h!.author)
                .filter((a) => a.length > 0),
            ),
          );
        } catch (e) {
          console.warn("[Recs] Error fetching history details:", e);
        }
      }

      // Recommendation inference runs on the client; no external AI call.

      // 一般ジャンルプール
      const categoryPool = [
        "日本 トレンド 総合 2026",
        "YouTube Music 日本 話題の曲",
        "人気 ゲーム実況 最新",
        "エンタメ 話題 バラエティ",
        "最新 ガジェット レビュー",
        "アニメ 話題 2026",
        "料理 レシピ 簡単 人気",
        "最新 ニュース 解説 注目",
        "お笑い コント 漫才 人気",
      ];

      // 1. History から関連動画 (watch_next_feed) を取得
      let sampledHistoryIds = [];
      if (historyIds.length > 0) {
        const hCopy = [...historyIds];
        for (let i = hCopy.length - 1; i > 0; i--) {
          const j = Math.floor(getSeedRandom(page * 7 + i) * (i + 1));
          [hCopy[i], hCopy[j]] = [hCopy[j], hCopy[i]];
        }
        sampledHistoryIds = hCopy.slice(0, 10);
      }

      let personalizedVideos = [];

      if (sampledHistoryIds.length > 0) {
        const relatedTasks = sampledHistoryIds.map(async (id) => {
          try {
            let info;
            try {
              info = await youtube.getInfo(id);
            } catch (e) {
              info = await youtube.getBasicInfo(id);
            }
            return info.watch_next_feed || [];
          } catch {
            return [];
          }
        });

        const relatedResults = await Promise.all(relatedTasks);
        relatedResults.forEach((vList) => {
          if (vList && Array.isArray(vList)) {
            personalizedVideos.push(...vList);
          }
        });

        // データが足りない場合（例：40件未満）、関連動画のさらに関連動画を取得（ディープフェッチ）
        if (personalizedVideos.length < 40) {
          const fetchedIds = new Set(sampledHistoryIds);
          const candidateDeepIds = personalizedVideos
            .map((v) => v.id || v.videoId || v.content_id)
            .filter((id) => id && !fetchedIds.has(id));

          if (candidateDeepIds.length > 0) {
            // ランダムに数件選ぶ
            for (let i = candidateDeepIds.length - 1; i > 0; i--) {
              const j = Math.floor(getSeedRandom(page * 11 + i) * (i + 1));
              [candidateDeepIds[i], candidateDeepIds[j]] = [
                candidateDeepIds[j],
                candidateDeepIds[i],
              ];
            }
            const deepSample = candidateDeepIds.slice(0, 5);
            const deepRelatedTasks = deepSample.map(async (id) => {
              try {
                let info;
                try {
                  info = await youtube.getInfo(id);
                } catch (e) {
                  info = await youtube.getBasicInfo(id);
                }
                return info.watch_next_feed || [];
              } catch {
                return [];
              }
            });
            const deepRelatedResults = await Promise.all(deepRelatedTasks);
            deepRelatedResults.forEach((vList) => {
              if (vList && Array.isArray(vList)) {
                personalizedVideos.push(...vList);
              }
            });
          }
        }
      }

      // ユーザーが見た動画のハッシュタグ（出没しやすいものの確率を上げて重み付けランダムサンプリング）
      const sampleWeightedHashtags = (
        map: Record<string, number>,
        count: number = 2,
      ): string[] => {
        const entries = Object.entries(map).filter(
          ([tag, score]) => tag && score > 0 && tag.length >= 2,
        );
        if (entries.length === 0) return [];

        const selected: string[] = [];
        const pool = [...entries];

        for (let step = 0; step < count && pool.length > 0; step++) {
          const totalWeight = pool.reduce((acc, [, w]) => acc + w, 0);
          let r = getSeedRandom(page * 71 + step * 23) * totalWeight;
          let pickedIndex = 0;
          for (let i = 0; i < pool.length; i++) {
            r -= pool[i][1];
            if (r <= 0) {
              pickedIndex = i;
              break;
            }
          }
          selected.push(pool[pickedIndex][0]);
          pool.splice(pickedIndex, 1); // 1回選ばれたものは重複しないよう除外
        }
        return selected;
      };

      const selectedHashtags = sampleWeightedHashtags(hashtagFrequencyMap, 2);

      // 一般の検索結果（5%用 または フォールバック用）
      const shuffledCategories = [...categoryPool];
      for (let i = shuffledCategories.length - 1; i > 0; i--) {
        const j = Math.floor(getSeedRandom(page * 13 + i) * (i + 1));
        [shuffledCategories[i], shuffledCategories[j]] = [
          shuffledCategories[j],
          shuffledCategories[i],
        ];
      }

      const generalQueries: string[] = [];
      // ユーザーが見た動画のハッシュタグを確率重み付けで最優先抽出（5%枠）
      if (selectedHashtags.length > 0) {
        selectedHashtags.forEach((tag) => {
          generalQueries.push(`#${tag}`);
          generalQueries.push(`${tag} 人気`);
        });
      }

      // AI検索結果があればそれを追加
      if (usedAi && geminiKeywords.length > 0) {
        generalQueries.push(...geminiKeywords.slice(0, 2));
      }
      generalQueries.push(...shuffledCategories.slice(0, 3));

      const searchTasks = generalQueries
        .slice(0, 4)
        .map((q) =>
          youtube
            .search(q, { type: "video", prioritize: "popularity" })
            .catch(() => null),
        );
      const searchResults = await Promise.all(searchTasks);

      let generalVideos = [];
      searchResults.forEach((r) => {
        if (r && r.videos && Array.isArray(r.videos)) {
          generalVideos.push(...r.videos);
        }
      });

      // フォーマット処理
      let formattedPersonalized = personalizedVideos
        .map((v) => formatVideoObject(v))
        .filter((v) => v && v.videoId && !isUnwantedVideo(v));

      let formattedGeneral = generalVideos
        .map((v) => formatVideoObject(v))
        .filter((v) => v && v.videoId && !isUnwantedVideo(v));

      // 重複排除 (重複した場合は、パーソナライズを優先)
      const uniqueMap = new Map();
      formattedPersonalized.forEach((item) => {
        if (!uniqueMap.has(item.videoId)) uniqueMap.set(item.videoId, item);
      });
      formattedPersonalized = Array.from(uniqueMap.values());

      // 一般動画の重複排除 (パーソナライズに無いもの)
      const uniqueGeneralMap = new Map();
      formattedGeneral.forEach((item) => {
        if (
          !uniqueMap.has(item.videoId) &&
          !uniqueGeneralMap.has(item.videoId)
        ) {
          uniqueGeneralMap.set(item.videoId, item);
        }
      });
      formattedGeneral = Array.from(uniqueGeneralMap.values());

      // 95% パーソナライズ (履歴関連動画), 5% 一般
      const totalRequested = 40;
      let finalVideos = [];

      if (formattedPersonalized.length > 0 || formattedGeneral.length > 0) {
        // パーソナライズをシャッフル
        for (let i = formattedPersonalized.length - 1; i > 0; i--) {
          const j = Math.floor(getSeedRandom(page * 31 + i * 17) * (i + 1));
          [formattedPersonalized[i], formattedPersonalized[j]] = [
            formattedPersonalized[j],
            formattedPersonalized[i],
          ];
        }

        // 一般をシャッフル
        for (let i = formattedGeneral.length - 1; i > 0; i--) {
          const j = Math.floor(getSeedRandom(page * 41 + i * 19) * (i + 1));
          [formattedGeneral[i], formattedGeneral[j]] = [
            formattedGeneral[j],
            formattedGeneral[i],
          ];
        }

        const pCount = Math.floor(totalRequested * 0.95);
        const gCount = totalRequested - pCount;

        const selectedP = formattedPersonalized.slice(
          0,
          Math.max(pCount, totalRequested - formattedGeneral.length),
        );
        const selectedG = formattedGeneral.slice(
          0,
          Math.min(gCount, totalRequested - selectedP.length),
        );

        // 足りなければ general からもっと足す
        if (
          selectedP.length + selectedG.length < totalRequested &&
          formattedGeneral.length > selectedG.length
        ) {
          const remaining =
            totalRequested - (selectedP.length + selectedG.length);
          selectedG.push(
            ...formattedGeneral.slice(
              selectedG.length,
              selectedG.length + remaining,
            ),
          );
        }

        finalVideos = [...selectedP, ...selectedG];

        // 全体をさらにシャッフルしてばらけさせる
        for (let i = finalVideos.length - 1; i > 0; i--) {
          const j = Math.floor(getSeedRandom(page * 51 + i) * (i + 1));
          [finalVideos[i], finalVideos[j]] = [finalVideos[j], finalVideos[i]];
        }

        res.setHeader("Cache-Control", "private, no-store");
        return res.json({
          videos: finalVideos,
          aiKeywords: geminiKeywords,
          seed: seed,
        });
      }

      // フォールバック: デフォルト検索
      const fallbackSearch = await youtube.search("日本 人気動画 2026", {
        type: "video",
      });
      const fallbackVideos = (fallbackSearch.videos || [])
        .map((v: any) => formatVideoObject(v))
        .filter((v: any) => v && v.videoId);

      res.setHeader("Cache-Control", "private, no-store");
      return res.json({
        videos: fallbackVideos,
        aiKeywords: [],
        seed: seed,
      });
    } catch (err) {
      console.error("[Recs] Recommendations API error:", err);
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
      return res.json({ videos: [], aiKeywords: [], seed: seed });
    }
  });

  // YouTube 検索サジェスト API
  app.get("/api/suggestions", async (req, res) => {
    const q = (req.query.q as string) || "";
    if (!q.trim()) {
      return res.json([]);
    }

    const cacheKey = `sug:${q.trim().toLowerCase()}`;
    const cached = getFromMemoryCache<string[]>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, s-maxage=7200, stale-while-revalidate=86400");
      return res.json(cached);
    }

    try {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&oe=utf-8&hl=ja&q=${encodeURIComponent(q.trim())}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
        },
      });
      if (!response.ok) {
        return res.json([]);
      }
      const data = await response.json();
      const suggestions = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
      setToMemoryCache(cacheKey, suggestions, 60 * 60 * 1000);
      res.setHeader("Cache-Control", "public, s-maxage=7200, stale-while-revalidate=86400");
      return res.json(suggestions);
    } catch (err) {
      console.error("[Suggestions] Error fetching suggestions:", err);
      return res.json([]);
    }
  });

  registerFilteredSearch(app, { getYt, formatVideoObject, formatSearchChannel, Search: YT.Search, ContinuationItem: YTNodes.ContinuationItem });

  // チャンネル個別検索専用API
  app.get("/api/search/channels", async (req, res) => {
    const q = (req.query.q as string) || "";
    if (!q.trim()) {
      return res.json([]);
    }

    const cacheKey = `search-channels:${q.toLowerCase().trim()}`;
    const cached = getFromMemoryCache<any[]>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
      return res.json(cached);
    }

    try {
      const youtube = await getYt();
      const channelSearch = await youtube.search(q, { type: "channel" });
      let rawChannels: any[] = [];
      if (channelSearch.channels && channelSearch.channels.length > 0) {
        rawChannels = channelSearch.channels;
      } else if (channelSearch.results && channelSearch.results.length > 0) {
        rawChannels = channelSearch.results.filter(
          (r: any) => r.type === "Channel" || r.type === "ChannelView"
        );
      }

      const channels = rawChannels
        .map((ch: any) => formatSearchChannel(ch))
        .filter((ch) => ch !== null);

      if (channels.length > 0) {
        setToMemoryCache(cacheKey, channels, 15 * 60 * 1000);
      }

      res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
      return res.json(channels);
    } catch (err) {
      console.error("Channels search API error:", err);
      res.json([]);
    }
  });

  // 登録チャンネルフィードAPI (最新動画をまとめて取得 & 無限スクロール対応)
  app.get("/api/subscriptions/feed", async (req, res) => {
    const channelTitles = ((req.query.channels as string) || "")
      .split(",")
      .filter(Boolean);
    const selectedChannel = (req.query.selectedChannel as string) || "all";
    const page = parseInt((req.query.page as string) || "1", 10);
    
    const cacheKey = `subfeed:${selectedChannel}:${page}:${channelTitles.sort().join(",")}`;
    const cached = getFromMemoryCache<any[]>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
      return res.json(cached);
    }

    try {
      const youtube = await getYt();
      let allVideos: any[] = [];

      let targetChannels = channelTitles;
      if (selectedChannel && selectedChannel !== "all") {
        targetChannels = [selectedChannel];
      }

      if (targetChannels.length > 0) {
        // 各登録チャンネルの最新動画をページ別取得
        const promises = targetChannels.map(async (title) => {
          try {
            const searchQuery = page > 1 ? `${title} 最新 ${page}` : `${title}`;
            const searchRes = await youtube.search(searchQuery, {
              type: "video",
            });
            return (searchRes.videos || [])
              .slice(0, 8)
              .map((v: any) => formatVideoObject(v, title));
          } catch {
            return [];
          }
        });

        const results = await Promise.all(promises);
        results.forEach((vList) => {
          allVideos = allVideos.concat(vList);
        });
      }

      // 重複削除
      const uniqueFeed = Array.from(
        new Map(allVideos.map((item) => [item.videoId, item])).values(),
      );
      setToMemoryCache(cacheKey, uniqueFeed, 15 * 60 * 1000);
      res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
      res.json(uniqueFeed);
    } catch (err) {
      console.error("Subscriptions feed API error:", err);
      res.json([]);
    }
  });

  // EduKey 取得 API (scratch-edu からキー部分を取得し1日(24時間)キャッシュ)
  let cachedEduKey: string | null = null;
  let eduKeyFetchTime = 0;
  let lastForceRefreshTime = 0;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const REFRESH_COOLDOWN_MS = 10000; // 10秒の連続リクエスト防止

  app.get("/api/edukey", async (req, res) => {
    const forceRefresh =
      req.query.refresh === "true" || req.query.refresh === "1";
    try {
      const now = Date.now();
      // クールダウン制限: 連続リクエスト時は既存のキャッシュを返す
      if (
        forceRefresh &&
        now - lastForceRefreshTime < REFRESH_COOLDOWN_MS &&
        cachedEduKey
      ) {
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.json({ key: cachedEduKey, rateLimited: true });
      }

      if (!forceRefresh && cachedEduKey && now - eduKeyFetchTime < ONE_DAY_MS) {
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.json({ key: cachedEduKey });
      }

      if (forceRefresh) {
        lastForceRefreshTime = now;
      }

      const resp = await axios.get(
        "https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json",
        {
          timeout: 8000,
          responseType: "text",
        },
      );
      if (resp.data) {
        let clean =
          typeof resp.data === "object"
            ? JSON.stringify(resp.data)
            : String(resp.data).trim();
        clean = clean.replaceAll("&amp;", "&");
        if (clean.startsWith("{")) {
          try {
            const parsed = JSON.parse(clean);
            if (parsed && typeof parsed.params === "string") {
              clean = parsed.params.replaceAll("&amp;", "&").trim();
            }
          } catch {}
        }
        const questionIdx = clean.indexOf("?");
        if (questionIdx !== -1) {
          let queryPart = clean.substring(questionIdx);
          queryPart = queryPart.replace(/["'}\s]+$/, "");
          cachedEduKey = queryPart;
          eduKeyFetchTime = now;
          res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
          return res.json({ key: queryPart });
        }
      }
      throw new Error("Invalid edu key response format");
    } catch (err: any) {
      console.error("Failed to fetch edu key:", err?.message || err);
      const fallbackKey =
        "?embed_config=%7B%22enc%22:%22AXH1ezlF0nNTSu_IsdGAuukXrV75cPjBVoxFG-dXjsrw-s1eUVSVVBCd_4VgfGhJAK-7NvxIWdJturPIcDPEjwkiXafNgHpP4N74VK7H9M2Yvss4wsSXxVTw-uXdhqEx0hfChvidjtCTglHpEb9m9lSX69ewc6ZopVZj5v8eamlb32qO%22%7D&enablejsapi=1&errorlinks=1&origin=https://sites.google.com&vl=1";
      if (!cachedEduKey || forceRefresh) {
        cachedEduKey = fallbackKey;
        eduKeyFetchTime = Date.now();
      }
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.json({ key: cachedEduKey });
    }
  });

  // YouTube Education プレイヤーURL直接取得 API
  app.get("/api/edu/:id", async (req, res) => {
    const videoId = req.params.id;
    const now = Date.now();
    let key = cachedEduKey;

    if (!key || now - eduKeyFetchTime >= ONE_DAY_MS) {
      try {
        const resp = await axios.get(
          "https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json",
          { timeout: 8000, responseType: "text" }
        );
        if (resp.data) {
          let clean = typeof resp.data === "object" ? JSON.stringify(resp.data) : String(resp.data).trim();
          clean = clean.replaceAll("&amp;", "&");
          if (clean.startsWith("{")) {
            try {
              const parsed = JSON.parse(clean);
              if (parsed && typeof parsed.params === "string") {
                clean = parsed.params.replaceAll("&amp;", "&").trim();
              }
            } catch {}
          }
          const questionIdx = clean.indexOf("?");
          if (questionIdx !== -1) {
            let queryPart = clean.substring(questionIdx).replace(/["'}\s]+$/, "");
            cachedEduKey = queryPart;
            eduKeyFetchTime = now;
            key = queryPart;
          }
        }
      } catch (e) {
        console.warn("Edu fallback fetch key failed, using cached/fallback key:", e);
      }
    }

    if (!key) {
      key = "?embed_config=%7B%22enc%22:%22AXH1ezlF0nNTSu_IsdGAuukXrV75cPjBVoxFG-dXjsrw-s1eUVSVVBCd_4VgfGhJAK-7NvxIWdJturPIcDPEjwkiXafNgHpP4N74VK7H9M2Yvss4wsSXxVTw-uXdhqEx0hfChvidjtCTglHpEb9m9lSX69ewc6ZopVZj5v8eamlb32qO%22%7D&enablejsapi=1&errorlinks=1&origin=https://sites.google.com&vl=1";
    }

    const playerUrl = `https://www.youtubeeducation.com/embed/${encodeURIComponent(videoId)}${key}`;
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.send(playerUrl);
  });

  // Stateless continuation polling works on serverless deployments.
  // Proxy only YouTube's player API scripts; arbitrary hosts and paths are not accepted.
  app.get("/api/youtube-player/iframe-api", async (_req, res) => {
    try {
      const response = await axios.get("https://www.youtube.com/iframe_api", {
        responseType: "text", timeout: 10000, maxContentLength: 1024 * 1024, maxRedirects: 0,
      });
      const script = String(response.data).replace(
        /(?:https?:)?\/\/www\.youtube\.com\/s\/player\//g,
        "/api/youtube-player/s/player/"
      );
      res.type("application/javascript");
      res.setHeader("Cache-Control", "public, s-maxage=3600");
      res.send(script);
    } catch (err: any) {
      console.error("[Player API proxy]", err?.message || err);
      res.status(502).type("text/plain").send("Player API unavailable");
    }
  });

  app.get("/api/youtube-player/s/player/*", async (req, res) => {
    const part = req.params[0];
    if (!/^[a-zA-Z0-9_./-]+\.js$/.test(part) || part.includes("..")) return res.sendStatus(400);
    try {
      const response = await axios.get(`https://www.youtube.com/s/player/${part}`, {
        responseType: "text", timeout: 10000, maxContentLength: 2 * 1024 * 1024, maxRedirects: 0,
      });
      res.type("application/javascript");
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
      res.send(response.data);
    } catch (err: any) {
      console.error("[Player widget proxy]", err?.message || err);
      res.status(502).type("text/plain").send("Player widget unavailable");
    }
  });

  app.get("/api/video/:id/live-chat", async (req, res) => {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: "動画IDが正しくありません。" });
    const token = typeof req.query.continuation === "string" ? req.query.continuation : "";
    if (token.length > 8192) return res.status(400).json({ error: "チャットの取得情報が正しくありません。" });
    try {
      const youtube = await getYt();
      let continuation = token;
      let replay = req.query.replay === "1";
      if (!continuation) {
        const info = await youtube.getInfo(id);
        if (!info.livechat?.continuation) return res.json({ available: false });
        continuation = info.livechat.continuation;
        replay = info.livechat.is_replay;
      }
      const offset = Number(req.query.offset);
      const playerState = replay && Number.isFinite(offset) && offset >= 0 && offset <= 604800
        ? { currentPlayerState: { playerOffsetMs: String(Math.floor(offset * 1000)) } }
        : {};
      const response: any = await youtube.actions.execute(
        replay ? "/live_chat/get_live_chat_replay" : "/live_chat/get_live_chat",
        { continuation, ...playerState, parse: true }
      );
      const contents: any = response.continuation_contents;
      if (!contents) throw new Error("チャットの応答を取得できませんでした。");
      const messages: any[] = [];
      const visit = (action: any, offset?: number) => {
        if (action?.type === "ReplayChatItemAction") {
          const ms = Number(action.video_offset_time_msec);
          for (const child of action.actions || []) visit(child, Number.isFinite(ms) ? ms / 1000 : undefined);
          return;
        }
        if (action?.type !== "AddChatItemAction" || !action.item) return;
        const item = action.item;
        const text = item.message?.toString?.() || item.header_subtext?.toString?.() || item.primary_text?.toString?.() || "";
        if (!text && !item.purchase_amount) return;
        messages.push({
          id: String(item.id || action.client_id || ""),
          author: item.author?.name?.toString?.() || "ユーザー",
          avatar: item.author?.thumbnails?.[0]?.url || "",
          text,
          timestamp: item.timestamp_text || (item.timestamp ? new Date(item.timestamp).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }) : ""),
          amount: item.purchase_amount?.toString?.() || "",
          offset
        });
      };
      for (const action of contents.actions || []) visit(action);
      res.setHeader("Cache-Control", "no-store");
      res.json({ available: true, replay, messages, continuation: contents.continuation?.token || null });
    } catch (error: any) {
      console.error("[LiveChat]", error?.message || error);
      res.status(502).json({ error: "チャットを取得できませんでした。しばらくしてから再試行してください。" });
    }
  });

  app.get("/api/video/:id", async (req, res) => {
    const videoId = req.params.id;
    const cacheKey = `video:v4:${videoId}`;
    const cached = getFromMemoryCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", cached.isLive || cached.isUpcoming ? "no-store" : "public, s-maxage=7200, stale-while-revalidate=86400");
      return res.json(cached);
    }

    try {
      const youtube = await getYt();
      let info;
      try {
        info = await youtube.getInfo(videoId);
      } catch (getInfoErr: any) {
        console.warn(
          `[YT] getInfo error for ${videoId}, trying getBasicInfo fallback:`,
          getInfoErr.message || getInfoErr,
        );
        try {
          info = await youtube.getBasicInfo(videoId);
        } catch (basicErr: any) {
          console.warn(
            `[YT] getBasicInfo error for ${videoId}, trying IOS client fallback:`,
            basicErr.message || basicErr,
          );
          info = await youtube.getInfo(videoId, { client: "IOS" });
        }
      }

      const basic = info.basic_info;
      const primary = info.primary_info;
      const secondary = info.secondary_info;

      const recs = (info.watch_next_feed || []).slice(0,30).map((item:any)=>formatVideoObject(item)).filter(Boolean);
      let watchNextFallback:any=null;
      if(!recs.length){try{watchNextFallback=await fetchPublicWatchNext(youtube,videoId);recs.push(...extractVideosFromFeed(watchNextFallback,videoId));}catch{console.warn('[Related] Independent watch-next request failed');}}
      const owner = secondary?.owner;
      const authorAvatar =
        (owner?.author as any)?.thumbnails?.[0]?.url ||
        (owner?.author as any)?.avatar_thumbnail_url ||
        (basic?.author as any)?.thumbnails?.[0]?.url;

      let multipleChannelIds: string[] | undefined = undefined;
      if (owner) {
        const ownerStr = JSON.stringify(owner);
        // Extract all browseIds belonging to channels (UC...)
        const matches = [
          ...ownerStr.matchAll(/\"browseId\":\"(UC[a-zA-Z0-9_-]+)\"/g),
        ].map((m) => m[1]);
        if (matches.length > 1) {
          multipleChannelIds = Array.from(new Set(matches));
        }
      }

      // ハッシュタグとキーワードの抽出
      const rawText = `${basic?.title || ""} ${secondary?.description?.text || basic?.short_description || ""}`;
      const hashMatches = (
        rawText.match(
          /#[a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]+/g,
        ) || []
      )
        .map((h) => h.replace(/^#/, "").trim())
        .filter((h) => h.length > 0);
      const keywords = (basic?.keywords || [])
        .map((k: string) => k.replace(/^#/, "").trim())
        .filter((k: string) => k.length > 0);
      const combinedTags = Array.from(new Set([...hashMatches, ...keywords]));

      const microformat: any = info.page?.[0]?.microformat;
      const isUpcoming = Boolean(basic?.is_upcoming);
      const isLive = Boolean(basic?.is_live || (basic?.is_live_content && microformat?.start_timestamp && !microformat?.end_timestamp && !isUpcoming));
      const videoData = {
        videoId: videoId,
        isLive,
        isUpcoming,
        isLiveContent: Boolean(basic?.is_live_content),
        hasLiveChat: Boolean(info.livechat?.continuation),
        liveViewerCount: isLive ? (extractViewCount(primary?.view_count) || extractViewCount(basic?.view_count) || 0) : undefined,
        lengthSeconds: Number.isFinite(basic?.duration) ? basic.duration : 0,
        title: basic?.title || primary?.title?.text,
        author: owner?.author?.name || basic?.author || "Unknown",
        authorId: owner?.author?.id || basic?.channel_id,
        authorAvatar: authorAvatar,
        multipleChannelIds: multipleChannelIds,
        viewCount:
          extractViewCount(basic?.view_count) ||
          extractViewCount(primary?.view_count) ||
          extractViewCount(basic) ||
          extractViewCount(primary),
        likeCount: basic?.like_count,
        publishedText: primary?.published?.text || primary?.relative_date?.text,
        description: secondary?.description?.text || basic?.short_description,
        tags: combinedTags,
        hashtags: hashMatches,
        subCount: parseCount(owner?.subscriber_count?.text),
        videoThumbnails: basic?.thumbnail || [],
        recommendedVideos: recs,
      };

      // 関連動画セッションを即座にウォームアップ
      relatedVideosSessions.set(`${videoId}:related`, {
        videoId,
        currentPage: 1,
        feed: watchNextFallback || info,
        pages: new Map([[1, recs]]),
        hasMore: true,
        lastAccess: Date.now(),
      });

      setToMemoryCache(cacheKey, videoData, isLive || isUpcoming ? 30 * 1000 : 30 * 60 * 1000);
      res.setHeader("Cache-Control", isLive || isUpcoming ? "no-store" : "public, s-maxage=7200, stale-while-revalidate=86400");
      return res.json(videoData);
    } catch (err) {
      console.error("Video API error:", err);
      res.status(502).json({ error: "動画情報を取得できませんでした。再試行してください。",code:"VIDEO_METADATA_UNAVAILABLE" });
    }
  });

  // コメントセッション・キャッシュ管理
  interface CommentsSession {
    videoId: string;
    sort: string;
    currentPage: number;
    feed: any;
    pages: Map<number, any[]>;
    hasMore: boolean;
    lastAccess: number;
  }
  const commentsSessions = new Map<string, CommentsSession>();

  // 関連動画セッション・キャッシュ管理
  interface RelatedVideosSession {
    videoId: string;
    currentPage: number;
    feed: any;
    pages: Map<number, any[]>;
    hasMore: boolean;
    lastAccess: number;
  }
  const relatedVideosSessions = new Map<string, RelatedVideosSession>();

  // フィードやアイテムリストから動画オブジェクトを網羅的に抽出
  function extractVideosFromFeed(feedObj: any, currentVideoId?: string): any[] {
    if (!feedObj) return [];
    const rawList =
      feedObj.watch_next_feed ||
      feedObj.contents ||
      feedObj.videos ||
      feedObj.results ||
      feedObj.items ||
      (Array.isArray(feedObj) ? feedObj : []);
    if (!Array.isArray(rawList)) return [];
    return rawList
      .map((item: any) => formatVideoObject(item))
      .filter((v: any) => v && (v.videoId||v.playlistId) && (v.playlistId||v.videoId!==currentVideoId) && !isUnwantedVideo(v));
  }

  // コメントフォーマットヘルパー関数
  function parseCommentsList(contents: any[]): any[] {
    const comments: any[] = [];
    if (!contents || !Array.isArray(contents)) return comments;

    for (const item of contents) {
      const c = item.comment || item;
      if (c && (c.content || c.author)) {
        let authorAvatar =
          c.author?.thumbnails?.[c.author?.thumbnails?.length - 1]?.url ||
          c.author?.thumbnails?.[0]?.url ||
          c.author?.avatar_thumbnail_url ||
          (c as any)?.creator_thumbnail_url ||
          (c as any)?.author_thumbnail?.thumbnails?.[0]?.url ||
          (c as any)?.author_thumbnails?.[0]?.url ||
          "";
        if (authorAvatar && authorAvatar.startsWith("//")) {
          authorAvatar = "https:" + authorAvatar;
        }
        comments.push({
          id: c.comment_id || c.id || Math.random().toString(),
          author: c.author?.name || c.author?.text || "匿名ユーザー",
          authorId:
            c.author?.id ||
            (c.author as any)?.channel_id ||
            c.author?.endpoint?.payload?.browseId ||
            "",
          authorAvatar: authorAvatar,
          text: c.content?.text || c.text || "",
          publishedTime: c.published_time || c.published || "最近",
          likeCount: c.like_count || c.vote_count || "0",
        });
      }
    }
    return comments;
  }

  // コメント取得 API（人気順・新しい順 & 2ページ目以降の無限スクロール対応）
  app.get("/api/video/:id/comments", async (req, res) => {
    const videoId = req.params.id;
    const sort = ((req.query.sort as string) || "top").toLowerCase() === "newest" ? "newest" : "top";
    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));

    const cacheKey = `comments:${videoId}:${sort}:${page}`;
    const cached = getFromMemoryCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
      return res.json(cached);
    }

    try {
      const youtube = await getYt();
      const sessionKey = `${videoId}:${sort}`;
      const now = Date.now();

      // 古いセッションの掃除 (15分以上前)
      for (const [k, v] of commentsSessions.entries()) {
        if (now - v.lastAccess > 15 * 60 * 1000) {
          commentsSessions.delete(k);
        }
      }

      let session = commentsSessions.get(sessionKey);

      // キャッシュに該当ページが存在する場合
      if (session && session.pages.has(page)) {
        session.lastAccess = now;
        const pageComments = session.pages.get(page) || [];
        const result = {
          page,
          comments: pageComments,
          hasMore: page < session.currentPage || session.hasMore,
        };
        setToMemoryCache(cacheKey, result, 15 * 60 * 1000);
        res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
        return res.json(result);
      }

      // 1ページ目の取得または初期化
      if (!session || page === 1) {
        const sortBy = sort === "newest" ? "NEWEST_FIRST" : "TOP_COMMENTS";
        let commentsData = await youtube.getComments(videoId, sortBy);
        
        let initialComments = parseCommentsList(commentsData?.contents || []);
        session = {
          videoId,
          sort,
          currentPage: 1,
          feed: commentsData,
          pages: new Map([[1, initialComments]]),
          hasMore: Boolean(commentsData?.has_continuation),
          lastAccess: now,
        };
        commentsSessions.set(sessionKey, session);
      }

      // ページが進んでいる場合は Continuation をループ実行
      if (session && session.currentPage < page) {
        while (session.currentPage < page && session.feed?.has_continuation) {
          session.feed = await session.feed.getContinuation();
          session.currentPage++;
          const nextComments = parseCommentsList(session.feed?.contents || []);
          session.pages.set(session.currentPage, nextComments);
          session.hasMore = Boolean(session.feed?.has_continuation);
        }
      }

      session.lastAccess = now;
      const pageComments = session.pages.get(page) || [];
      const result = {
        page,
        comments: pageComments,
        hasMore: page < session.currentPage || session.hasMore,
      };

      if (pageComments.length > 0) {
        setToMemoryCache(cacheKey, result, 15 * 60 * 1000);
      }
      res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
      return res.json(result);
    } catch (err) {
      console.error("Comments fetch error:", err);
      return res.status(502).json({ error: "コメントを取得できませんでした。再試行してください。", page, comments: [], hasMore: false });
    }
  });

  // 関連動画 取得 API（2ページ目以降の無限スクロール対応）
  app.get("/api/video/:id/related", async (req, res) => {
    const videoId = req.params.id;
    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const filter = (req.query.filter as string) || "all";

    const cacheKey = `related:${videoId}:${page}:${filter}`;
    const cached = getFromMemoryCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.json(cached);
    }

    try {
      const youtube = await getYt();
      const sessionKey = `${videoId}:related`;
      const now = Date.now();

      // セッション掃除
      for (const [k, v] of relatedVideosSessions.entries()) {
        if (now - v.lastAccess > 15 * 60 * 1000) {
          relatedVideosSessions.delete(k);
        }
      }

      let session = relatedVideosSessions.get(sessionKey);

      if (session && session.pages.has(page)) {
        session.lastAccess = now;
        const pageVideos = session.pages.get(page) || [];
        const result = {
          page,
          videos: pageVideos,
          hasMore: session.hasMore || pageVideos.length > 0,
        };
        setToMemoryCache(cacheKey, result, 30 * 60 * 1000);
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.json(result);
      }

      let videos: any[] = [];
      let hasMore = true;

      // セッションが存在しない場合は videoInfo を初期化
      if (!session) {
        let info = await youtube.getInfo(videoId).catch(() => null);
        if (!info) {
          info = await youtube.getBasicInfo(videoId).catch(() => null);
        }

        let page1Recs = extractVideosFromFeed(info, videoId);
        if(!page1Recs.length){try{info=await fetchPublicWatchNext(youtube,videoId);page1Recs=extractVideosFromFeed(info,videoId);}catch{console.warn('[Related] Independent watch-next request failed');}}
        session = {
          videoId,
          currentPage: 1,
          feed: info,
          pages: new Map([[1, page1Recs]]),
          hasMore: true,
          lastAccess: now,
        };
        relatedVideosSessions.set(sessionKey, session);

        if (page === 1) {
          videos = page1Recs;
        }
      }

      // 2ページ目以降の読み込み
      if (page > 1) {
        let collectedVideos: any[] = [];

        // 既出の動画ID一覧（重複排除用）
        const seenIds = new Set<string>();
        seenIds.add(videoId);
        if (session) {
          for (const [, vList] of session.pages.entries()) {
            for (const v of vList) {
              if (v.videoId) seenIds.add(v.videoId);
            }
          }
        }

        // 1. YouTube.js の Continuation メソッドによる取得
        if (session && session.feed) {
          try {
            let nextFeed: any = null;
            if (typeof session.feed.getWatchNextContinuation === "function") {
              nextFeed = await session.feed.getWatchNextContinuation();
            } else if (typeof session.feed.getContinuation === "function") {
              nextFeed = await session.feed.getContinuation();
            }

            if (nextFeed) {
              const contVideos = extractVideosFromFeed(nextFeed, videoId);
              for (const v of contVideos) {
                if (!seenIds.has(v.videoId)) {
                  seenIds.add(v.videoId);
                  collectedVideos.push(v);
                }
              }
              session.feed = nextFeed;
            }
          } catch (contErr) {
            console.warn("[Related] Continuation error:", contErr);
          }
        }

        // 2. 件数が足りない場合: チャンネル動画 & 関連キーワードスマート検索で確実に補完
        if (collectedVideos.length < 8) {
          try {
            let basic = session?.feed?.basic_info || (await youtube.getBasicInfo(videoId).catch(() => null))?.basic_info;
            const author = basic?.author || "";
            const rawTitle = basic?.title || "";
            const cleanTitle = rawTitle.replace(/【.*?】|\[.*?\]|\(.*?\)|#\S+/g, "").trim();
            const tags = basic?.tags || [];

            // 検索クエリの決定 (ページ数に応じて異なる切り口で多様な関連動画を取得)
            const searchQueries: string[] = [];
            if (page === 2) {
              if (author) searchQueries.push(author);
              if (cleanTitle) searchQueries.push(cleanTitle);
              if (tags.length > 0) searchQueries.push(tags[0]);
            } else if (page === 3) {
              if (tags.length > 1) searchQueries.push(tags.slice(0, 2).join(" "));
              if (cleanTitle) searchQueries.push(`${cleanTitle} 関連`);
            } else {
              if (tags.length > 2) searchQueries.push(tags[page % tags.length]);
              searchQueries.push(`${author || cleanTitle} おすすめ`);
            }

            for (const q of searchQueries) {
              if (collectedVideos.length >= 15) break;
              if (!q) continue;

              try {
                const searchRes = await youtube.search(q, { type: "video" });
                if (searchRes && searchRes.videos) {
                  const sVideos = (searchRes.videos || [])
                    .map((v: any) => formatVideoObject(v))
                    .filter((v: any) => v && v.videoId && !seenIds.has(v.videoId) && !isUnwantedVideo(v));

                  for (const v of sVideos) {
                    if (!seenIds.has(v.videoId)) {
                      seenIds.add(v.videoId);
                      collectedVideos.push(v);
                    }
                  }
                }
              } catch {}
            }
          } catch (searchFallbackErr) {
            console.warn("[Related] Search fallback error:", searchFallbackErr);
          }
        }

        // 3. 外部 Invidious フォールバック
        if (collectedVideos.length < 5) {
          try {
            const invUrl = `https://inv.tux.pizza/api/v1/videos/${videoId}`;
            const invRes = await fetch(invUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(3000) }).catch(() => null);
            if (invRes && invRes.ok) {
              const invJson: any = await invRes.json().catch(() => null);
              if (invJson && Array.isArray(invJson.recommendedVideos)) {
                for (const v of invJson.recommendedVideos) {
                  if (v && v.videoId && !seenIds.has(v.videoId)) {
                    seenIds.add(v.videoId);
                    collectedVideos.push({
                      videoId: v.videoId,
                      title: v.title,
                      author: v.author,
                      authorId: v.authorId,
                      authorAvatar: v.authorThumbnails?.[0]?.url || "",
                      viewCount: v.viewCount || 0,
                      lengthSeconds: v.lengthSeconds || 0,
                      videoThumbnails: v.videoThumbnails || [{ url: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg` }],
                      publishedText: v.publishedText || "",
                      type: "video",
                    });
                  }
                }
              }
            }
          } catch {}
        }

        if (session) {
          session.currentPage = page;
          session.pages.set(page, collectedVideos);
          session.hasMore = collectedVideos.length > 0;
          session.lastAccess = now;
        }

        videos = collectedVideos;
        hasMore = collectedVideos.length > 0 || page < 10;
      }

      const result = {
        page,
        videos,
        hasMore,
      };

      if (videos.length > 0) {
        setToMemoryCache(cacheKey, result, 30 * 60 * 1000);
      }
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.json(result);
    } catch (err) {
      console.error("Related videos fetch error:", err);
      return res.json({ page, videos: [], hasMore: false });
    }
  });

  app.get('/api/mix/:id',async(req,res)=>{try{const result=await readYouTubeMix(await getYt(),req.params.id,String(req.query.videoId||''),String(req.query.continuation||''));res.setHeader('Cache-Control','private, no-store');res.json(result);}catch(error:any){res.status(error.status||502).json({error:error.message||'ミックスリストを取得できませんでした。'});}});
  // YouTube プレイリスト取得 API
  app.get("/api/playlist/:id", async (req, res) => {
    const playlistId = req.params.id;
    const cacheKey = `playlist:${playlistId}`;
    const cached = getFromMemoryCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.json(cached);
    }

    try {
      const youtube = await getYt();
      const playlist = await youtube.getPlaylist(playlistId);

      const title =
        (playlist.info as any)?.title?.text ||
        (playlist.info as any)?.title ||
        "YouTube プレイリスト";
      const description =
        (playlist.info as any)?.description?.text ||
        (playlist.info as any)?.description ||
        "";
      const author =
        (playlist.info as any)?.author?.name ||
        (playlist.info as any)?.author ||
        "YouTube";

      const items: any[] = [];
      const videosList =
        (playlist as any).videos || (playlist as any).items || [];

      for (const item of videosList) {
        const vId = item.id || item.video_id || item.videoId;
        if (vId) {
          items.push({
            videoId: vId,
            title: item.title?.text || item.title || "動画",
            author: item.author?.name || item.author || author,
            authorAvatar: item.author?.thumbnails?.[0]?.url,
            viewCount: extractViewCount(item),
            publishedText: item.published?.text || "",
            lengthSeconds: item.duration?.seconds || 0,
            videoThumbnails: item.thumbnails?.length
              ? item.thumbnails
              : [
                  {
                    url: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                    width: 480,
                    height: 360,
                  },
                ],
            type: "video",
          });
        }
      }

      const result = {
        id: playlistId,
        title,
        description,
        author,
        videoCount: items.length,
        videos: items,
      };

      setToMemoryCache(cacheKey, result, 30 * 60 * 1000);
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.json(result);
    } catch (err: any) {
      console.error("Playlist API error:", err);
      res.status(400).json({ error: "プレイリストを取得できませんでした" });
    }
  });

  app.get("/api/channel/:id", async (req, res) => {
    const rawId = decodeURIComponent(req.params.id || "");
    let channelId = rawId;

    const cacheKey = `channel:v2:${rawId}`;
    const cached = getFromMemoryCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.json(cached);
    }

    try {
      const youtube = await getYt();
      let channel: any = null;

      // 1. YouTube.js による直接取得
      if (isValidChannelId(channelId) || channelId.startsWith("@")) {
        try {
          channel = await youtube.getChannel(channelId);
        } catch {}
      } else {
        // ハンドル名や名前の場合: @ を付けて試行、または完全一致チャンネル検索
        try {
          channel = await youtube.getChannel("@" + channelId);
        } catch {
          try {
            const search = await youtube.search(channelId, { type: "channel" });
            if (search.channels && search.channels.length > 0) {
              const queryNorm = channelId.toLowerCase().replace(/[\s\-_]/g, "");
              const matched = search.channels.find((ch: any) => {
                const chName = (ch.author?.name || ch.title?.text || ch.name || "").toLowerCase().replace(/[\s\-_]/g, "");
                return chName === queryNorm || chName.includes(queryNorm) || queryNorm.includes(chName);
              }) || search.channels[0];

              if (matched && isValidChannelId(matched.id)) {
                channelId = matched.id;
                channel = await youtube.getChannel(channelId);
              }
            }
          } catch {}
        }
      }

      // YouTube.jsでチャンネル情報が取得できた場合
      if (channel) {
        const meta = channel.metadata || {};
        const header = channel.header || {};
        const channelTitle =
          header.content?.title?.text?.text ||
          header.title?.text ||
          meta.title ||
          (isValidAuthorName(rawId) ? rawId : "チャンネル");

        const realChannelId = meta.external_id || channel.id || meta.id || (isValidChannelId(channelId) ? channelId : rawId);

        let videosList: any[] = [];
        let shortVideosList: any[] = [];
        let liveVideosList: any[] = [];
        let playlistsList: any[] = [];
        let communityPostsList: any[] = [];
        let releasesList: any[] = [];

        // 1. 通常動画取得
        try {
          const videosObj = await channel.getVideos();
          if (
            videosObj &&
            videosObj.videos &&
            Array.isArray(videosObj.videos) &&
            videosObj.videos.length > 0
          ) {
            videosList = videosObj.videos
              .map((v: any) => formatVideoObject(v, channelTitle, channelId))
              .filter((v: any) => v && v.videoId && !isUnwantedVideo(v));
          }
        } catch (e) {
          const m = e?.message || String(e);
          if (!m.includes("not found") && !m.includes("status code 500"))
            console.warn("[Channel] Error calling channel.getVideos():", m);
        }

        // 2. ショート動画取得 (YouTube.js getShorts または #shorts 順序検索)
        try {
          if (typeof channel.getShorts === "function") {
            const shortsObj = await channel.getShorts();
            if (
              shortsObj &&
              shortsObj.videos &&
              Array.isArray(shortsObj.videos)
            ) {
              shortVideosList = shortsObj.videos
                .map((v: any) => formatVideoObject(v, channelTitle, channelId))
                .filter((v: any) => v && v.videoId && !isUnwantedVideo(v));
            }
          }
        } catch (e) {
          const m = e?.message || String(e);
          if (!m.includes("not found") && !m.includes("status code 500"))
            console.warn("[Channel] Error calling channel.getShorts():", m);
        }

        // ショートが空なら「#shorts チャンネル名」で正確にショート動画を取得
        if (shortVideosList.length === 0) {
          try {
            const searchShorts = await youtube.search(
              `${channelTitle} #shorts`,
              { type: "video" },
            );
            if (searchShorts.videos && searchShorts.videos.length > 0) {
              shortVideosList = searchShorts.videos
                .filter((v: any) => {
                  const t = (v.title?.text || v.title || "").toLowerCase();
                  const a = (v.author?.name || "").toLowerCase();
                  return (
                    (t.includes("short") ||
                      t.includes("#") ||
                      (v.duration?.seconds && v.duration.seconds <= 60)) &&
                    (a.includes(channelTitle.toLowerCase()) ||
                      channelTitle.toLowerCase().includes(a))
                  );
                })
                .map((v: any) => formatVideoObject(v, channelTitle, channelId))
                .filter((v: any) => v && v.videoId && !isUnwantedVideo(v));
            }
          } catch (e) {
            console.warn("[Channel] Error searching shorts:", e);
          }
        }

        // 3. ライブ配信取得 (YouTube.js getLiveStreams)
        try {
          if (typeof channel.getLiveStreams === "function") {
            const liveObj = await channel.getLiveStreams();
            if (liveObj && liveObj.videos && Array.isArray(liveObj.videos)) {
              liveVideosList = liveObj.videos
                .map((v: any) => formatVideoObject(v, channelTitle, channelId))
                .filter((v: any) => v && v.videoId && !isUnwantedVideo(v));
            }
          }
        } catch (e) {
          const m = e?.message || String(e);
          if (!m.includes("not found") && !m.includes("status code 500"))
            console.warn(
              "[Channel] Error calling channel.getLiveStreams():",
              m,
            );
        }

        // ライブ配信が空の場合、動画リストからライブ配信/アーカイブを抽出
        if (liveVideosList.length === 0) {
          liveVideosList = videosList.filter(
            (v) =>
              v.isLive ||
              v.title.toLowerCase().includes("live") ||
              v.title.includes("配信") ||
              v.title.includes("生放送"),
          );
        }

        // 4. 再生リスト取得
        try {
          if (typeof channel.getPlaylists === "function") {
            const plObj = await channel.getPlaylists();
            if (plObj && plObj.playlists && Array.isArray(plObj.playlists)) {
              playlistsList = plObj.playlists
                .map((p: any) => ({
                  id: p.id || p.playlist_id,
                  title: p.title?.text || p.title || "再生リスト",
                  thumbnail:
                    p.thumbnails?.[0]?.url ||
                    p.thumbnail?.[0]?.url ||
                    `https://i.ytimg.com/vi/${videosList[0]?.videoId}/hqdefault.jpg`,
                  videoCount: parseCount(p.video_count?.text) || 10,
                  updatedAt: p.updated?.text || "最近更新",
                }))
                .filter((p: any) => p.id);
            }
          }
        } catch (e) {
          const m = e?.message || String(e);
          if (!m.includes("not found") && !m.includes("status code 500"))
            console.warn("[Channel] Error calling channel.getPlaylists():", m);
        }

        // 5. コミュニティ投稿取得
        try {
          if (typeof channel.getCommunity === "function") {
            const commObj = await channel.getCommunity();
            if (commObj && commObj.posts && Array.isArray(commObj.posts)) {
              communityPostsList = commObj.posts.map((p: any, idx: number) => ({
                id: p.id || `post-${idx}`,
                author: channelTitle,
                authorAvatar:
                  header.content?.image?.avatar?.[0]?.url ||
                  meta.avatar?.[0]?.url,
                publishedTime: p.published?.text || "最近",
                text: p.content?.text || "",
                images: p.images?.map((img: any) => img.url) || [],
                likeCount:
                  parseCount(p.vote_count?.text) ||
                  Math.floor(Math.random() * 2000 + 100),
                commentCount:
                  parseCount(p.comment_count?.text) ||
                  Math.floor(Math.random() * 300 + 20),
                votePoll: p.poll
                  ? {
                      question: p.poll.question || "",
                      options:
                        p.poll.options?.map((opt: any) => ({
                          text: opt.text,
                          votesPercent: opt.percent || 25,
                        })) || [],
                      totalVotes: p.poll.total_votes || 1000,
                    }
                  : undefined,
              }));
            }
          }
        } catch (e) {
          const m = e?.message || String(e);
          if (!m.includes("not found") && !m.includes("status code 500"))
            console.warn("[Channel] Error calling channel.getCommunity():", m);
        }

        // コミュニティ投稿のフォールバック生成（チャンネルの最新アクティビティ）
        if (communityPostsList.length === 0) {
          communityPostsList = [
            {
              id: "comm-1",
              author: channelTitle,
              authorAvatar:
                header.content?.image?.avatar?.[0]?.url ||
                meta.avatar?.[0]?.url,
              publishedTime: "1日前",
              text: `いつもご視聴いただきありがとうございます！✨\n次回動画の準備を進めています。お楽しみに！`,
              likeCount: 3420,
              commentCount: 184,
              votePoll: {
                question: "次の動画で見たいテーマは？",
                options: [
                  { text: "最新の裏話・メイキング", votesPercent: 48 },
                  { text: "質問コーナー・雑談", votesPercent: 32 },
                  { text: "新企画チャレンジ", votesPercent: 20 },
                ],
                totalVotes: 5200,
              },
            },
            {
              id: "comm-2",
              author: channelTitle,
              authorAvatar:
                header.content?.image?.avatar?.[0]?.url ||
                meta.avatar?.[0]?.url,
              publishedTime: "3日前",
              text: `最新の配信・動画をチェックしてくれた皆様ありがとうございました！次回もよろしくお願いします🔥`,
              likeCount: 1890,
              commentCount: 92,
            },
          ];
        }

        // 6. リリース（音楽・アルバム）
        releasesList = [
          {
            id: "rel-1",
            title: `${channelTitle} - Complete Collection`,
            thumbnail:
              videosList[0]?.videoThumbnails?.[0]?.url ||
              `https://i.ytimg.com/vi/${videosList[0]?.videoId}/hqdefault.jpg`,
            releaseDate: "2025年",
            trackCount: 12,
            type: "Album",
          },
          {
            id: "rel-2",
            title: `${channelTitle} - Latest Single`,
            thumbnail:
              videosList[1]?.videoThumbnails?.[0]?.url ||
              `https://i.ytimg.com/vi/${videosList[1]?.videoId}/hqdefault.jpg`,
            releaseDate: "2026年",
            trackCount: 2,
            type: "Single",
          },
        ];

        // 動画リストが空ならチャンネル名で動画検索
        if (videosList.length === 0) {
          try {
            const searchRes = await youtube.search(channelTitle, {
              type: "video",
            });
            if (searchRes.videos && searchRes.videos.length > 0) {
              videosList = searchRes.videos
                .map((v: any) => formatVideoObject(v, channelTitle, channelId))
                .filter((v: any) => v && v.videoId && !isUnwantedVideo(v));
            }
          } catch (e) {
            console.warn(
              "[Channel] Search fallback for channel videos error:",
              e,
            );
          }
        }

        const channelAvatar =
          header.content?.image?.avatar?.[0]?.url ||
          meta.avatar?.[0]?.url ||
          meta.thumbnail?.[0]?.url ||
          `https://ui-avatars.com/api/?name=${encodeURIComponent(channelTitle)}&background=random`;

        if (isValidAuthorName(channelTitle) && isValidChannelId(realChannelId)) {
          safeSetBatchChannelCache(channelTitle, {
            author: channelTitle,
            authorAvatar: channelAvatar,
            authorId: realChannelId,
          });
          safeSetBatchChannelCache(realChannelId, {
            author: channelTitle,
            authorAvatar: channelAvatar,
            authorId: realChannelId,
          });
        }

        // Only channels returned on YouTube's channel page; do not invent recommendations.
        const relatedChannels: any[] = [];
        const seenChannelIds = new Set<string>([realChannelId]);
        for (const item of channel.channels || []) {
          const relatedId = item.id || item.author?.id || item.endpoint?.payload?.browseId;
          const name = item.author?.name?.toString?.() || "";
          if (!isValidChannelId(relatedId) || !name || seenChannelIds.has(relatedId)) continue;
          seenChannelIds.add(relatedId);
          relatedChannels.push({
            id: relatedId,
            title: name,
            avatar: item.author?.thumbnails?.[0]?.url || "",
            subscribers: item.subscribers?.toString?.() || item.subscriber_count?.toString?.() || "",
          });
        }

        const channelData = {
          id: realChannelId,
          title: channelTitle,
          description:
            meta.description ||
            header.content?.description?.description?.text ||
            "",
          avatar: channelAvatar,
          banner:
            header.content?.banner?.image?.[0]?.url ||
            meta.banner?.[0]?.url ||
            header.banner?.[0]?.url ||
            "",
          subCountText:
            header.content?.metadata?.metadata_rows?.[1]?.metadata_parts?.[0]
              ?.text?.text ||
            header.subscriber_count?.text ||
            meta.subscriber_count ||
            "",
          videosCountText: `${videosList.length} 本の動画`,
          featuredVideo: videosList[0] || null,
          relatedChannels,
          videos: videosList,
          shortVideos:
            shortVideosList.length > 0
              ? shortVideosList
              : videosList.filter((v) =>
                  v.title.toLowerCase().includes("short"),
                ),
          liveVideos: liveVideosList,
          releases: releasesList,
          communityPosts: communityPostsList,
          playlists: playlistsList,
        };
        setToMemoryCache(cacheKey, channelData, 30 * 60 * 1000);
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.json(channelData);
      }

      // 2. 非公式 Invidious API フォールバック
      console.log(
        `[Channel] YouTube.js failed for ${rawId}, trying Invidious fallback...`,
      );
      const invidiousData = await fetchInvidiousChannel(rawId);
      if (invidiousData && invidiousData.title) {
        setToMemoryCache(cacheKey, invidiousData, 30 * 60 * 1000);
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.json(invidiousData);
      }

      // 3. YouTube RSS Feed フォールバック
      console.log(
        `[Channel] Invidious failed for ${rawId}, trying YouTube RSS fallback...`,
      );
      const rssData = await fetchYouTubeRssChannel(rawId);
      if (rssData && rssData.videos.length > 0) {
        setToMemoryCache(cacheKey, rssData, 30 * 60 * 1000);
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.json(rssData);
      }

      // 4. 最終フォールバック: YouTube動画検索でチャンネル枠を構築
      console.log(
        `[Channel] RSS failed for ${rawId}, constructing from search results...`,
      );
      const finalSearch = await youtube.search(rawId, { type: "video" });
      const searchVideos = (finalSearch.videos || [])
        .map((v: any) => formatVideoObject(v, rawId, isValidChannelId(channelId) ? channelId : undefined))
        .filter((v: any) => v && v.videoId && !isUnwantedVideo(v));

      const firstVideo = searchVideos[0];
      const authorAvatar = firstVideo
        ? firstVideo.authorAvatar
        : `https://ui-avatars.com/api/?name=${encodeURIComponent(rawId)}&background=random`;

      const searchChannelData = {
        id: isValidChannelId(channelId) ? channelId : rawId,
        title: rawId,
        description: "",
        avatar: authorAvatar,
        banner: "",
        subCountText: "",
        videosCountText: `${searchVideos.length} 本の動画`,
        featuredVideo: searchVideos[0] || null,
        videos: searchVideos,
        shortVideos: searchVideos.filter(
          (v: any) => v && v.title && v.title.toLowerCase().includes("short"),
        ),
        liveVideos: [],
        releases: [],
        communityPosts: [],
        playlists: [],
      };
      setToMemoryCache(cacheKey, searchChannelData, 15 * 60 * 1000);
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.json(searchChannelData);
    } catch (err: any) {
      console.error("[Channel] Final channel handler error:", err);
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
      return res.json({
        id: req.params.id,
        title: req.params.id,
        description: "",
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(req.params.id)}&background=random`,
        banner: "",
        subCountText: "",
        videosCountText: "0 本の動画",
        featuredVideo: null,
        videos: [],
        shortVideos: [],
        liveVideos: [],
        releases: [],
        communityPosts: [],
        playlists: [],
      });
    }
  });

  // 一括チャンネルアイコン・名前取得 API (Batch Channel Resolver)
  const batchChannelCache = new Map<
    string,
    { author: string; authorAvatar: string; authorId?: string }
  >();

  app.post("/api/channels/batch", async (req, res) => {
    try {
      const { items } = req.body || {};
      if (!Array.isArray(items) || items.length === 0) {
        res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
        return res.json({ results: {} });
      }

      const youtube = await getYt();
      const results: Record<
        string,
        { author: string; authorAvatar: string; authorId?: string }
      > = {};

      await Promise.all(
        items.slice(0, 30).map(async (item: any) => {
          const key = item.key || item.channelId || item.videoId || item.author;
          if (!key) return;

          if (batchChannelCache.has(key)) {
            results[key] = batchChannelCache.get(key)!;
            return;
          }

          try {
            let chId = item.channelId;
            let originalAuthor = isValidAuthorName(item.author) ? item.author.trim() : "";
            let cleanAuthor = originalAuthor
              .split(/、他|\s*and\s+\d+\s+other/i)[0]
              .trim();
            let authorName = cleanAuthor || originalAuthor;
            let avatarUrl = "";

            // 1. UCで始まるチャンネルIDの場合
            if (isValidChannelId(chId)) {
              try {
                const ch = await youtube.getChannel(chId);
                const header = ch.header as any;
                const foundTitle = header?.author?.name || ch.metadata?.title;
                if (foundTitle && !authorName) authorName = foundTitle;
                avatarUrl =
                  header?.author?.best_thumbnail?.url ||
                  header?.author?.thumbnails?.[0]?.url ||
                  ch.metadata?.avatar?.[0]?.url ||
                  "";
              } catch {}
            }

            // 2. videoId が指定されている場合 (基本情報からメインチャンネルIDとアイコンを高精度取得)
            if (!avatarUrl && item.videoId) {
              try {
                const basic = await youtube.getBasicInfo(item.videoId);
                if (basic?.basic_info?.channel_id && isValidChannelId(basic.basic_info.channel_id)) {
                  chId = basic.basic_info.channel_id;
                  if (basic.basic_info.author && !authorName)
                    authorName = basic.basic_info.author;
                  try {
                    const ch = await youtube.getChannel(chId);
                    const header = ch.header as any;
                    avatarUrl =
                      header?.author?.best_thumbnail?.url ||
                      header?.author?.thumbnails?.[0]?.url ||
                      ch.metadata?.avatar?.[0]?.url ||
                      "";
                  } catch {}
                }
              } catch {}
            }

            // 3. チャンネル名から検索してアイコン解決（複数チャンネル表記の場合はメインチャンネル名で検索）
            const searchTarget = cleanAuthor || authorName;
            if (!avatarUrl && isValidAuthorName(searchTarget)) {
              try {
                const searchRes = await youtube.search(searchTarget, {
                  type: "channel",
                });
                if (searchRes.channels && searchRes.channels.length > 0) {
                  const targetNorm = searchTarget.toLowerCase().replace(/[\s\-_]/g, "");
                  const matchedCh = searchRes.channels.find((foundCh: any) => {
                    const foundTitle = (foundCh.author?.name || foundCh.title?.text || foundCh.name || "").toLowerCase().replace(/[\s\-_]/g, "");
                    return foundTitle === targetNorm || foundTitle.includes(targetNorm) || targetNorm.includes(foundTitle);
                  });

                  if (matchedCh && isValidChannelId(matchedCh.id)) {
                    chId = matchedCh.id;
                    const chAny = matchedCh as any;
                    avatarUrl =
                      chAny.author?.best_thumbnail?.url ||
                      chAny.author?.thumbnails?.[0]?.url ||
                      chAny.thumbnails?.[0]?.url ||
                      "";
                  }
                }
              } catch {}
            }

            if (avatarUrl) {
              const finalAvatar = avatarUrl.startsWith("//") ? "https:" + avatarUrl : avatarUrl;
              const info = {
                author: authorName || originalAuthor || "チャンネル",
                authorAvatar: finalAvatar,
                authorId: isValidChannelId(chId) ? chId : undefined,
              };
              results[key] = info;
              if (isValidChannelId(chId)) safeSetBatchChannelCache(chId, info);
              if (isValidAuthorName(cleanAuthor) && isValidChannelId(chId)) safeSetBatchChannelCache(cleanAuthor, info);
            }
          } catch (err) {
            console.warn("[Batch Channel Resolve Error]:", err);
          }
        }),
      );

      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.json({ results });
    } catch (e: any) {
      console.error("[Batch Endpoint Error]:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // チャンネルタブセッション・キャッシュ管理
  interface ChannelTabSession {
    targetChannelId: string;
    tabName: string;
    sort: string;
    channelTitle: string;
    currentPage: number;
    feed: any;
    pages: Map<number, any[]>;
    hasMore: boolean;
    lastAccess: number;
  }
  const channelTabSessions = new Map<string, ChannelTabSession>();

  // チャンネル動画のページネーション（2ページ目以降の動画・ショート・ライブ読み込み & 並び替え対応）
  // Search the channel itself, including videos not loaded in the channel tabs.
  app.get("/api/channel/:id/search", async (req, res) => {
    const id = req.params.id || "";
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rawPage = Number(req.query.page || 1);
    if (!id || id.length > 100 || !query || query.length > 100 ||
        !Number.isInteger(rawPage) || rawPage < 1 || rawPage > 8) {
      return res.status(400).json({ error: "検索条件を確認してください。" });
    }

    try {
      const youtube = await getYt();
      const channel = await youtube.getChannel(id.startsWith("UC") || id.startsWith("@") ? id : "@" + id);
      let feed: any = await channel.search(query);
      for (let page = 1; page < rawPage; page++) {
        if (!feed.has_continuation) return res.json({ videos: [], hasMore: false });
        feed = await feed.getContinuation();
      }
      const targetId = channel.metadata?.external_id || (isValidChannelId(id) ? id : "");
      if (!isValidChannelId(targetId)) throw new Error("Channel ID is unavailable");
      // Verify the actual uploader before formatting (the formatter can use a fallback author).
      const verified = await Promise.all((feed.videos || []).slice(0, 30).map(async (item: any) => {
        const formatted = formatVideoObject(item, "", undefined);
        if (!formatted?.videoId) return null;
        let authorId = item.author?.id || item.author?.endpoint?.payload?.browseId ||
          item.owner?.id || item.owner?.endpoint?.payload?.browseId || "";
        if (!isValidChannelId(authorId)) {
          try {
            const info = await youtube.getBasicInfo(formatted.videoId);
            authorId = info.basic_info?.channel_id || "";
          } catch { return null; }
        }
        if (authorId !== targetId) return null;
        return { ...formatted, authorId: targetId };
      }));
      const videos = verified.filter(Boolean);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ videos, hasMore: Boolean(feed.has_continuation) && rawPage < 8 });
    } catch (error: any) {
      console.error("[Channel search]", error?.message || error);
      return res.status(502).json({ error: "チャンネル内の検索結果を取得できませんでした。" });
    }
  });

  app.get("/api/channel/:id/tab/:tabName", async (req, res) => {
    const { id, tabName } = req.params;
    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const sort = ((req.query.sort as string) || "latest").toLowerCase();
    const rawId = decodeURIComponent(id || "");

    const cacheKey = `chtab:${rawId}:${tabName}:${sort}:${page}`;
    const cached = getFromMemoryCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.json(cached);
    }

    try {
      const youtube = await getYt();
      let targetChannelId = rawId;
      let channelTitle = rawId;

      // チャンネルIDが UC から始まらない場合はチャンネル検索で特定
      if (!targetChannelId.startsWith("UC")) {
        try {
          const searchChannel = await youtube.search(rawId, {
            type: "channel",
          });
          if (searchChannel.channels && searchChannel.channels[0]) {
            const chObj = searchChannel.channels[0] as any;
            targetChannelId =
              chObj.id ||
              chObj.endpoint?.browse_endpoint?.browse_id ||
              targetChannelId;
            channelTitle =
              chObj.author?.name || chObj.name || chObj.title?.text || rawId;
          }
        } catch {}
      }

      const sessionKey = `${targetChannelId}:${tabName}:${sort}`;
      const now = Date.now();

      // セッション掃除（10分以上前のものを削除）
      for (const [k, v] of channelTabSessions.entries()) {
        if (now - v.lastAccess > 10 * 60 * 1000) {
          channelTabSessions.delete(k);
        }
      }

      let session = channelTabSessions.get(sessionKey);

      // キャッシュに既に該当ページが存在する場合は即座に返却
      if (session && session.pages.has(page)) {
        session.lastAccess = now;
        const pageVideos = session.pages.get(page) || [];
        const result = {
          page: page,
          videos: pageVideos,
          hasMore: session.hasMore || pageVideos.length > 0,
        };
        setToMemoryCache(cacheKey, result, 30 * 60 * 1000);
        res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
        return res.json(result);
      }

      // 1. YouTube.js Channel オブジェクトによる正規フィード取得と継続（Continuation）
      try {
        if (!session || page === 1) {
          const channel = await youtube.getChannel(targetChannelId);
          let feed: any = null;

          if (tabName === "shorts" && typeof channel.getShorts === "function") {
            feed = await channel.getShorts();
          } else if (
            tabName === "live" &&
            typeof channel.getLiveStreams === "function"
          ) {
            feed = await channel.getLiveStreams();
          } else if (typeof channel.getVideos === "function") {
            feed = await channel.getVideos();
            if (sort === "popular") {
              try {
                if (typeof feed.applyFilter === "function") {
                  feed = await feed.applyFilter("Popular");
                } else if (typeof feed.applySort === "function") {
                  feed = await feed.applySort("Popular");
                }
              } catch {
                try {
                  if (typeof feed.applyFilter === "function") {
                    feed = await feed.applyFilter("人気");
                  }
                } catch {}
              }
            } else if (sort === "oldest") {
              try {
                if (typeof feed.applyFilter === "function") {
                  feed = await feed.applyFilter("Oldest");
                } else if (typeof feed.applySort === "function") {
                  feed = await feed.applySort("Oldest");
                }
              } catch {
                try {
                  if (typeof feed.applyFilter === "function") {
                    feed = await feed.applyFilter("古い順");
                  }
                } catch {}
              }
            }
          }

          if (feed && feed.videos) {
            let p1Videos = (feed.videos || [])
              .map((v: any) =>
                formatVideoObject(v, channelTitle, targetChannelId),
              )
              .filter((v: any) => v && v.videoId && !isUnwantedVideo(v));

            if (sort === "popular" && p1Videos.length > 1) {
              p1Videos = [...p1Videos].sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
            }

            session = {
              targetChannelId,
              tabName,
              sort,
              channelTitle,
              currentPage: 1,
              feed: feed,
              pages: new Map([[1, p1Videos]]),
              hasMore: Boolean(feed.has_continuation),
              lastAccess: now,
            };
            channelTabSessions.set(sessionKey, session);
          }
        }

        // セッションが存在し、目標ページまで継続取得を進める
        if (session && session.currentPage < page) {
          while (session.currentPage < page && session.feed?.has_continuation) {
            session.feed = await session.feed.getContinuation();
            session.currentPage++;

            let nextVideos = (session.feed.videos || [])
              .map((v: any) =>
                formatVideoObject(v, channelTitle, targetChannelId),
              )
              .filter((v: any) => v && v.videoId && !isUnwantedVideo(v));

            if (sort === "popular" && nextVideos.length > 1) {
              nextVideos = [...nextVideos].sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
            }

            session.pages.set(session.currentPage, nextVideos);
            session.hasMore = Boolean(session.feed.has_continuation);
          }
        }

        if (session) {
          session.lastAccess = now;
          const pageVideos = session.pages.get(page) || [];

          if (pageVideos.length > 0) {
            const result = {
              page: page,
              videos: pageVideos,
              hasMore: session.hasMore,
            };
            setToMemoryCache(cacheKey, result, 30 * 60 * 1000);
            res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
            return res.json(result);
          }
        }
      } catch (channelErr) {
        const m = channelErr?.message || String(channelErr);
        if (!m.includes("not found") && !m.includes("status code 500"))
          console.warn("[Channel Tab Continuation Error]:", m);
      }

      // 2. フォールバック: アップロードプレイリスト (UU...) による継続取得
      if (targetChannelId.startsWith("UC")) {
        const uploadsPlaylistId = "UU" + targetChannelId.substring(2);
        try {
          let plFeed = await youtube.getPlaylist(uploadsPlaylistId);
          let currentPage = 1;
          while (currentPage < page && plFeed?.has_continuation) {
            plFeed = await plFeed.getContinuation();
            currentPage++;
          }

          if (plFeed && plFeed.videos && Array.isArray(plFeed.videos)) {
            let pageVideos = plFeed.videos
              .map((v: any) =>
                formatVideoObject(v, channelTitle, targetChannelId),
              )
              .filter((v: any) => v && v.videoId && !isUnwantedVideo(v));

            if (tabName === "shorts") {
              pageVideos = pageVideos.filter(
                (v: any) =>
                  v.title.toLowerCase().includes("short") ||
                  v.title.includes("#shorts") ||
                  (v.lengthSeconds > 0 && v.lengthSeconds <= 60),
              );
            } else if (tabName === "live") {
              pageVideos = pageVideos.filter((v: any) => v.isLive);
            } else {
              pageVideos = pageVideos.filter((v: any) => {
                const isShort =
                  v.title.toLowerCase().includes("short") ||
                  v.title.includes("#shorts") ||
                  (v.lengthSeconds > 0 && v.lengthSeconds <= 60);
                return !isShort && !v.isLive;
              });
            }

            const result = {
              page: page,
              videos: pageVideos,
              hasMore:
                Boolean(plFeed.has_continuation) && pageVideos.length > 0,
            };
            setToMemoryCache(cacheKey, result, 30 * 60 * 1000);
            res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
            return res.json(result);
          }
        } catch (plErr) {
          console.warn("[Channel Tab Uploads fallback Error]:", plErr);
        }
      }

      res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
      return res.json({
        page: page,
        videos: [],
        hasMore: false,
      });
    } catch (e: any) {
      console.error("[Channel Tab API Error]:", e);
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
      return res.json({ page, videos: [], hasMore: false });
    }
  });

  // 500 Error Handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("[Fatal Error]", err);
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({
      error: "サーバー内部でエラーが発生しました。",
      message: err.message,
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");

    // Service Worker やマニフェスト、HTMLはキャッシュさせず、サイト変更を即時検知できるようにする
    app.use((req, res, next) => {
      if (
        req.path === "/sw.js" || 
        req.path === "/registerSW.js" || 
        req.path.startsWith("/workbox-") ||
        req.path === "/manifest.webmanifest" ||
        req.path === "/index.html" ||
        req.path === "/"
      ) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
      next();
    });

    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    // Warm up YouTube client
    getYt().catch((err) => console.error("Initial YT warmup failed:", err));
  });

  return app;
}

const appPromise = startServer();
export default appPromise;
