// StockPulse Synthesizer Lambda
// The "brain" of the system. Takes the 4 raw fetcher results, asks Claude
// to reason over them, and produces the final brief the extension renders.
//
// Two kinds of fields make up a brief:
//   • Deterministic — numbers copied straight from the fetchers (price, P/E,
//     call/put ratio…). We NEVER let the AI invent these.
//   • Reasoned — the judgment calls (sentiment, summary, risks, bull cases,
//     signals). These come from Claude.
//
// It also persists two things to DynamoDB:
//   • the brief  → so the orchestrator's 5-min cache works
//   • a signal   → a timestamped prediction we grade later (Phase 4 backtest)
//
// Returns the brief object that background.js expects (shape matches the mock).

const { randomUUID } = require("crypto");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const Anthropic = require("@anthropic-ai/sdk");
const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");
const { z } = require("zod/v4");

const ssm = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BRIEFS_TABLE = process.env.BRIEFS_TABLE;
const SIGNALS_TABLE = process.env.SIGNALS_TABLE;

// How long DynamoDB keeps a cached brief before auto-deleting it (TTL).
// The orchestrator only treats briefs < 5 min old as "fresh"; we keep the
// row around for an hour so repeated lookups stay cheap, then let it expire.
const BRIEF_TTL_SECONDS = 60 * 60; // 1 hour

// ─── Claude client (API key cached across warm invocations) ─────────────

let cachedClient = null;
async function getClient() {
  if (cachedClient) return cachedClient;
  const result = await ssm.send(
    new GetParameterCommand({
      Name: "/stockpulse/ANTHROPIC_API_KEY",
      WithDecryption: true,
    })
  );
  cachedClient = new Anthropic({ apiKey: result.Parameter.Value });
  return cachedClient;
}

// ─── The shape we force Claude to return ────────────────────────────────
// messages.parse() + this schema guarantees valid JSON in exactly this form.
// We only ask Claude for the *reasoned* fields — never the raw numbers.

const BriefAnalysisSchema = z.object({
  name: z.string().describe("The company's full name, e.g. 'Apple Inc.'"),
  sentiment: z.object({
    label: z.enum(["Bullish", "Bearish", "Neutral"]),
    score: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe("0 = maximally bearish, 50 = neutral, 100 = maximally bullish"),
    confidence: z.enum(["high", "medium", "low"]),
  }),
  summary: z
    .string()
    .describe("2-3 sentence plain-English synthesis of the whole picture"),
  risks: z.array(z.string()).length(3).describe("Three concrete bearish risks"),
  bullCases: z
    .array(z.string())
    .length(3)
    .describe("Three concrete bullish arguments"),
  signals: z
    .array(
      z.object({
        type: z.enum(["bullish", "bearish", "neutral"]),
        text: z.string(),
      })
    )
    .min(2)
    .max(4)
    .describe("Short signal tags drawn from the strongest data points"),
});

// ─── Build the prompt from the 4 fetcher results ────────────────────────
// We hand Claude a clean, compact view of the data and ask it to reason.

function buildUserPrompt(ticker, news, fundamentals, reddit, options) {
  // Pull the inner `data` blobs (each fetcher wraps its payload in `.data`)
  const f = fundamentals?.data || {};
  const n = news?.data || {};
  const r = reddit?.data || {};
  const o = options?.data || {};

  return [
    `Analyze the stock ${ticker} using the data below and produce an investment brief.`,
    ``,
    `## Fundamentals`,
    `Price: ${f.price ?? "n/a"} (change ${f.change ?? 0}, ${f.changePct ?? 0}%)`,
    `P/E: ${f.pe ?? "n/a"} | EPS: ${f.eps ?? "n/a"} | Margin: ${f.margin ?? "n/a"}`,
    `Revenue growth: ${f.revenueGrowth ?? "n/a"} | Debt ratio: ${f.debtRatio ?? "n/a"}`,
    ``,
    `## News (last 24h)`,
    `Articles: ${n.articleCount ?? 0} | Aggregate sentiment (-1..1): ${n.aggregateSentiment ?? 0}`,
    `Headlines: ${(n.headlines || []).slice(0, 5).join(" | ") || "none"}`,
    ``,
    `## Reddit buzz`,
    `Mentions: ${r.redditMentions ?? 0} | Polarity (0..1): ${r.sentimentPolarity ?? 0.5} | Trending: ${r.trending ?? false}`,
    ``,
    `## Options activity`,
    `Call/Put ratio: ${o.callPutRatio ?? "n/a"} | Implied vol: ${o.impliedVolatility ?? "n/a"}`,
    `Unusual activity: ${o.unusualActivity ?? false} — ${o.unusualNote ?? "none"}`,
    ``,
    `Weigh these signals against each other. A high P/E is a risk even when`,
    `momentum is strong. Confirmation across sources (e.g. retail buzz + call`,
    `buying) raises confidence. Be specific and avoid generic filler.`,
  ].join("\n");
}

const SYSTEM_PROMPT =
  "You are a sharp equity analyst writing concise, balanced stock briefs. " +
  "You synthesize fundamentals, news, social buzz, and options flow into a " +
  "single coherent view. You are honest about uncertainty and never invent " +
  "numbers — reason only from the data provided.";

// ─── Main handler ───────────────────────────────────────────────────────

exports.handler = async (event) => {
  const { ticker, news, fundamentals, reddit, options } = event;
  const fetchedAt = new Date().toISOString();

  // Deterministic fields — copied straight from the fetchers, no AI.
  const f = fundamentals?.data || {};
  const r = reddit?.data || {};
  const o = options?.data || {};

  try {
    const client = await getClient();

    // ─── Ask Claude to reason over the data ───────────────────────────
    const response = await client.messages.parse({
      model: "claude-haiku-4-5",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(ticker, news, fundamentals, reddit, options),
        },
      ],
      output_config: {
        format: zodOutputFormat(BriefAnalysisSchema),
      },
    });

    const ai = response.parsed_output;
    if (!ai) throw new Error("Claude returned no parseable analysis");

    // ─── Assemble the final brief (AI reasoning + raw numbers) ─────────
    const brief = {
      ticker,
      name: ai.name,
      price: f.price ?? null,
      change: f.change ?? 0,
      changePct: f.changePct ?? 0,
      sentiment: ai.sentiment,
      summary: ai.summary,
      risks: ai.risks,
      bullCases: ai.bullCases,
      fundamentals: {
        pe: f.pe ?? null,
        eps: f.eps ?? null,
        revenueGrowth: f.revenueGrowth ?? null,
        margin: f.margin ?? null,
        debtRatio: f.debtRatio ?? null,
      },
      social: {
        redditMentions: r.redditMentions ?? 0,
        mentionChange: "n/a", // 30-day baseline not tracked yet (future work)
        sentimentPolarity: r.sentimentPolarity ?? 0.5,
        trending: r.trending ?? false,
      },
      options: {
        callPutRatio: o.callPutRatio ?? null,
        unusualActivity: o.unusualActivity ?? false,
        unusualNote: o.unusualNote ?? "No unusual activity detected",
        impliedVolatility: o.impliedVolatility ?? null,
      },
      signals: ai.signals,
      cachedAt: fetchedAt,
      fromCache: false,
    };

    // Skip persistence when price is missing (usually a rate-limited fetch)
    // so the bad result isn't cached — the next request retries fresh.
    if (f.price != null) {
      await Promise.all([
        cacheBrief(ticker, fetchedAt, brief),
        logSignal(ticker, fetchedAt, brief),
      ]);
    }

    return brief;
  } catch (err) {
    console.error("Synthesizer error:", err);
    // Degrade gracefully: still return the raw numbers with a flat AI layer
    // so the extension can render *something* instead of an error screen.
    return {
      ticker,
      name: `${ticker}`,
      price: f.price ?? null,
      change: f.change ?? 0,
      changePct: f.changePct ?? 0,
      sentiment: { label: "Neutral", score: 50, confidence: "low" },
      summary: "AI analysis is temporarily unavailable. Showing raw data only.",
      risks: [],
      bullCases: [],
      fundamentals: {
        pe: f.pe ?? null,
        eps: f.eps ?? null,
        revenueGrowth: f.revenueGrowth ?? null,
        margin: f.margin ?? null,
        debtRatio: f.debtRatio ?? null,
      },
      social: {
        redditMentions: r.redditMentions ?? 0,
        mentionChange: "n/a",
        sentimentPolarity: r.sentimentPolarity ?? 0.5,
        trending: r.trending ?? false,
      },
      options: {
        callPutRatio: o.callPutRatio ?? null,
        unusualActivity: o.unusualActivity ?? false,
        unusualNote: o.unusualNote ?? "No unusual activity detected",
        impliedVolatility: o.impliedVolatility ?? null,
      },
      signals: [{ type: "neutral", text: "Insufficient data for signal" }],
      cachedAt: fetchedAt,
      fromCache: false,
      error: err.message,
    };
  }
};

// ─── DynamoDB writers ───────────────────────────────────────────────────

// Cache the brief so the orchestrator can serve it without re-synthesizing.
async function cacheBrief(ticker, timestamp, brief) {
  if (!BRIEFS_TABLE) return; // table not wired up yet — skip silently
  await ddb.send(
    new PutCommand({
      TableName: BRIEFS_TABLE,
      Item: {
        ticker, // partition key
        timestamp, // sort key (ISO string, newest sorts last)
        ttl: Math.floor(Date.now() / 1000) + BRIEF_TTL_SECONDS, // auto-expire
        brief,
      },
    })
  );
}

// Log a timestamped prediction. Phase 4 grades these against future price
// moves to compute the backtested accuracy of our sentiment signal.
async function logSignal(ticker, timestamp, brief) {
  if (!SIGNALS_TABLE) return;
  await ddb.send(
    new PutCommand({
      TableName: SIGNALS_TABLE,
      Item: {
        ticker, // partition key
        signalId: randomUUID(), // sort key
        timestamp,
        sentimentLabel: brief.sentiment.label,
        sentimentScore: brief.sentiment.score,
        priceAtSignal: brief.price,
        callPutRatio: brief.options.callPutRatio,
        redditPolarity: brief.social.sentimentPolarity,
        // graded later (Phase 4): priceLater, correct, returnPct
      },
    })
  );
}
