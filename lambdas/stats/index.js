const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNALS_TABLE = process.env.SIGNALS_TABLE;

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

exports.handler = async () => {
  try {
    const signals = await scanAllSignals();

    const bull = { count: 0, correct: 0, returnSum: 0 };
    const bear = { count: 0, correct: 0, returnSum: 0 };
    let neutralCount = 0;
    let pending = 0;
    let correctReturnSum = 0;
    let correctCount = 0;
    let wrongReturnSum = 0;
    let wrongCount = 0;

    for (const s of signals) {
      if (!s.graded) {
        pending += 1;
        continue;
      }

      if (s.sentimentLabel === "Neutral" || s.correct === null) {
        neutralCount += 1;
        continue;
      }

      const bucket = s.sentimentLabel === "Bullish" ? bull : bear;
      bucket.count += 1;
      if (s.correct === true) bucket.correct += 1;
      if (typeof s.returnPct === "number") bucket.returnSum += s.returnPct;

      if (typeof s.returnPct === "number") {
        if (s.correct === true) {
          correctReturnSum += s.returnPct;
          correctCount += 1;
        } else {
          wrongReturnSum += s.returnPct;
          wrongCount += 1;
        }
      }
    }

    const directionalCount = bull.count + bear.count;
    const directionalCorrect = bull.correct + bear.correct;

    const stats = {
      generatedAt: new Date().toISOString(),
      totals: {
        signals: signals.length,
        graded: directionalCount + neutralCount,
        pending,
      },
      accuracy: {
        overall: rate(directionalCorrect, directionalCount),
        bullish: rate(bull.correct, bull.count),
        bearish: rate(bear.correct, bear.count),
        sampleSize: directionalCount,
      },
      avgReturn: {
        overall: avg(bull.returnSum + bear.returnSum, directionalCount),
        whenCorrect: avg(correctReturnSum, correctCount),
        whenWrong: avg(wrongReturnSum, wrongCount),
      },
      bySentiment: {
        bullish: { count: bull.count, correct: bull.correct, accuracy: rate(bull.correct, bull.count) },
        bearish: { count: bear.count, correct: bear.correct, accuracy: rate(bear.correct, bear.count) },
        neutral: { count: neutralCount },
      },
      recent: recentSignals(signals, 20),
    };

    return apiResponse(200, stats);
  } catch (err) {
    console.error("Stats error:", err);
    return apiResponse(500, { error: "Failed to compute stats" });
  }
};

function rate(correct, total) {
  return total > 0 ? +(correct / total).toFixed(3) : null;
}

function avg(sum, count) {
  return count > 0 ? +(sum / count).toFixed(2) : null;
}

function recentSignals(signals, n) {
  return [...signals]
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, n)
    .map((s) => ({
      ticker: s.ticker,
      timestamp: s.timestamp,
      sentimentLabel: s.sentimentLabel,
      sentimentScore: s.sentimentScore,
      graded: !!s.graded,
      correct: s.correct ?? null,
      returnPct: typeof s.returnPct === "number" ? s.returnPct : null,
    }));
}

async function scanAllSignals() {
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: SIGNALS_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}
