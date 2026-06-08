// StockPulse Background Service Worker
// Runs behind the scenes. Handles two jobs:
//   1. FETCH_BRIEF  — get stock data for a ticker (cache or API)
//   2. LOG_SIGNAL   — record a sentiment prediction for backtesting

// ─── In-memory cache (5-minute TTL) ────────────────────────────────────
// Avoids hammering the API when the user opens/closes the popup repeatedly.

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

function getCached(ticker) {
  const entry = cache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(ticker);
    return null;
  }
  return entry.data;
}

function setCache(ticker, data) {
  cache.set(ticker, { data, timestamp: Date.now() });
}

// ─── API configuration ─────────────────────────────────────────────────
// Replace this URL after deploying the AWS CDK stack (Phase 2).

const API_BASE = "https://07rgqv2muc.execute-api.us-east-1.amazonaws.com/prod";

// ─── Fetch brief from API (or mock) ────────────────────────────────────

async function fetchBrief(ticker) {
  // Check cache first
  const cached = getCached(ticker);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  try {
    const response = await fetch(`${API_BASE}/brief/${ticker}`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    setCache(ticker, data);
    return data;
  } catch (error) {
    // API not deployed yet — fall back to mock data
    console.log(`StockPulse: API unavailable, using mock data for ${ticker}`);
    const mock = getMockBrief(ticker);
    setCache(ticker, mock);
    return mock;
  }
}

// ─── Mock data ─────────────────────────────────────────────────────────
// Matches the real API contract exactly. AAPL is fully fleshed out;
// any other ticker gets a placeholder so the UI is still testable.

function getMockBrief(ticker) {
  const now = new Date().toISOString();

  if (ticker === "AAPL") {
    return {
      ticker: "AAPL",
      name: "Apple Inc.",
      price: 189.43,
      change: 1.24,
      changePct: 0.66,
      sentiment: { label: "Bullish", score: 72, confidence: "high" },
      summary:
        "Apple shows strong momentum heading into its services revenue cycle. " +
        "Institutional accumulation and positive options flow suggest confidence " +
        "in the upcoming earnings report, though valuation remains stretched.",
      risks: [
        "iPhone sales growth slowing in key China market",
        "Antitrust regulation could force App Store fee changes",
        "Valuation premium leaves little room for earnings miss",
      ],
      bullCases: [
        "Services revenue growing 18% YoY with expanding margins",
        "Vision Pro creating new product category with enterprise traction",
        "Record share buyback program reducing float by 3% annually",
      ],
      fundamentals: {
        pe: 29.2,
        eps: 6.43,
        revenueGrowth: "+8.1% YoY",
        margin: "26.4%",
        debtRatio: 0.32,
      },
      social: {
        redditMentions: 847,
        mentionChange: "+34% vs 30d avg",
        sentimentPolarity: 0.68,
        trending: true,
      },
      options: {
        callPutRatio: 1.84,
        unusualActivity: true,
        unusualNote: "Large block of Dec $200 calls swept at ask",
        impliedVolatility: "22.4%",
      },
      signals: [
        { type: "bullish", text: "Options flow heavily favoring calls" },
        { type: "bullish", text: "Reddit sentiment surging +34%" },
        { type: "bearish", text: "P/E above sector median" },
      ],
      cachedAt: now,
      fromCache: false,
    };
  }

  // Generic placeholder for any other ticker
  return {
    ticker,
    name: `${ticker} Inc.`,
    price: 100.0,
    change: 0.5,
    changePct: 0.5,
    sentiment: { label: "Neutral", score: 50, confidence: "low" },
    summary: `Mock data for ${ticker}. Connect the AWS backend to get real AI-powered analysis.`,
    risks: ["Mock risk 1", "Mock risk 2", "Mock risk 3"],
    bullCases: ["Mock bull case 1", "Mock bull case 2", "Mock bull case 3"],
    fundamentals: {
      pe: 20.0,
      eps: 5.0,
      revenueGrowth: "+5.0% YoY",
      margin: "20.0%",
      debtRatio: 0.5,
    },
    social: {
      redditMentions: 100,
      mentionChange: "+0% vs 30d avg",
      sentimentPolarity: 0.5,
      trending: false,
    },
    options: {
      callPutRatio: 1.0,
      unusualActivity: false,
      unusualNote: "No unusual activity detected",
      impliedVolatility: "30.0%",
    },
    signals: [{ type: "neutral", text: "Insufficient data for signal" }],
    cachedAt: now,
    fromCache: false,
  };
}

// ─── Message listener ──────────────────────────────────────────────────
// The popup sends messages here. We route them to the right handler.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_BRIEF") {
    // fetchBrief is async, so we call it and use .then() to respond
    fetchBrief(message.ticker)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // tells Chrome to keep the channel open for async response
  }

  if (message.type === "LOG_SIGNAL") {
    // Phase 4: will POST to /signal endpoint for backtesting
    console.log("StockPulse: Signal logged", message.signal);
    sendResponse({ success: true });
    return true;
  }
});
