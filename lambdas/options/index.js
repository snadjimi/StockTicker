// StockPulse Options Fetcher Lambda
// Pulls options data for a ticker from Polygon.io: call/put ratio,
// unusual volume detection, and implied volatility.
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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon returned ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  const ticker = event.ticker;
  const fetchedAt = new Date().toISOString();

  try {
    const apiKey = await getApiKey();

    // ─── Options snapshot ────────────────────────────────────────────
    // Returns all active option contracts with greeks, volume, and IV.
    const url =
      `https://api.polygon.io/v3/snapshot/options/${ticker}` +
      `?limit=250&apiKey=${apiKey}`;
    const json = await fetchJson(url);
    const contracts = json.results || [];

    let callVolume = 0;
    let putVolume = 0;
    let ivSum = 0;
    let ivCount = 0;
    const highVolumeContracts = [];

    for (const c of contracts) {
      const type = c.details?.contract_type;     // "call" or "put"
      const volume = c.day?.volume || 0;
      const openInterest = c.open_interest || 0;
      const iv = c.implied_volatility;

      if (type === "call") callVolume += volume;
      if (type === "put") putVolume += volume;

      if (typeof iv === "number") {
        ivSum += iv;
        ivCount += 1;
      }

      // Unusual = today's volume far exceeds standing open interest
      if (openInterest > 0 && volume > openInterest * 3 && volume > 500) {
        highVolumeContracts.push({
          strike: c.details?.strike_price,
          type,
          expiry: c.details?.expiration_date,
          volume,
          openInterest,
        });
      }
    }

    // ─── Derived metrics ─────────────────────────────────────────────
    const callPutRatio = putVolume > 0
      ? +(callVolume / putVolume).toFixed(2)
      : callVolume > 0 ? 99 : 0;

    const avgIv = ivCount > 0
      ? `${((ivSum / ivCount) * 100).toFixed(1)}%`
      : null;

    const unusualActivity = highVolumeContracts.length > 0;

    // Build a human-readable note about the most unusual contract
    let unusualNote = "No unusual activity detected";
    if (unusualActivity) {
      const top = highVolumeContracts.sort((a, b) => b.volume - a.volume)[0];
      unusualNote =
        `Heavy volume on $${top.strike} ${top.type}s ` +
        `(${top.volume.toLocaleString()} vs ${top.openInterest.toLocaleString()} OI)`;
    }

    return {
      source: "options",
      ticker,
      fetchedAt,
      data: {
        callPutRatio,
        unusualActivity,
        unusualNote,
        impliedVolatility: avgIv,
        contractsAnalyzed: contracts.length,
      },
    };
  } catch (err) {
    console.error("Options fetcher error:", err);
    return {
      source: "options",
      ticker,
      fetchedAt,
      data: {
        callPutRatio: null,
        unusualActivity: false,
        unusualNote: "Options data unavailable",
        impliedVolatility: null,
        contractsAnalyzed: 0,
      },
      error: err.message,
    };
  }
};
