// StockPulse Reddit Fetcher Lambda
// Searches r/wallstreetbets and r/investing for ticker mentions, counts
// them, estimates sentiment, and flags whether the ticker is "trending."
//
// Reddit's API needs OAuth: we exchange client credentials for a short-
// lived access token, then call the search endpoint.
//
// Returns the standard fetcher shape:
//   { source, ticker, fetchedAt, data: { ... } }

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const ssm = new SSMClient({});

// Cache credentials + token across warm invocations
let cachedCreds = null;
let cachedToken = null;
let tokenExpiry = 0;

async function getCreds() {
  if (cachedCreds) return cachedCreds;
  const [id, secret] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: "/stockpulse/REDDIT_CLIENT_ID" })),
    ssm.send(new GetParameterCommand({ Name: "/stockpulse/REDDIT_CLIENT_SECRET" })),
  ]);
  cachedCreds = {
    clientId: id.Parameter.Value,
    clientSecret: secret.Parameter.Value,
  };
  return cachedCreds;
}

// ─── OAuth: get an app-only access token ───────────────────────────────

async function getAccessToken() {
  // Reuse token if still valid (Reddit tokens last ~1 hour)
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const { clientId, clientSecret } = await getCreds();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "StockPulse/0.1 by stockpulse-app",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) throw new Error(`Reddit token request failed: ${res.status}`);
  const json = await res.json();

  cachedToken = json.access_token;
  // Refresh 1 minute before actual expiry to be safe
  tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Lightweight sentiment for post titles ─────────────────────────────

const BULLISH = ["moon", "calls", "buy", "long", "bullish", "rocket", "yolo", "squeeze", "pump", "gains"];
const BEARISH = ["puts", "short", "sell", "bearish", "crash", "dump", "drop", "bag", "loss", "rip"];

function scoreTitle(text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of BULLISH) if (lower.includes(w)) score += 1;
  for (const w of BEARISH) if (lower.includes(w)) score -= 1;
  return score;
}

// ─── Search one subreddit for the ticker ───────────────────────────────

async function searchSubreddit(subreddit, ticker, token) {
  const url =
    `https://oauth.reddit.com/r/${subreddit}/search` +
    `?q=${encodeURIComponent(ticker)}&restrict_sr=1&sort=new&limit=50&t=day`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "StockPulse/0.1 by stockpulse-app",
    },
  });
  if (!res.ok) throw new Error(`Reddit search failed: ${res.status}`);
  const json = await res.json();
  return json.data?.children || [];
}

exports.handler = async (event) => {
  const ticker = event.ticker;
  const fetchedAt = new Date().toISOString();

  try {
    const token = await getAccessToken();

    // Search both subreddits in parallel
    const [wsb, investing] = await Promise.all([
      searchSubreddit("wallstreetbets", ticker, token),
      searchSubreddit("investing", ticker, token),
    ]);
    const posts = [...wsb, ...investing];

    // Count mentions and score sentiment
    const mentions = posts.length;
    let sentimentSum = 0;
    for (const post of posts) {
      sentimentSum += scoreTitle(post.data?.title || "");
    }
    // Normalize to 0..1 (0.5 = neutral)
    const polarity = mentions > 0
      ? Math.max(0, Math.min(1, 0.5 + sentimentSum / (mentions * 2)))
      : 0.5;

    // "Trending" if we see a lot of recent posts (rough heuristic)
    const trending = mentions >= 20;

    return {
      source: "reddit",
      ticker,
      fetchedAt,
      data: {
        redditMentions: mentions,
        sentimentPolarity: +polarity.toFixed(2),
        trending,
        subreddits: {
          wallstreetbets: wsb.length,
          investing: investing.length,
        },
      },
    };
  } catch (err) {
    console.error("Reddit fetcher error:", err);
    return {
      source: "reddit",
      ticker,
      fetchedAt,
      data: {
        redditMentions: 0,
        sentimentPolarity: 0.5,
        trending: false,
        subreddits: { wallstreetbets: 0, investing: 0 },
      },
      error: err.message,
    };
  }
};
