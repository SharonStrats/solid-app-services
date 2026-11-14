import { randomBytes } from "node:crypto";

export interface Player {
  id: string;
  name: string;
  webId?: string;
  score: number;
  answered: number;
  answeredQuestions: Set<number>;
  connected: boolean;
}

export interface Lobby {
  id: string;
  hostPlayerId: string;
  quizUri: string;
  questionCount: number;
  currentQuestionIndex: number | null;
  status: "waiting" | "playing" | "finished";
  players: Player[];
}

function lobbyId (): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function playerId (): string {
  return randomBytes(8).toString("hex");
}

export class LobbyStore {
  private readonly lobbies = new Map<string, Lobby>();
  private readonly socketPlayers = new Map<string, { lobbyId: string, playerId: string }>();

  create (socketId: string, input: { name: string, webId?: string, quizUri: string, questionCount: number }): Lobby {
    const player: Player = { id: playerId(), name: input.name.trim() || "Player", webId: input.webId, score: 0, answered: 0, answeredQuestions: new Set(), connected: true };
    const lobby: Lobby = {
      id: lobbyId(),
      hostPlayerId: player.id,
      quizUri: input.quizUri,
      questionCount: input.questionCount,
      currentQuestionIndex: null,
      status: "waiting",
      players: [player]
    };
    this.lobbies.set(lobby.id, lobby);
    this.socketPlayers.set(socketId, { lobbyId: lobby.id, playerId: player.id });
    return lobby;
  }

  join (socketId: string, input: { name: string, webId?: string, lobbyId: string }): Lobby | undefined {
    const lobby = this.lobbies.get(input.lobbyId.toUpperCase());
    if (!lobby || lobby.status !== "waiting" || lobby.players.length >= 20) return undefined;
    const player: Player = { id: playerId(), name: input.name.trim() || "Player", webId: input.webId, score: 0, answered: 0, answeredQuestions: new Set(), connected: true };
    lobby.players.push(player);
    this.socketPlayers.set(socketId, { lobbyId: lobby.id, playerId: player.id });
    return lobby;
  }

  start (socketId: string): Lobby | undefined {
    const entry = this.socketPlayers.get(socketId);
    const lobby = entry && this.lobbies.get(entry.lobbyId);
    if (!lobby || lobby.hostPlayerId !== entry.playerId || lobby.players.length < 1) return undefined;
    lobby.status = "playing";
    lobby.currentQuestionIndex = 0;
    return lobby;
  }

  answer (socketId: string, questionIndex: number, score: number): Lobby | undefined {
    const entry = this.socketPlayers.get(socketId);
    const lobby = entry && this.lobbies.get(entry.lobbyId);
    const player = lobby?.players.find(candidate => candidate.id === entry?.playerId);
    if (!lobby || !player || lobby.status !== "playing" || questionIndex !== lobby.currentQuestionIndex ||
      !Number.isInteger(questionIndex) || !Number.isFinite(score) || score < 0 ||
      player.answeredQuestions.has(questionIndex)) return undefined;
    player.score += score;
    player.answeredQuestions.add(questionIndex);
    player.answered += 1;
    return lobby;
  }

  advance (socketId: string): Lobby | undefined {
    const entry = this.socketPlayers.get(socketId);
    const lobby = entry && this.lobbies.get(entry.lobbyId);
    if (!lobby || !entry || lobby.hostPlayerId !== entry.playerId || lobby.status !== "playing" ||
      lobby.currentQuestionIndex === null || lobby.currentQuestionIndex >= lobby.questionCount - 1) return undefined;
    const currentQuestion = lobby.currentQuestionIndex;
    if (lobby.players.some(player => player.connected && !player.answeredQuestions.has(currentQuestion))) return undefined;
    lobby.currentQuestionIndex += 1;
    return lobby;
  }

  finish (socketId: string): Lobby | undefined {
    const entry = this.socketPlayers.get(socketId);
    const lobby = entry && this.lobbies.get(entry.lobbyId);
    if (!lobby || !entry || lobby.status !== "playing") return undefined;
    const player = lobby.players.find(candidate => candidate.id === entry.playerId);
    if (!player || player.answered < lobby.questionCount ||
      lobby.players.some(candidate => candidate.connected && candidate.answered < lobby.questionCount)) return undefined;
    lobby.status = "finished";
    lobby.currentQuestionIndex = null;
    return lobby;
  }

  getForSocket (socketId: string): Lobby | undefined {
    const entry = this.socketPlayers.get(socketId);
    return entry ? this.lobbies.get(entry.lobbyId) : undefined;
  }

  remove (socketId: string): Lobby | undefined {
    const entry = this.socketPlayers.get(socketId);
    if (!entry) return undefined;
    this.socketPlayers.delete(socketId);
    const lobby = this.lobbies.get(entry.lobbyId);
    if (!lobby) return undefined;
    const player = lobby.players.find(candidate => candidate.id === entry.playerId);
    if (player) player.connected = false;
    if (lobby.hostPlayerId === entry.playerId) {
      const nextHost = lobby.players.find(candidate => candidate.connected);
      if (nextHost) lobby.hostPlayerId = nextHost.id;
    }
    if (lobby.players.every(candidate => !candidate.connected)) this.lobbies.delete(lobby.id);
    return lobby;
  }
}
