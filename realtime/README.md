# SolidOS quiz realtime service

This is the first separate-process prototype for live questionnaire rooms. It
is intentionally colocated under `solid-ai-services` so it can be deployed
with the AI service now, but it should move to its own repository when room
traffic, persistence, or independent deployment requires it.

## Local development

```sh
npm install
cp .env.example .env
npm run typecheck
npm run dev
```

The service listens on `127.0.0.1:5100` and exposes `GET /health`. The browser
connects with Socket.IO, not a raw WebSocket.

## Protocol

- `createGame` `{ name, webId?, quizUri, questionCount }`
- `joinGame` `{ name, webId?, lobbyId }`
- `startGame` (host only)
- `advanceQuestion` (host only, after connected players answer)
- `submitAnswer` `{ questionIndex, score }`
- `finishGame`
- `gameState` is broadcast after every accepted state change.

The current implementation keeps room state in memory, limits rooms to 20
players, and expires a room when all connected sockets leave or the process
restarts. It broadcasts the current question index, aggregate scores, and
answer counts, not answer text. The host can advance only after every
connected player answers the current question, and duplicate answers are
rejected.

`score` is currently client-submitted so the standalone pane can be wired
without duplicating the questionnaire scoring engine. This is not sufficient
for trusted or competitive scoring. Before public launch, add an authenticated
server-issued session ticket, validate access to the immutable published
`quizUri`, and either move scoring to this service or submit signed scoring
results from the pane.

## Deployment boundary

Run this as a separate systemd process behind the same reverse proxy as the
AI service, for example `/game` or `game.example.test`. Do not expose port
5100 directly. Set `FRONTEND_ORIGINS` to the exact standalone questionnaire
origin and add connection rate limits and room expiry before public use.

## Could this support collaborative editing?

Yes, Socket.IO can provide the same delivery layer for collaborative editing,
but the quiz room state must not be reused as the editing model. Editing needs
document identity, operation ordering, conflict resolution, permissions, and
recovery after disconnects.

For questionnaire authoring, the safest progression is:

1. Add optimistic concurrency with resource ETags or version numbers so two
   editors receive an explicit conflict instead of silently overwriting one
   another.
2. Relay small question-level operations in a separate collaboration
   namespace and persist accepted changes to the author's Pod.
3. Use a CRDT such as Yjs or Automerge only for rich text or very frequent
   concurrent edits; periodically persist a canonical snapshot and keep the
   Pod as the durable source of truth.

RDF/Turtle files are not themselves a good character-level collaborative
document format. A question-level operation model or CRDT document should be
the temporary editing representation, with validated RDF writes at commit
boundaries.
