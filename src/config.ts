import "dotenv/config";
import { securityOrigin, type SecurityOptions } from "./security.js";

export interface Config {
  host: string;
  port: number;
  openAiApiKey: string | undefined;
  openAiModel: string;
  corsOrigins: string[];
  usageMetricsToken: string | undefined;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  security: SecurityOptions;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.SOLID_AUTH_ISSUER || !env.PUBLIC_API_ORIGIN || !env.SECURITY_DATABASE_PATH) {
    throw new Error("SOLID_AUTH_ISSUER, PUBLIC_API_ORIGIN and SECURITY_DATABASE_PATH are required");
  }
  const allowInsecureLocalOrigins = env.ALLOW_INSECURE_LOCAL_ORIGINS === "true";
  securityOrigin(env.SOLID_AUTH_ISSUER, allowInsecureLocalOrigins);
  securityOrigin(env.PUBLIC_API_ORIGIN, allowInsecureLocalOrigins);
  const port = Number(env.PORT ?? 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    security: {
      issuer: env.SOLID_AUTH_ISSUER,
      publicOrigin: env.PUBLIC_API_ORIGIN,
      databasePath: env.SECURITY_DATABASE_PATH,
      allowInsecureLocalOrigins
    },
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    openAiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    openAiModel: env.OPENAI_MODEL?.trim() || "gpt-6.1-sol",
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:5173,http://localhost:4173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
    ,
    usageMetricsToken: env.USAGE_METRICS_TOKEN?.trim() || undefined,
    inputCostPerMillion: Number(env.OPENAI_INPUT_COST_PER_MILLION ?? 0),
    outputCostPerMillion: Number(env.OPENAI_OUTPUT_COST_PER_MILLION ?? 0)
  };
}
