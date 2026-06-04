// StockPulse News Fetcher Lambda
// Pulls recent news headlines for a ticker from Polygon.io and computes
// a simple sentiment score from the headline text.
//
// Returns the standard fetcher shape:
//   { source, ticker, fetchedAt, data: { ... } }

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const ssm = new SSMClient({});

// Cache the API key across warm invocations so we don't hit SSM every time
let cachedApiKey = null;

async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const result = await ssm.send(
    new GetParameterCommand({ Name: "/stockpulse/POLYGON_API_KEY" })
  );
  cachedApiKey = result.Parameter.Value;
  return cachedApiKey;
}

// ─── Lightweight headline sentiment ────────────────────────────────────
// Not ML — just keyword scoring. The synthesizer (Claude) does the real
// reasoning. This gives a rough polarity to pass along.

const POSITIVE_WORDS = [
  "beat", "beats", "surge", "soar", "rally", "gains", "upgrade", "bullish",
  "record", "growth", "profit", "strong", "rises", "jumps", "boost", "wins",
  "outperform", "buy", "raises", "expands",
];
const NEGATIVE_WORDS = [
  "miss", "misses", "plunge", "drop", "falls", "decline", "downgrade",
  "bearish", "loss", "losses", "weak", "cuts", "lawsuit", "probe", "warns",
  "slumps", "tumbles", "sell", "concerns", "risk",
];

function scoreHeadline(text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of POSITIVE_WORDS) if (lower.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (lower.includes(w)) score -= 1;
  return score;
}

exports.handler = async (event) => {
  const ticker = event.ticker;
  const fetchedAt = new Date().toISOString();

  try {
    const apiKey = await getApiKey();

    // Polygon news endpoint — most recent 10 articles for the ticker
    const url =
      `https://api.polygon.io/v2/reference/news` +
      `?ticker=${ticker}&limit=10&order=desc&apiKey=${apiKey}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Polygon news returned ${response.status}`);
    const json = await response.json();

    const articles = (json.results || []).map((a) => ({
      title: a.title,
      publisher: a.publisher?.name || "Unknown",
      url: a.article_url,
      publishedAt: a.published_utc,
      sentiment: scoreHeadline(a.title || ""),
    }));

    // Aggregate sentiment across all headlines, normalized to -1..1
    const totalScore = articles.reduce((sum, a) => sum + a.sentiment, 0);
    const maxPossible = Math.max(articles.length, 1) * 2;
    const normalizedSentiment = Math.max(-1, Math.min(1, totalScore / maxPossible));

    return {
      source: "news",
      ticker,
      fetchedAt,
      data: {
        articleCount: articles.length,
        headlines: articles.slice(0, 5),
        aggregateSentiment: normalizedSentiment,
      },
    };
  } catch (err) {
    console.error("News fetcher error:", err);
    // Return a valid (empty) shape so the orchestrator doesn't break
    return {
      source: "news",
      ticker,
      fetchedAt,
      data: { articleCount: 0, headlines: [], aggregateSentiment: 0 },
      error: err.message,
    };
  }
};
