// StockPulse Fundamentals Fetcher Lambda
// Pulls financial fundamentals for a ticker from Polygon.io:
// price, P/E, EPS, revenue growth, profit margin, debt ratio.
//
// Returns the standard fetcher shape:
//   { source, ticker, fetchedAt, data: { ... } }

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const ssm = new SSMClient({});

let cachedApiKey = null;
async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const result = await ssm.send(
    new GetParameterCommand({ Name: "/stockpulse/POLYGON_API_KEY" })
  );
  cachedApiKey = result.Parameter.Value;
  return cachedApiKey;
}

// Helper: fetch JSON or throw
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon returned ${res.status} for ${url}`);
  return res.json();
}

exports.handler = async (event) => {
  const ticker = event.ticker;
  const fetchedAt = new Date().toISOString();

  try {
    const apiKey = await getApiKey();

    // ─── 1. Latest price (previous day's close) ──────────────────────
    const prevUrl =
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?apiKey=${apiKey}`;
    const prevJson = await fetchJson(prevUrl);
    const bar = prevJson.results?.[0] || {};
    const price = bar.c ?? null;       // close
    const prevClose = bar.o ?? null;   // open (proxy for prior day)
    const change = price && prevClose ? price - prevClose : 0;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    // ─── 2. Financials (income statement, balance sheet) ─────────────
    const finUrl =
      `https://api.polygon.io/vX/reference/financials` +
      `?ticker=${ticker}&limit=2&timeframe=annual&apiKey=${apiKey}`;
    const finJson = await fetchJson(finUrl);
    const reports = finJson.results || [];
    const latest = reports[0]?.financials || {};
    const prior = reports[1]?.financials || {};

    // Pull individual line items (Polygon nests these deeply)
    const netIncome = latest.income_statement?.net_income_loss?.value ?? null;
    const revenue = latest.income_statement?.revenues?.value ?? null;
    const priorRevenue = prior.income_statement?.revenues?.value ?? null;
    const basicEps = latest.income_statement?.basic_earnings_per_share?.value ?? null;
    const totalAssets = latest.balance_sheet?.assets?.value ?? null;
    const totalLiabilities = latest.balance_sheet?.liabilities?.value ?? null;

    // ─── 3. Derived metrics ──────────────────────────────────────────
    const pe = price && basicEps ? +(price / basicEps).toFixed(2) : null;
    const margin = netIncome && revenue
      ? `${((netIncome / revenue) * 100).toFixed(1)}%`
      : null;
    const revenueGrowth = revenue && priorRevenue
      ? `${(((revenue - priorRevenue) / priorRevenue) * 100).toFixed(1)}% YoY`
      : null;
    const debtRatio = totalLiabilities && totalAssets
      ? +(totalLiabilities / totalAssets).toFixed(2)
      : null;

    return {
      source: "fundamentals",
      ticker,
      fetchedAt,
      data: {
        price,
        change: +change.toFixed(2),
        changePct: +changePct.toFixed(2),
        pe,
        eps: basicEps,
        revenueGrowth,
        margin,
        debtRatio,
      },
    };
  } catch (err) {
    console.error("Fundamentals fetcher error:", err);
    return {
      source: "fundamentals",
      ticker,
      fetchedAt,
      data: {
        price: null, change: 0, changePct: 0,
        pe: null, eps: null, revenueGrowth: null,
        margin: null, debtRatio: null,
      },
      error: err.message,
    };
  }
};
