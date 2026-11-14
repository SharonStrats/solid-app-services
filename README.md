# SolidOS application services

Node/TypeScript services for OpenAI-assisted questionnaire grading, essay
feedback, document extraction, quiz generation, and flashcard generation.
The provider key stays on this server; it is never sent to the browser.

## Role in the SolidOS architecture

The questionnaire pane remains responsible for collecting answers and
displaying results. These services are the server-side boundary for
provider-backed AI: they receive validated requests from a SolidOS client,
call OpenAI, and return validated structured data.
OpenAI credentials must stay in this service and must never be placed in
Mashlib, Pivot, the questionnaire pane, or browser code.

MCP is an optional tool interface over the same capabilities. It is useful
for an AI client that needs to call document, feedback, or generation tools;
the questionnaire pane can continue using the REST API.

## Setup

Requires Node 20+ and pnpm.

```sh
pnpm install
cp .env.example .env
# Set OPENAI_API_KEY in .env
pnpm dev
```

The server listens on `http://localhost:5000` by default. Run checks with:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm start
```

For local SolidOS development, set `CORS_ORIGINS` in `.env` to the exact
origins that should call the service, for example
`http://localhost:3000,http://localhost:3100`. Keep `OPENAI_API_KEY` only in
the server-side `.env`; `.env` is intentionally not committed.

## API

`GET /health` returns `{ "status": "ok", "service": "solid-app-services" }`.

`POST /api/grade/short-answer` accepts:

```json
{
  "question": "Why do plants need sunlight?",
  "studentAnswer": "They use sunlight to make food.",
  "expectedAnswer": "Plants use sunlight for photosynthesis.",
  "rubric": [
    { "criterion": "mentions sunlight", "points": 1 },
    { "criterion": "explains that plants make food", "points": 1 }
  ],
  "maxScore": 2
}
```

`expectedAnswer` is optional. `maxScore` must equal the sum of rubric points.
The response contains `decision` (`correct`, `partial`, or `needs-review`),
`score`, `maxScore`, `confidence`, `feedback`, `matchedCriteria`,
`missingCriteria`, and `needsReview`. Invalid requests return HTTP 400;
provider failures return HTTP 502.

```sh
curl -s http://localhost:5000/api/grade/short-answer \
  -H 'Content-Type: application/json' \
  -d '{"question":"Why do plants need sunlight?","studentAnswer":"They use sunlight to make food.","rubric":[{"criterion":"mentions sunlight","points":1},{"criterion":"explains that plants make food","points":1}],"maxScore":2}'
```

The endpoint is intentionally provider-shaped only at the server boundary:
the client receives the normalized grading contract rather than raw OpenAI
output.

### Essay feedback

`POST /api/feedback/essay` accepts an essay, optional assignment, and
optional rubric. It returns overall feedback, strengths, areas to improve,
paragraph-level pointers, and a `needsReview` flag. The service gives
feedback rather than silently rewriting student work.

### Document extraction

`POST /api/import/document` accepts a multipart `file` field containing a
PDF, DOCX, Markdown, or text file. It returns normalized extracted text,
the original filename, media type, and character count. Uploads are limited
to 10 MB and extracted text to 100,000 characters.

### Quiz and flashcard generation

`POST /api/generate/quiz` and `POST /api/generate/flashcards` accept source
text, an optional title, a requested count, and a difficulty. Generated
questions and cards include explanations or source references so the client
can review and edit them before saving.

### MCP

`POST /mcp` exposes stateless Streamable HTTP MCP tools:

- `essay_feedback`
- `generate_quiz`
- `generate_flashcards`

The MCP tools call the same validated service functions as the REST routes.
MCP authentication should be added before exposing this endpoint to external
clients.

## Deploying to a droplet

The service is intended to run behind Caddy or Nginx. It binds to
`127.0.0.1` by default, so the OpenAI-backed endpoint is not directly
reachable from the public internet.

On an Ubuntu droplet:

```sh
sudo apt update
sudo apt install -y git nodejs npm
sudo npm install --global pnpm
sudo mkdir -p /opt/solid-app-services
sudo chown "$USER":"$USER" /opt/solid-app-services
git clone https://github.com/SharonStrats/solid-app-services.git /opt/solid-app-services
cd /opt/solid-app-services
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
```

Edit `.env` and set at least:

```env
HOST=127.0.0.1
PORT=5000
OPENAI_API_KEY=your-server-side-key
OPENAI_MODEL=gpt-6.1-sol
CORS_ORIGINS=https://quiz.sharonsolidosplayground.com
USAGE_METRICS_TOKEN=replace-with-a-long-random-secret
```

Do not commit `.env` or put `OPENAI_API_KEY` in the questionnaire app.
Set `OPENAI_INPUT_COST_PER_MILLION` and `OPENAI_OUTPUT_COST_PER_MILLION`
using the current prices for the selected OpenAI model. The protected
`GET /metrics/usage` endpoint then reports request count, token totals, and
estimated USD cost. The estimate is zero until those prices are configured.
Build and verify the service:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

For a persistent service, copy
`deploy/solid-app-services.service.example` to
`/etc/systemd/system/solid-app-services.service`, update the user and
installation path if needed, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now solid-app-services
systemctl status solid-app-services
curl http://127.0.0.1:5000/health
```

Configure Caddy or Nginx to proxy the quiz app's `/api/` and `/health` paths
to `http://127.0.0.1:5000`, restrict `CORS_ORIGINS` to the exact quiz origin,
and keep port 5000 closed in the firewall. Before exposing this beyond your
own quiz app, add caller authentication, rate limiting, request logging that
omits student content, and provider usage monitoring.

## Realtime quiz rooms

The colocated [`realtime/`](./realtime/) service is a separate Node process
for live quiz rooms. It uses Socket.IO for room presence and synchronized
state, while the questionnaire pane remains responsible for loading the
immutable published quiz and scoring answers. It is intentionally memory-only
for the prototype and should be split into its own repository/service when it
needs independent scaling or durable room state.

```sh
cd realtime
npm install
npm run typecheck
npm run build
```

Run it behind the reverse proxy on an internal port such as `5100`. Do not
place Solid bearer or DPoP credentials in room URLs. Authentication,
published-quiz access validation, authoritative scoring, rate limiting, and
expiry are required before public multiplayer games.
