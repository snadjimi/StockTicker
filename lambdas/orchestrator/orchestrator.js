// StockPulse Orchestrator Lambda
// Entry point for GET /brief/{ticker}.
//
// Flow:
//   1. Check DynamoDB for a fresh cached brief (< 5 min old)
//   2. If cache hit → return it immediately
//   3. If cache miss → invoke 4 fetchers in parallel
//   4. Pass all 4 results to the synthesizer
//   5. Return the synthesized brief

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const BRIEFS_TABLE = process.env.BRIEFS_TABLE;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Helper: invoke another Lambda and parse its JSON response
async function invokeLambda(functionName, payload) {
  const command = new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "RequestResponse", // synchronous — wait for result
    Payload: JSON.stringify(payload),
  });
  const response = await lambda.send(command);
  const result = JSON.parse(Buffer.from(response.Payload).toString());
  return result;
}

// Helper: build a standard API Gateway response with CORS headers
function apiResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  // ─── Pre-warm path (triggered by EventBridge cron) ──────────────────
  // When EventBridge fires, it sends { prewarm: true, tickers: [...] }.
  // We loop through and generate briefs to warm the cache.

  if (event.prewarm && Array.isArray(event.tickers)) {
    console.log(`Pre-warming ${event.tickers.length} tickers`);
    await Promise.allSettled(
      event.tickers.map((ticker) => generateBrief(ticker))
    );
    return { statusCode: 200, body: "Pre-warm complete" };
  }

  // ─── API path (triggered by API Gateway) ────────────────────────────

  const ticker = event.pathParameters?.ticker?.toUpperCase();
  if (!ticker || !/^[A-Z.]{1,6}$/.test(ticker)) {
    return apiResponse(400, { error: "Invalid ticker" });
  }

  try {
    // 1. Check cache
    const cached = await getCachedBrief(ticker);
    if (cached) {
      return apiResponse(200, { ...cached, fromCache: true });
    }

    // 2. Cache miss — generate a fresh brief
    const brief = await generateBrief(ticker);
    return apiResponse(200, brief);
  } catch (err) {
    console.error("Orchestrator error:", err);
    return apiResponse(500, { error: "Failed to generate brief" });
  }
};

// ─── Check DynamoDB for a recent cached brief ──────────────────────────

async function getCachedBrief(ticker) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: BRIEFS_TABLE,
      KeyConditionExpression: "ticker = :t",
      ExpressionAttributeValues: { ":t": ticker },
      ScanIndexForward: false, // newest first
      Limit: 1,
    })
  );

  const item = result.Items?.[0];
  if (!item) return null;

  // Is it still fresh?
  const age = Date.now() - new Date(item.timestamp).getTime();
  if (age > CACHE_TTL_MS) return null;

  return item.brief;
}

// ─── Generate a fresh brief (fan out → synthesize) ─────────────────────

async function generateBrief(ticker) {
  // Invoke all 4 fetchers in parallel
  const [news, fundamentals, reddit, options] = await Promise.all([
    invokeLambda("stockpulse-news-fetcher", { ticker }),
    invokeLambda("stockpulse-fundamentals-fetcher", { ticker }),
    invokeLambda("stockpulse-reddit-fetcher", { ticker }),
    invokeLambda("stockpulse-options-fetcher", { ticker }),
  ]);

  // Pass all results to the synthesizer
  const brief = await invokeLambda("stockpulse-synthesizer", {
    ticker,
    news,
    fundamentals,
    reddit,
    options,
  });

  return brief;
}
