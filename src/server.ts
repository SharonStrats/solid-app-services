import { createApp } from "./app.js";
import { createAiServices } from "./aiServices.js";
import { loadConfig } from "./config.js";
import { createGrader } from "./grader.js";
import { UsageTracker } from "./usage.js";
import { createApiSecurity } from "./security.js";

const config = loadConfig();
const usage = new UsageTracker(config.inputCostPerMillion, config.outputCostPerMillion);
const aiServices = createAiServices(config.openAiApiKey, config.openAiModel, usage);
const app = createApp(createGrader(config.openAiApiKey, config.openAiModel, usage), config.corsOrigins, aiServices, usage, config.usageMetricsToken, createApiSecurity(config.security), config.realtimeTicketSecret);

app.listen(config.port, config.host, () => {
  console.log(`Solid AI services listening on http://${config.host}:${config.port}`);
});
