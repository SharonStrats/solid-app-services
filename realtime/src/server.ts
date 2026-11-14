import "dotenv/config";
import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import { LobbyStore, type Lobby } from "./lobbyStore.js";

const port = Number(process.env.PORT ?? 5100);
const origins = (process.env.FRONTEND_ORIGINS ?? "http://localhost:4200")
  .split(",").map(origin => origin.trim()).filter(Boolean);
const store = new LobbyStore();
const app = express();
app.get("/health", (_request, response) => response.json({ status: "ok", service: "solid-quiz-realtime" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: origins } });

function publish (lobby: Lobby): void {
  io.to(lobby.id).emit("gameState", {
    lobbyId: lobby.id,
    quizUri: lobby.quizUri,
    questionCount: lobby.questionCount,
    currentQuestionIndex: lobby.currentQuestionIndex,
    status: lobby.status,
    hostPlayerId: lobby.hostPlayerId,
    players: lobby.players.map(({ id, name, webId, score, answered, connected }) => ({ id, name, webId, score, answered, connected }))
  });
}

io.on("connection", socket => {
  socket.on("createGame", (input: { name: string, webId?: string, quizUri: string, questionCount: number }) => {
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
  socket.on("disconnect", () => {
    const lobby = store.remove(socket.id);
    if (lobby) publish(lobby);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Solid quiz realtime service listening on http://127.0.0.1:${port}`);
});
