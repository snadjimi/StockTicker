// StockPulse Fundamentals Fetcher Lambda
// Pulls financial fundamentals for a ticker from Polygon.io:
// price, P/E, EPS, revenue growth, profit margin, debt ratio.
//
// Returns the standard fetcher shape:
//   { source, ticker, fetchedAt, data: { ... } }
//
// data.available is false when the price could not be fetched;
// data.financialsAvailable is false when the financial fields could not.
// Unavailable values are null, never 0.

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

// Thrown when Polygon says our plan can't access an endpoint (403).
class PlanUnavailableError extends Error {}

// Helper: fetch JSON or throw
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const path = new URL(url).pathname; // never log the apiKey query param
    const message = `Polygon returned ${res.status} for ${path}`;
    if (res.status === 403) throw new PlanUnavailableError(message);
    throw new Error(message);
  }
  return res.json();
}

// Plan-restricted endpoints fail on every call, so warn once per container
// instead of logging an error each time (that would trip the log-error alarm).
const warned = new Set();
function logFailure(label, err) {
  if (err instanceof PlanUnavailableError) {
    if (warned.has(label)) return;
    warned.add(label);
    console.warn(`Fundamentals ${label} unavailable on current Polygon plan: ${err.message}`);
    return;
  }
  console.error(`Fundamentals fetcher error (${label}):`, err);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ─── Price: last two daily bars → close and change vs previous close ──

async function fetchPrice(ticker, apiKey) {
  // Look back far enough to always span two trading days (weekends, holidays)
  const to = new Date();
  const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000);
  const url =
    `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/` +
    `${isoDate(from)}/${isoDate(to)}?adjusted=true&sort=desc&limit=2&apiKey=${apiKey}`;
  const json = await fetchJson(url);
  const [latest, previous] = json.results || [];
  if (latest?.c == null) throw new Error(`No daily bars returned for ${ticker}`);

  const price = latest.c;
  const prevClose = previous?.c ?? null;
  const change = prevClose != null ? price - prevClose : null;
  const changePct = prevClose ? (change / prevClose) * 100 : null;

  return {
    price,
    change: change != null ? +change.toFixed(2) : null,
    changePct: changePct != null ? +changePct.toFixed(2) : null,
    asOf: isoDate(new Date(latest.t)), // trading day of the latest bar
  };
}

// ─── Financials (income statement, balance sheet) ─────────────────────

async function fetchFinancials(ticker, apiKey, price) {
  const url =
    `https://api.polygon.io/vX/reference/financials` +
    `?ticker=${ticker}&limit=2&timeframe=annual&apiKey=${apiKey}`;
  const json = await fetchJson(url);
  const reports = json.results || [];
  if (reports.length === 0) throw new Error(`No financial reports returned for ${ticker}`);

  const latest = reports[0]?.financials || {};
  const prior = reports[1]?.financials || {};

  // Pull individual line items (Polygon nests these deeply)
  const netIncome = latest.income_statement?.net_income_loss?.value ?? null;
  const revenue = latest.income_statement?.revenues?.value ?? null;
  const priorRevenue = prior.income_statement?.revenues?.value ?? null;
  const basicEps = latest.income_statement?.basic_earnings_per_share?.value ?? null;
  const totalAssets = latest.balance_sheet?.assets?.value ?? null;
  const totalLiabilities = latest.balance_sheet?.liabilities?.value ?? null;

  // Derived metrics
  return {
    pe: price && basicEps ? +(price / basicEps).toFixed(2) : null,
    eps: basicEps,
    revenueGrowth: revenue && priorRevenue
      ? `${(((revenue - priorRevenue) / priorRevenue) * 100).toFixed(1)}% YoY`
      : null,
    margin: netIncome && revenue
      ? `${((netIncome / revenue) * 100).toFixed(1)}%`
      : null,
    debtRatio: totalLiabilities && totalAssets
      ? +(totalLiabilities / totalAssets).toFixed(2)
      : null,
  };
}

const NO_PRICE = { price: null, change: null, changePct: null, asOf: null };
const NO_FINANCIALS = { pe: null, eps: null, revenueGrowth: null, margin: null, debtRatio: null };

exports.handler = async (event) => {
  const ticker = event.ticker;
  const fetchedAt = new Date().toISOString();
  const errors = [];

  let apiKey;
  try {
    apiKey = await getApiKey();
  } catch (err) {
    console.error("Fundamentals fetcher error (api key):", err);
    return {
      source: "fundamentals",
      ticker,
      fetchedAt,
      data: { ...NO_PRICE, ...NO_FINANCIALS, available: false, financialsAvailable: false },
      error: err.message,
    };
  }

  // Price and financials fail independently, so one can't wipe out the other.
  let priceData = NO_PRICE;
  let available = true;
  try {
    priceData = await fetchPrice(ticker, apiKey);
  } catch (err) {
    available = false;
    errors.push(err.message);
    logFailure("price", err);
  }

  let financials = NO_FINANCIALS;
  let financialsAvailable = true;
  try {
    financials = await fetchFinancials(ticker, apiKey, priceData.price);
  } catch (err) {
    financialsAvailable = false;
    errors.push(err.message);
    logFailure("financials", err);
  }

  return {
    source: "fundamentals",
    ticker,
    fetchedAt,
    data: { ...priceData, ...financials, available, financialsAvailable },
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
};
