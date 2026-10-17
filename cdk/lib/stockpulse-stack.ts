import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

export class StockPulseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const briefsTable = new dynamodb.Table(this, "BriefsTable", {
      tableName: "stockpulse-briefs",
      partitionKey: { name: "ticker", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const signalsTable = new dynamodb.Table(this, "SignalsTable", {
      tableName: "stockpulse-signals",
      partitionKey: { name: "ticker", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "signalId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

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

    const lambdaDefaults = {
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        BRIEFS_TABLE: briefsTable.tableName,
        SIGNALS_TABLE: signalsTable.tableName,
      },
    };

    const orchestrator = new lambda.Function(this, "Orchestrator", {
      ...lambdaDefaults,
      functionName: "stockpulse-orchestrator",
      handler: "orchestrator.handler",
      code: lambda.Code.fromAsset("../lambdas/orchestrator"),
    });

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

    const synthesizer = new lambda.Function(this, "Synthesizer", {
      ...lambdaDefaults,
      functionName: "stockpulse-synthesizer",
      handler: "index.handler",
      timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromAsset("../lambdas/synthesizer"),
    });

    const grader = new lambda.Function(this, "Grader", {
      ...lambdaDefaults,
      functionName: "stockpulse-grader",
      handler: "index.handler",
      timeout: cdk.Duration.seconds(120),
      code: lambda.Code.fromAsset("../lambdas/grader"),
    });

    const stats = new lambda.Function(this, "Stats", {
      ...lambdaDefaults,
      functionName: "stockpulse-stats",
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambdas/stats"),
    });

    briefsTable.grantReadWriteData(orchestrator);
    briefsTable.grantReadWriteData(synthesizer);
    signalsTable.grantReadWriteData(synthesizer);
    signalsTable.grantReadWriteData(grader);
    signalsTable.grantReadData(stats);

    [newsFetcher, fundamentalsFetcher, redditFetcher, optionsFetcher, synthesizer]
      .forEach((fn) => fn.grantInvoke(orchestrator));

    const ssmPolicy = new cdk.aws_iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/stockpulse/*`],
    });

    [orchestrator, newsFetcher, fundamentalsFetcher, redditFetcher, optionsFetcher, synthesizer, grader]
      .forEach((fn) => fn.addToRolePolicy(ssmPolicy));

    const api = new apigateway.RestApi(this, "StockPulseApi", {
      restApiName: "StockPulse API",
      description: "API for StockPulse Chrome extension",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "OPTIONS"],
      },
    });

    const briefResource = api.root.addResource("brief").addResource("{ticker}");
    briefResource.addMethod("GET", new apigateway.LambdaIntegration(orchestrator));

    const signalResource = api.root.addResource("signal");
    signalResource.addMethod("POST", new apigateway.LambdaIntegration(synthesizer));

    const statsResource = api.root.addResource("stats");
    statsResource.addMethod("GET", new apigateway.LambdaIntegration(stats));

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

    new events.Rule(this, "GraderRule", {
      ruleName: "stockpulse-grader",
      schedule: events.Schedule.cron({ minute: "0", hour: "13" }),
      targets: [new targets.LambdaFunction(grader)],
    });

    const dashboardBucket = new s3.Bucket(this, "DashboardBucket", {
      bucketName: `stockpulse-dashboard-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, "DashboardCdn", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(dashboardBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    new s3deploy.BucketDeployment(this, "DashboardDeployment", {
      sources: [
        s3deploy.Source.asset("../dashboard"),
        s3deploy.Source.jsonData("config.json", { apiUrl: api.url }),
      ],
      destinationBucket: dashboardBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    const alertTopic = new sns.Topic(this, "AlertTopic", {
      topicName: "stockpulse-alerts",
      displayName: "StockPulse Alerts",
    });

    const alertEmail = this.node.tryGetContext("alertEmail");
    if (alertEmail) {
      alertTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));
    }

    const alarmAction = new cwActions.SnsAction(alertTopic);
    const alarms: cloudwatch.Alarm[] = [];
    const addAlarm = (id: string, props: cloudwatch.AlarmProps) => {
      const alarm = new cloudwatch.Alarm(this, id, {
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...props,
      });
      alarm.addAlarmAction(alarmAction);
      alarms.push(alarm);
      return alarm;
    };

    const monitoredFunctions: Record<string, lambda.Function> = {
      Orchestrator: orchestrator,
      NewsFetcher: newsFetcher,
      FundamentalsFetcher: fundamentalsFetcher,
      RedditFetcher: redditFetcher,
      OptionsFetcher: optionsFetcher,
      Synthesizer: synthesizer,
      Grader: grader,
      Stats: stats,
    };

    Object.entries(monitoredFunctions).forEach(([name, fn]) => {
      addAlarm(`${name}ErrorsAlarm`, {
        alarmName: `${fn.functionName}-errors`,
        alarmDescription: `${name} Lambda threw an unhandled error`,
        metric: fn.metricErrors({ statistic: "Sum", period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });

      // Fetchers catch their own errors and only console.error, so the Errors metric never fires.
      const logErrorFilter = new logs.MetricFilter(this, `${name}LogErrorFilter`, {
        logGroup: fn.logGroup,
        filterPattern: logs.FilterPattern.anyTerm("ERROR"),
        metricNamespace: "StockPulse",
        metricName: `${name}LogErrors`,
        metricValue: "1",
      });

      addAlarm(`${name}LogErrorsAlarm`, {
        alarmName: `${fn.functionName}-log-errors`,
        alarmDescription: `${name} logged 3+ ERROR lines in 15 minutes`,
        metric: logErrorFilter.metric({ statistic: "Sum", period: cdk.Duration.minutes(15) }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });
    });

    addAlarm("Api5xxAlarm", {
      alarmName: "stockpulse-api-5xx",
      alarmDescription: "API Gateway returned a 5XX response",
      metric: api.metricServerError({ statistic: "Sum", period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    addAlarm("GraderNotRunningAlarm", {
      alarmName: "stockpulse-grader-not-running",
      alarmDescription: "Daily grader job has not run in the last 24 hours",
      metric: grader.metricInvocations({ statistic: "Sum", period: cdk.Duration.hours(24) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    new cloudwatch.Dashboard(this, "OpsDashboard", {
      dashboardName: "stockpulse-ops",
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: "Lambda errors",
            width: 12,
            left: Object.entries(monitoredFunctions).map(([name, fn]) =>
              fn.metricErrors({ statistic: "Sum", period: cdk.Duration.minutes(5), label: name })),
          }),
          new cloudwatch.GraphWidget({
            title: "API requests vs 5XX",
            width: 12,
            left: [api.metricCount({ statistic: "Sum", period: cdk.Duration.minutes(5), label: "Requests" })],
            right: [api.metricServerError({ statistic: "Sum", period: cdk.Duration.minutes(5), label: "5XX" })],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: "Orchestrator duration (p90)",
            width: 12,
            left: [orchestrator.metricDuration({ statistic: "p90", period: cdk.Duration.minutes(5), label: "p90" })],
          }),
          new cloudwatch.AlarmStatusWidget({
            title: "Alarm status",
            width: 12,
            height: 8,
            alarms,
          }),
        ],
      ],
    });

    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "API Gateway URL — put this in background.js",
    });

    new cdk.CfnOutput(this, "DashboardUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "Public backtest dashboard URL",
    });
  }
}
