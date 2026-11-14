import { createApp } from "./app.js";
import { createAiServices } from "./aiServices.js";
import { loadConfig } from "./config.js";
import { createGrader } from "./grader.js";

const config = loadConfig();
const aiServices = createAiServices(config.openAiApiKey, config.openAiModel);
const app = createApp(createGrader(config.openAiApiKey, config.openAiModel), config.corsOrigins, aiServices);

app.listen(config.port, config.host, () => {
  console.log(`Solid AI services listening on http://${config.host}:${config.port}`);
});
