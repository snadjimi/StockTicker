#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { StockPulseStack } from "../lib/stockpulse-stack";

const app = new cdk.App();
new StockPulseStack(app, "StockPulseStack", {
  env: { region: "us-east-1" },
});
