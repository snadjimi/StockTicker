// StockPulse Grader Lambda
// The other half of the backtest. The synthesizer LOGS predictions; this
// Lambda GRADES them once enough time has passed to see what the price did.
//
// Runs on a schedule (EventBridge). Each run:
//   1. Finds signals that are old enough to grade and not yet graded
//   2. Looks up the current price for each ticker
//   3. Computes the return since the signal, and whether we were "right"
//   4. Writes the result back onto the signal row
//
// "Right" means the direction matched:
//   • Bullish  → correct if the price went UP
//   • Bearish  → correct if the price went DOWN
//   • Neutral  → graded but excluded from accuracy (correct = null)

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const ssm = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNALS_TABLE = process.env.SIGNALS_TABLE;

// How long a prediction must "season" before we judge it. A signal logged
// today tells us nothing about the future yet — we wait this many days.
const MATURATION_DAYS = 7;

// ─── Polygon API key (cached across warm invocations) ───────────────────

let cachedApiKey = null;
async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const result = await ssm.send(
    new GetParameterCommand({ Name: "/stockpulse/POLYGON_API_KEY" })
  );
  cachedApiKey = result.Parameter.Value;
  return cachedApiKey;
}

// Fetch the latest (previous close) price for a ticker.
async function fetchCurrentPrice(ticker, apiKey) {
  const url =
    `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon returned ${res.status} for ${ticker}`);
  const json = await res.json();
  return json.results?.[0]?.c ?? null; // close price
}

// ─── Main handler ───────────────────────────────────────────────────────

exports.handler = async () => {
  if (!SIGNALS_TABLE) {
    return { graded: 0, skipped: 0, note: "SIGNALS_TABLE not configured" };
  }

  const apiKey = await getApiKey();

  // Cutoff: only grade signals older than the maturation window.
  const cutoff = new Date(
    Date.now() - MATURATION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // 1. Find ungraded, matured signals.
  //    (Scan is fine here — portfolio-scale volume, runs off-peak on a cron.)
  const matured = await scanUngradedSignals(cutoff);

  // Cache prices per-ticker so we hit Polygon once per symbol, not per signal.
  const priceCache = new Map();
  let graded = 0;
  let skipped = 0;

  for (const sig of matured) {
    try {
      // No baseline price recorded → can't compute a return. Mark graded so
      // we don't keep re-scanning it forever, but leave correctness null.
      if (sig.priceAtSignal == null) {
        await markGraded(sig, { priceLater: null, returnPct: null, correct: null });
        skipped += 1;
        continue;
      }

      // Look up current price (cached per ticker).
      let priceLater = priceCache.get(sig.ticker);
      if (priceLater === undefined) {
        priceLater = await fetchCurrentPrice(sig.ticker, apiKey);
        priceCache.set(sig.ticker, priceLater);
      }
      if (priceLater == null) {
        skipped += 1;
        continue; // leave ungraded — retry on the next run
      }

      const returnPct = +(
        ((priceLater - sig.priceAtSignal) / sig.priceAtSignal) *
        100
      ).toFixed(2);
      const correct = judge(sig.sentimentLabel, returnPct);

      await markGraded(sig, { priceLater, returnPct, correct });
      graded += 1;
    } catch (err) {
      console.error(`Failed to grade ${sig.ticker}/${sig.signalId}:`, err);
      skipped += 1;
    }
  }

  console.log(`Grader run complete: graded=${graded}, skipped=${skipped}`);
  return { graded, skipped, scanned: matured.length };
};

// ─── Was the prediction right? ──────────────────────────────────────────
// Returns true / false for directional calls, null for neutral.

function judge(label, returnPct) {
  if (label === "Bullish") return returnPct > 0;
  if (label === "Bearish") return returnPct < 0;
  return null; // Neutral — not counted toward accuracy
}

// ─── DynamoDB helpers ───────────────────────────────────────────────────

// Scan the table for signals that haven't been graded and have matured.
// Handles pagination so we don't silently miss rows past the 1MB page limit.
async function scanUngradedSignals(cutoff) {
  const items = [];
  let lastKey;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: SIGNALS_TABLE,
        FilterExpression:
          "attribute_not_exists(graded) AND #ts < :cutoff",
        ExpressionAttributeNames: { "#ts": "timestamp" }, // reserved word
        ExpressionAttributeValues: { ":cutoff": cutoff },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

// Write the grading result back onto the signal row.
async function markGraded(sig, { priceLater, returnPct, correct }) {
  await ddb.send(
    new UpdateCommand({
      TableName: SIGNALS_TABLE,
      Key: { ticker: sig.ticker, signalId: sig.signalId },
      UpdateExpression:
        "SET graded = :g, gradedAt = :at, priceLater = :pl, returnPct = :r, correct = :c",
      ExpressionAttributeValues: {
        ":g": true,
        ":at": new Date().toISOString(),
        ":pl": priceLater,
        ":r": returnPct,
        ":c": correct,
      },
    })
  );
}
