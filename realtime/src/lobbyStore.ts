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

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
}

export interface Lobby {
  id: string;
  hostPlayerId: string;
  quizUri: string;
  gameType: "quiz" | "study-cards";
  deckUri?: string;
  questionCount: number;
  currentQuestionIndex: number | null;
  status: "waiting" | "playing" | "finished";
  players: Player[];
  chatMessages: ChatMessage[];
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

  create (socketId: string, input: { name: string, webId?: string, quizUri?: string, deckUri?: string, questionCount: number, gameType?: "quiz" | "study-cards" }): Lobby {
    const player: Player = { id: playerId(), name: input.name.trim() || "Player", webId: input.webId, score: 0, answered: 0, answeredQuestions: new Set(), connected: true };
    const lobby: Lobby = {
      id: lobbyId(),
      hostPlayerId: player.id,
      quizUri: input.quizUri ?? input.deckUri ?? "",
      gameType: input.gameType ?? "quiz",
      deckUri: input.deckUri,
      questionCount: input.questionCount,
      currentQuestionIndex: null,
      status: "waiting",
      players: [player],
      chatMessages: []
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

  joinChatRoom (socketId: string, input: { name: string, roomId: string }): Lobby | undefined {
    const id = input.roomId.trim().toUpperCase();
    if (!id || id.length > 120) return undefined;
    let lobby = this.lobbies.get(id);
    if (!lobby) {
      const player: Player = {
        id: playerId(), name: input.name.trim() || "Player", score: 0, answered: 0,
        answeredQuestions: new Set(), connected: true
      };
      lobby = {
        id, hostPlayerId: player.id, quizUri: "", gameType: "quiz", questionCount: 0,
        currentQuestionIndex: null, status: "waiting", players: [player], chatMessages: []
      };
      this.lobbies.set(id, lobby);
      this.socketPlayers.set(socketId, { lobbyId: id, playerId: player.id });
      return lobby;
    }
    if (lobby.players.length >= 20) return undefined;
    const player: Player = {
      id: playerId(), name: input.name.trim() || "Player", score: 0, answered: 0,
      answeredQuestions: new Set(), connected: true
    };
    lobby.players.push(player);
    this.socketPlayers.set(socketId, { lobbyId: id, playerId: player.id });
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

  addChatMessage (socketId: string, content: string): ChatMessage | undefined {
    const entry = this.socketPlayers.get(socketId);
    const lobby = entry && this.lobbies.get(entry.lobbyId);
    const player = lobby?.players.find(candidate => candidate.id === entry?.playerId);
    const trimmed = typeof content === "string" ? content.trim() : "";
    if (!lobby || !player || !trimmed) return undefined;
    const message: ChatMessage = {
      id: randomBytes(8).toString("hex"),
      senderId: player.id,
      senderName: player.name,
      content: trimmed.slice(0, 500),
      timestamp: Date.now()
    };
    lobby.chatMessages.push(message);
    if (lobby.chatMessages.length > 100) lobby.chatMessages.shift();
    return message;
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
