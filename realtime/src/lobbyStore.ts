import { randomBytes } from "node:crypto";

export interface Player {
  id: string;
  name: string;
  webId?: string;
  score: number;
  answered: number;
  connected: boolean;
}

export interface Lobby {
  id: string;
  hostPlayerId: string;
  quizUri: string;
  questionCount: number;
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
    const player: Player = { id: playerId(), name: input.name.trim() || "Player", webId: input.webId, score: 0, answered: 0, connected: true };
    const lobby: Lobby = {
      id: lobbyId(),
      hostPlayerId: player.id,
      quizUri: input.quizUri,
      questionCount: input.questionCount,
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
    const player: Player = { id: playerId(), name: input.name.trim() || "Player", webId: input.webId, score: 0, answered: 0, connected: true };
    lobby.players.push(player);
    this.socketPlayers.set(socketId, { lobbyId: lobby.id, playerId: player.id });
    return lobby;
  }

  start (socketId: string): Lobby | undefined {
    const entry = this.socketPlayers.get(socketId);
    const lobby = entry && this.lobbies.get(entry.lobbyId);
    if (!lobby || lobby.hostPlayerId !== entry.playerId || lobby.players.length < 1) return undefined;
    lobby.status = "playing";
    return lobby;
  }

  answer (socketId: string, score: number): Lobby | undefined {
    const entry = this.socketPlayers.get(socketId);
    const lobby = entry && this.lobbies.get(entry.lobbyId);
    const player = lobby?.players.find(candidate => candidate.id === entry?.playerId);
    if (!lobby || !player || lobby.status !== "playing" || !Number.isFinite(score) || score < 0) return undefined;
    player.score += score;
    player.answered += 1;
    return lobby;
  }

  finish (socketId: string): Lobby | undefined {
    const entry = this.socketPlayers.get(socketId);
    const lobby = entry && this.lobbies.get(entry.lobbyId);
    if (!lobby || !entry || lobby.status !== "playing") return undefined;
    const player = lobby.players.find(candidate => candidate.id === entry.playerId);
    if (!player || player.answered < lobby.questionCount) return undefined;
    if (lobby.players.every(candidate => candidate.answered >= lobby.questionCount)) lobby.status = "finished";
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
    if (lobby.players.every(candidate => !candidate.connected)) this.lobbies.delete(lobby.id);
    return lobby;
  }
}
