import "dotenv/config";
import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import { LobbyStore, type Lobby } from "./lobbyStore.js";
import { FriendChatStore, type FriendConversation } from "./friendChat.js";

const port = Number(process.env.PORT ?? 5100);
const host = process.env.HOST ?? "0.0.0.0";
const origins = (process.env.FRONTEND_ORIGINS ??
  "http://localhost:3200,http://localhost:4200,http://localhost:5173")
  .split(",").map(origin => origin.trim()).filter(Boolean);
const store = new LobbyStore();
const friendChat = new FriendChatStore();
const app = express();
app.get("/health", (_request, response) => response.json({ status: "ok", service: "solid-quiz-realtime" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: origins } });

function publish (lobby: Lobby): void {
  io.to(lobby.id).emit("gameState", {
    lobbyId: lobby.id,
    quizUri: lobby.quizUri,
    gameType: lobby.gameType,
    deckUri: lobby.deckUri,
    questionCount: lobby.questionCount,
    currentQuestionIndex: lobby.currentQuestionIndex,
    status: lobby.status,
    hostPlayerId: lobby.hostPlayerId,
    players: lobby.players.map(({ id, name, webId, score, answered, connected }) => ({ id, name, webId, score, answered, connected }))
  });
}

io.on("connection", socket => {
  const publishPresence = (): void => {
    for (const id of friendChat.sockets()) {
      io.to(id).emit("friendPresence", friendChat.onlineFriends(id));
    }
  };
  socket.on("registerFriendChat", (input: unknown, reply?: (result: { error?: string }) => void) => {
    try {
      friendChat.register(socket.id, input);
      if (typeof reply === "function") reply({});
      for (const conversation of friendChat.conversationsForSocket(socket.id)) socket.emit("friendConversation", conversation);
      publishPresence();
    } catch (error) {
      if (typeof reply === "function") reply({ error: error instanceof Error ? error.message : "Unable to connect to friend chat." });
    }
  });
  socket.on("createFriendConversation", (input: unknown, reply?: (result: { error?: string, conversation?: FriendConversation }) => void) => {
    try {
      const conversation = friendChat.createConversation(socket.id, input);
      for (const id of friendChat.conversationSockets(conversation)) {
        io.to(id).emit("friendConversation", conversation);
        if (id !== socket.id) io.to(id).emit("friendChatInvitation", conversation);
      }
      if (typeof reply === "function") reply({ conversation });
    } catch (error) {
      if (typeof reply === "function") reply({ error: error instanceof Error ? error.message : "Unable to start group chat." });
    }
  });
  socket.on("openFriendConversation", (input: { id?: string }, reply?: (result: { error?: string, conversation?: FriendConversation }) => void) => {
    try {
      const conversation = friendChat.conversationForSocket(socket.id, input?.id ?? "");
      if (typeof reply === "function") reply({ conversation });
    } catch (error) {
      if (typeof reply === "function") reply({ error: error instanceof Error ? error.message : "Unable to open chat." });
    }
  });
  socket.on("addFriendConversationParticipants", (input: unknown, reply?: (result: { error?: string, conversation?: FriendConversation }) => void) => {
    try {
      const change = friendChat.addParticipants(socket.id, input);
      for (const id of change.sockets) io.to(id).emit("friendConversation", change.conversation);
      for (const id of friendChat.socketsForWebIds(change.added)) io.to(id).emit("friendChatInvitation", change.conversation);
      if (typeof reply === "function") reply({ conversation: change.conversation });
    } catch (error) {
      if (typeof reply === "function") reply({ error: error instanceof Error ? error.message : "Unable to add chat participants." });
    }
  });
  socket.on("removeFriendConversationParticipant", (input: unknown, reply?: (result: { error?: string, conversation?: FriendConversation }) => void) => {
    try {
      const change = friendChat.removeParticipant(socket.id, input);
      for (const id of change.sockets) io.to(id).emit("friendConversation", change.conversation);
      if (typeof reply === "function") reply({ conversation: change.conversation });
    } catch (error) {
      if (typeof reply === "function") reply({ error: error instanceof Error ? error.message : "Unable to change chat participants." });
    }
  });
  socket.on("sendGroupMessage", (input: unknown, reply?: (result: { error?: string }) => void) => {
    try {
      const delivery = friendChat.sendToConversation(socket.id, input);
      for (const id of delivery.sockets) io.to(id).emit("friendMessage", delivery.message);
      if (typeof reply === "function") reply({});
    } catch (error) {
      if (typeof reply === "function") reply({ error: error instanceof Error ? error.message : "Unable to send group message." });
    }
  });
  socket.on("sendFriendMessage", (input: unknown, reply?: (result: { error?: string }) => void) => {
    try {
      const delivery = friendChat.send(socket.id, input);
      for (const id of delivery.sockets) io.to(id).emit("friendMessage", delivery.message);
      if (typeof reply === "function") reply({});
    } catch (error) {
      if (typeof reply === "function") reply({ error: error instanceof Error ? error.message : "Unable to send message." });
    }
  });
  socket.on("createGame", (input: { name: string, webId?: string, quizUri?: string, deckUri?: string, questionCount: number, gameType?: "quiz" | "study-cards" }) => {
    if (!input || !Number.isInteger(input.questionCount) || input.questionCount < 1 ||
      (input.gameType === "study-cards" ? !input.deckUri : !input.quizUri)) {
      socket.emit("gameError", { message: "A valid quiz or study deck is required." });
      return;
    }
    const lobby = store.create(socket.id, input);
    socket.join(lobby.id);
    socket.emit("gameCreated", { lobbyId: lobby.id, playerId: lobby.players[0].id });
    publish(lobby);
  });
  socket.on("joinGame", (input: { name: string, webId?: string, lobbyId: string }) => {
    const lobby = store.join(socket.id, input);
    if (!lobby) {
      socket.emit("gameError", { message: "Game not found, already started, or full." });
      return;
    }
    socket.join(lobby.id);
    socket.emit("gameJoined", { lobbyId: lobby.id, playerId: lobby.players.at(-1)?.id });
    publish(lobby);
  });
  socket.on("joinChatRoom", (input: { name: string, roomId: string }) => {
    const lobby = store.joinChatRoom(socket.id, input);
    if (!lobby) {
      socket.emit("gameError", { message: "Study chat room is invalid or full." });
      return;
    }
    socket.join(lobby.id);
    socket.emit("chatRoomJoined", { roomId: lobby.id });
  });
  socket.on("startGame", () => {
    const lobby = store.start(socket.id);
    if (!lobby) socket.emit("gameError", { message: "Only the host can start the game." });
    else publish(lobby);
  });
  socket.on("advanceQuestion", () => {
    const lobby = store.advance(socket.id);
    if (!lobby) socket.emit("gameError", { message: "The current question is not complete or cannot be advanced." });
    else publish(lobby);
  });
  socket.on("submitAnswer", (input: { questionIndex: number, score: number }) => {
    const lobby = store.answer(socket.id, input.questionIndex, input.score);
    if (!lobby) socket.emit("gameError", { message: "The answer could not be recorded." });
    else publish(lobby);
  });
  socket.on("finishGame", () => {
    const lobby = store.finish(socket.id);
    if (!lobby) socket.emit("gameError", { message: "Finish is available after all answers are submitted." });
    else publish(lobby);
  });
  socket.on("sendChatMessage", (input: { content?: string }) => {
    const message = store.addChatMessage(socket.id, input.content ?? "");
    const lobby = store.getForSocket(socket.id);
    if (message && lobby) io.to(lobby.id).emit("chatMessage", message);
    else if (!lobby) socket.emit("gameError", { message: "Join a game before sending chat messages." });
  });
  socket.on("disconnect", () => {
    friendChat.remove(socket.id);
    publishPresence();
    const lobby = store.remove(socket.id);
    if (lobby) publish(lobby);
  });
});

server.listen(port, host, () => {
  console.log(`Solid quiz realtime service listening on http://${host}:${port}`);
});
