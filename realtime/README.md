# SolidOS quiz realtime service

This is the first separate-process prototype for live questionnaire rooms. It
is intentionally colocated under `solid-app-services` so it can be deployed
with the AI service now, but it should move to its own repository when room
traffic, persistence, or independent deployment requires it.

## Local development

```sh
npm install
cp .env.example .env
npm run typecheck
npm run dev
```

The service listens on `0.0.0.0:5100` and exposes `GET /health`. The browser
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
origin and proxy Socket.IO's `/socket.io/` upgrade path. The frontend defaults
to its own origin in production (like cargame), so a same-origin reverse proxy
works without an endpoint build variable; set `VITE_QUIZ_GAME_ENDPOINT` when
using a separate host or path. Add connection rate limits and room expiry
before public use.

## Friend chat prototype

The Home chat icon uses a separate Socket.IO connection, rather than a quiz
lobby. Opening Home registers the signed-in user's WebID, display name and
current friend list. Presence is updated on connection, disconnect and friend
list changes, including multiple tabs. Only mutual online friends are shown
as online; select up to nine friends to start a group chat. Closing the dialog leaves the
connection active while the app is open. Logout disconnects it.

- `registerFriendChat` `{ webId, name, friends }` (acknowledged)
- `friendPresence` array of mutual online friend WebIDs
- `sendFriendMessage` `{ recipientWebId, content }` (acknowledged)
- `friendMessage` delivered to the sender's and recipient's active tabs
- `createFriendConversation` `{ recipients }` (acknowledged with conversation)
- `openFriendConversation` `{ id }` (acknowledged with history)
- `sendGroupMessage` `{ conversationId, content }` (acknowledged)
- `addFriendConversationParticipants` `{ conversationId, recipients }` (acknowledged)
- `removeFriendConversationParticipant` `{ conversationId, participantWebId }` (acknowledged)
- `friendConversation` membership and retained history on creation/reconnection
- `friendChatInvitation` notifies online invitees of a newly created conversation

Messages are limited to 500 characters. Direct delivery requires an online
recipient. Groups retain the last 100 messages in server memory for 24 hours
after their last activity, with at most 1,000 groups; restarting the service
loses this history. An invited friend can reconnect and retrieve retained
history, but there is no durable message archive. Unrelated clients cannot open
groups; participant routing still depends on the self-reported identity below.
Participants can add friends while the chat is open. The creator can remove
other participants; non-creators can leave. The creator cannot leave or be
removed, so a new chat must be started if the creator should change.
Delivery errors are shown without discarding the draft.

The standalone app can request browser notification permission through the
chat dialog. Notifications require support, permission, and the app's live
connection; they do not run when the app is closed. Invitations and message
notices are also posted as Turtle Linked Data Notifications to each other
participant's advertised Solid inbox using the sender's authenticated fetch.
These notices contain conversation metadata, not message bodies. Missing
inboxes or denied Append permission are reported separately from successful
chat delivery. Inbox notices persist, but their links can expire with realtime
history. Opening Inbox refreshes notices; up to 100 listed resources are read
in batches, with unreadable resources reported without hiding accessible ones.

### Chat bubble themes

The Questionnaire pane keeps bubble themes as a presentation-only preference.
Messages remain plain text in the realtime protocol, so changing a theme does
not change delivery, history, or compatibility with other clients. Theme
definitions live in
`workspaces/questionaire-pane/src/chat/themes/registry.ts`; incoming and
outgoing SVG artwork is loaded from
`workspaces/questionaire-pane/src/chat/themes/assets/`. A new theme can be
added by placing its `incoming` and `outgoing` SVG files in that directory and
adding one configuration entry to the registry. The chat dialog provides the
gallery, live preview, and local saved selection.

Connections now require a short-lived server-signed ticket issued through the
authenticated Solid WebID API, so the active WebID is verified server-side.
Friend lists and relationship permissions are still self-reported by clients,
and message history remains in memory. Do not use it for sensitive
conversations until friend relationships are derived from verified profile
data.

The realtime process must be running separately from the AI service:
`npm run dev` in this directory (port 5100). Production requires the
`/socket.io/` proxy described above. Presence covers this app, not all Solid
apps or the entire Pod server.

Run focused store tests with `node --import tsx --test src/friendChat.test.ts`.

## Could this support collaborative editing?

Yes, Socket.IO can provide the same delivery layer for collaborative editing,
but the quiz room state must not be reused as the editing model. Editing needs
document identity, operation ordering, conflict resolution, permissions, and
recovery after disconnects.

For human-readable Markdown editing, the safest progression is:

1. Add optimistic concurrency with resource ETags or version numbers so two
   editors receive an explicit conflict instead of silently overwriting one
   another.
2. Use CodeMirror plus a CRDT such as Yjs to represent the Markdown as shared
   text, and relay updates in a separate collaboration namespace.
3. Persist canonical Markdown checkpoints to the author's Pod. Keep the
   collaboration state and presence data separate from the ordinary file.

Markdown is a much better first collaborative format than RDF/Turtle because
it is already a human-readable text document and CodeMirror can edit it
directly. The existing investigation in
`mydocs/collaborativedocs.md` describes the CodeMirror/Yjs checkpoint design.
