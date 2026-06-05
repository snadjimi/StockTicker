import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export class StockPulseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── DynamoDB Tables ───────────────────────────────────────────────
    // Briefs table: caches AI-generated stock briefs for 5 minutes
    // so we don't re-fetch for every popup open.

    const briefsTable = new dynamodb.Table(this, "BriefsTable", {
      tableName: "stockpulse-briefs",
      partitionKey: { name: "ticker", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Signals table: stores sentiment predictions for backtesting.
    // Each signal records what we predicted and what actually happened.

    const signalsTable = new dynamodb.Table(this, "SignalsTable", {
      tableName: "stockpulse-signals",
      partitionKey: { name: "ticker", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "signalId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── SSM Parameters (placeholders for API keys) ────────────────────
    // These are empty placeholders. You'll fill them in the AWS console
    // with your real keys before the Lambdas can work.

    new ssm.StringParameter(this, "PolygonApiKey", {
      parameterName: "/stockpulse/POLYGON_API_KEY",
      stringValue: "REPLACE_ME",
      description: "Polygon.io API key for price and fundamentals data",
    });

    new ssm.StringParameter(this, "AnthropicApiKey", {
      parameterName: "/stockpulse/ANTHROPIC_API_KEY",
      stringValue: "REPLACE_ME",
      description: "Anthropic API key for Claude AI synthesis",
    });

    new ssm.StringParameter(this, "RedditClientId", {
      parameterName: "/stockpulse/REDDIT_CLIENT_ID",
      stringValue: "REPLACE_ME",
      description: "Reddit API client ID",
    });

    new ssm.StringParameter(this, "RedditClientSecret", {
      parameterName: "/stockpulse/REDDIT_CLIENT_SECRET",
      stringValue: "REPLACE_ME",
      description: "Reddit API client secret",
    });

    // ─── Lambda Functions ──────────────────────────────────────────────
    // Shared config for all Lambdas.

    const lambdaDefaults = {
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        BRIEFS_TABLE: briefsTable.tableName,
        SIGNALS_TABLE: signalsTable.tableName,
      },
    };

    // Orchestrator: receives a ticker, fans out fetch jobs to SQS

    const orchestrator = new lambda.Function(this, "Orchestrator", {
      ...lambdaDefaults,
      functionName: "stockpulse-orchestrator",
      handler: "orchestrator.handler",
      code: lambda.Code.fromAsset("../lambdas/orchestrator"),
    });

    // Fetchers: each pulls data from one external source

    const newsFetcher = new lambda.Function(this, "NewsFetcher", {
      ...lambdaDefaults,
      functionName: "stockpulse-news-fetcher",
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambdas/news"),
    });

    const fundamentalsFetcher = new lambda.Function(this, "FundamentalsFetcher", {
      ...lambdaDefaults,
      functionName: "stockpulse-fundamentals-fetcher",
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambdas/fundamentals"),
    });

    const redditFetcher = new lambda.Function(this, "RedditFetcher", {
      ...lambdaDefaults,
      functionName: "stockpulse-reddit-fetcher",
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambdas/reddit"),
    });

    const optionsFetcher = new lambda.Function(this, "OptionsFetcher", {
      ...lambdaDefaults,
      functionName: "stockpulse-options-fetcher",
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambdas/options"),
    });

    // Synthesizer: merges all fetched data, calls Claude, returns brief

    const synthesizer = new lambda.Function(this, "Synthesizer", {
      ...lambdaDefaults,
      functionName: "stockpulse-synthesizer",
      handler: "index.handler",
      timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromAsset("../lambdas/synthesizer"),
    });

    // ─── Permissions ───────────────────────────────────────────────────
    // Each resource only gets the access it needs (least privilege).

    briefsTable.grantReadWriteData(orchestrator);
    briefsTable.grantReadWriteData(synthesizer);
    signalsTable.grantReadWriteData(synthesizer);

    // The orchestrator invokes the 4 fetchers + synthesizer DIRECTLY
    // (RequestResponse) rather than via SQS — it needs to wait for results.
    // So it needs lambda:InvokeFunction on each of them.
    [newsFetcher, fundamentalsFetcher, redditFetcher, optionsFetcher, synthesizer]
      .forEach((fn) => fn.grantInvoke(orchestrator));

    // Allow all Lambdas to read API keys from SSM
    const ssmPolicy = new cdk.aws_iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/stockpulse/*`],
    });

    [orchestrator, newsFetcher, fundamentalsFetcher, redditFetcher, optionsFetcher, synthesizer]
      .forEach((fn) => fn.addToRolePolicy(ssmPolicy));

    // ─── API Gateway ───────────────────────────────────────────────────
    // The single entry point the Chrome extension talks to.

    const api = new apigateway.RestApi(this, "StockPulseApi", {
      restApiName: "StockPulse API",
      description: "API for StockPulse Chrome extension",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "OPTIONS"],
      },
    });

    // GET /brief/{ticker} → orchestrator
    const briefResource = api.root.addResource("brief").addResource("{ticker}");
    briefResource.addMethod("GET", new apigateway.LambdaIntegration(orchestrator));

    // POST /signal → synthesizer (for logging predictions)
    const signalResource = api.root.addResource("signal");
    signalResource.addMethod("POST", new apigateway.LambdaIntegration(synthesizer));

    // ─── EventBridge (pre-warm cron) ───────────────────────────────────
    // Every day at 7am EST (12:00 UTC), pre-fetch briefs for top tickers
    // so users get instant results for popular stocks.

    new events.Rule(this, "PreWarmRule", {
      ruleName: "stockpulse-prewarm",
      schedule: events.Schedule.cron({ minute: "0", hour: "12" }),
      targets: [new targets.LambdaFunction(orchestrator, {
        event: events.RuleTargetInput.fromObject({
          prewarm: true,
          tickers: [
            "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "BRK.B",
            "JPM", "V", "UNH", "XOM", "MA", "JNJ", "PG", "HD", "CVX", "ABBV",
            "MRK", "LLY", "AVGO", "PEP", "KO", "COST", "TMO", "MCD", "WMT",
            "CSCO", "ACN", "ABT", "CRM", "DHR", "NKE", "TXN", "NEE", "LIN",
            "PM", "UNP", "AMD", "LOW", "UPS", "MS", "RTX", "SCHW", "INTC",
            "BA", "AMGN", "SPGI", "GS", "CAT",
          ],
        }),
      })],
    });

    // ─── Outputs ───────────────────────────────────────────────────────
    // After deploy, CDK prints these so you know your API URL.

    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "API Gateway URL — put this in background.js",
    });
  }
}
