import { randomBytes } from "node:crypto";

export interface FriendChatSession {
  webId: string;
  name: string;
  friends: string[];
}

export interface FriendMessage {
  id: string;
  senderWebId: string;
  recipientWebId: string;
  senderName: string;
  content: string;
  timestamp: number;
  conversationId?: string;
}

export interface FriendConversation {
  id: string;
  creatorWebId: string;
  participantWebIds: string[];
  participantNames: string[];
  messages: FriendMessage[];
  updatedAt: number;
}

function webId (value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Prototype identities are self-reported, not Solid-authenticated.
export class FriendChatStore {
  private readonly sessions = new Map<string, FriendChatSession>();
  private readonly lastMessages = new Map<string, number>();
  private readonly conversations = new Map<string, FriendConversation>();

  createConversation (socketId: string, input: unknown): FriendConversation {
    const sender = this.sessions.get(socketId);
    if (!sender) throw new Error("Connect to chat before starting a conversation.");
    if (!input || typeof input !== "object") throw new Error("Choose friends to chat with.");
    const data = input as Record<string, unknown>;
    if (!Array.isArray(data.recipients) || !data.recipients.length || data.recipients.length > 9 || !data.recipients.every(webId)) {
      throw new Error("Choose between 1 and 9 friends.");
    }
    const recipients = [...new Set(data.recipients)];
    if (recipients.some(uri => !sender.friends.includes(uri) || uri === sender.webId)) throw new Error("Only your friends can be invited.");
    this.pruneConversations();
    if (this.conversations.size >= 1000) throw new Error("Chat is busy. Please try again later.");
    const participantWebIds = [sender.webId, ...recipients];
    const conversation: FriendConversation = {
      id: randomBytes(16).toString("hex"), creatorWebId: sender.webId,
      participantWebIds,
      participantNames: participantWebIds.map(uri => [...this.sessions.values()].find(session => session.webId === uri)?.name ?? new URL(uri).pathname.split("/").filter(Boolean)[0] ?? "Friend"),
      messages: [], updatedAt: Date.now()
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  addParticipants (socketId: string, input: unknown): { conversation: FriendConversation, added: string[], sockets: string[] } {
    if (!input || typeof input !== "object") throw new Error("Choose friends to add.");
    const data = input as Record<string, unknown>;
    if (typeof data.conversationId !== "string" || !Array.isArray(data.recipients) ||
      !data.recipients.length || !data.recipients.every(webId)) throw new Error("Choose at least one friend to add.");
    const conversation = this.conversationForSocket(socketId, data.conversationId);
    const sender = this.sessions.get(socketId)!;
    const recipients = [...new Set(data.recipients)].filter(uri => !conversation.participantWebIds.includes(uri));
    if (!recipients.length) throw new Error("Those friends are already in this chat.");
    if (conversation.participantWebIds.length + recipients.length > 10) throw new Error("A chat can have at most 10 people.");
    if (recipients.some(uri => !sender.friends.includes(uri) || uri === sender.webId)) throw new Error("Only your friends can be added.");
    conversation.participantWebIds.push(...recipients);
    conversation.participantNames.push(...recipients.map(uri => [...this.sessions.values()].find(session => session.webId === uri)?.name ?? "Friend"));
    conversation.updatedAt = Date.now();
    return { conversation, added: recipients, sockets: this.conversationSockets(conversation) };
  }

  removeParticipant (socketId: string, input: unknown): { conversation: FriendConversation, removed: string, sockets: string[] } {
    if (!input || typeof input !== "object") throw new Error("Choose someone to remove.");
    const data = input as Record<string, unknown>;
    if (typeof data.conversationId !== "string" || !webId(data.participantWebId)) throw new Error("Choose a valid chat participant.");
    const conversation = this.conversationForSocket(socketId, data.conversationId);
    const sender = this.sessions.get(socketId)!;
    const removed = data.participantWebId;
    if (removed === conversation.creatorWebId) throw new Error("The chat creator cannot be removed.");
    if (removed !== sender.webId && sender.webId !== conversation.creatorWebId) throw new Error("Only the chat creator can remove another person.");
    const index = conversation.participantWebIds.indexOf(removed);
    if (index < 0) throw new Error("That person is not in this chat.");
    const socketsBefore = this.conversationSockets(conversation);
    conversation.participantWebIds.splice(index, 1);
    conversation.participantNames.splice(index, 1);
    conversation.updatedAt = Date.now();
    const removedSockets = [...this.sessions.entries()].filter(([, session]) => session.webId === removed).map(([id]) => id);
    return { conversation, removed, sockets: [...new Set([...socketsBefore, ...this.conversationSockets(conversation), ...removedSockets])] };
  }

  private pruneConversations (): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, conversation] of this.conversations) if (conversation.updatedAt < cutoff) this.conversations.delete(id);
  }

  conversationsForSocket (socketId: string): FriendConversation[] {
    this.pruneConversations();
    const session = this.sessions.get(socketId);
    return session ? [...this.conversations.values()].filter(conversation => this.canParticipate(session, conversation)) : [];
  }

  private canParticipate (session: FriendChatSession, conversation: FriendConversation): boolean {
    return conversation.participantWebIds.includes(session.webId) &&
      (session.webId === conversation.creatorWebId || session.friends.includes(conversation.creatorWebId));
  }

  conversationForSocket (socketId: string, id: string): FriendConversation {
    this.pruneConversations();
    const conversation = this.conversations.get(id);
    const session = this.sessions.get(socketId);
    if (!conversation) throw new Error("This conversation has expired or the chat server restarted. Start a new chat.");
    if (!session || !this.canParticipate(session, conversation)) throw new Error("You are not a participant or have not added the inviter as a friend.");
    return conversation;
  }

  conversationSockets (conversation: FriendConversation): string[] {
    return [...this.sessions.entries()].filter(([, session]) => this.canParticipate(session, conversation)).map(([id]) => id);
  }

  socketsForWebIds (webIds: string[]): string[] {
    const wanted = new Set(webIds);
    return [...this.sessions.entries()].filter(([, session]) => wanted.has(session.webId)).map(([id]) => id);
  }

  sendToConversation (socketId: string, input: unknown): { conversation: FriendConversation; message: FriendMessage; sockets: string[] } {
    if (!input || typeof input !== "object") throw new Error("A message is required.");
    const data = input as Record<string, unknown>;
    if (typeof data.conversationId !== "string" || typeof data.content !== "string" || !data.content.trim() || data.content.length > 500) {
      throw new Error("Choose a conversation and write between 1 and 500 characters.");
    }
    const conversation = this.conversationForSocket(socketId, data.conversationId);
    const sender = this.sessions.get(socketId)!;
    const now = Date.now();
    if (now - (this.lastMessages.get(socketId) ?? 0) < 300) throw new Error("Please wait a moment before sending another message.");
    this.lastMessages.set(socketId, now);
    const message: FriendMessage = {
      id: randomBytes(8).toString("hex"), conversationId: conversation.id,
      senderWebId: sender.webId, recipientWebId: "", senderName: sender.name,
      content: data.content.trim(), timestamp: now
    };
    conversation.messages.push(message);
    if (conversation.messages.length > 100) conversation.messages.shift();
    conversation.updatedAt = now;
    return { conversation, message, sockets: this.conversationSockets(conversation) };
  }

  register (socketId: string, input: unknown): void {
    if (!input || typeof input !== "object") throw new Error("A chat identity is required.");
    const session = input as Record<string, unknown>;
    if (!webId(session.webId) || typeof session.name !== "string" ||
      !session.name.trim() || session.name.length > 100 ||
      !Array.isArray(session.friends) || session.friends.length > 500 ||
      !session.friends.every(webId)) {
      throw new Error("Chat identity or friend list is invalid.");
    }
    this.sessions.set(socketId, {
      webId: session.webId, name: session.name.trim(),
      friends: [...new Set(session.friends)].filter(friend => friend !== session.webId)
    });
  }

  onlineFriends (socketId: string): string[] {
    const viewer = this.sessions.get(socketId);
    if (!viewer) return [];
    return [...new Set([...this.sessions.values()]
      .filter(session => viewer.friends.includes(session.webId) && session.friends.includes(viewer.webId))
      .map(session => session.webId))];
  }

  sockets (): string[] {
    return [...this.sessions.keys()];
  }

  remove (socketId: string): void {
    this.sessions.delete(socketId);
    this.lastMessages.delete(socketId);
  }

  send (socketId: string, input: unknown): { message: FriendMessage; sockets: string[] } {
    const sender = this.sessions.get(socketId);
    if (!sender) throw new Error("Connect to friend chat before sending messages.");
    if (!input || typeof input !== "object") throw new Error("A message is required.");
    const data = input as Record<string, unknown>;
    if (!webId(data.recipientWebId) || typeof data.content !== "string" ||
      !data.content.trim() || data.content.length > 500) {
      throw new Error("Messages must contain between 1 and 500 characters.");
    }
    if (!sender.friends.includes(data.recipientWebId)) throw new Error("Select someone from your friend list.");
    const recipients = [...this.sessions.entries()].filter(([, session]) =>
      session.webId === data.recipientWebId && session.friends.includes(sender.webId));
    if (!recipients.length) throw new Error("Your friend is offline or has not added you as a friend.");
    const now = Date.now();
    if (now - (this.lastMessages.get(socketId) ?? 0) < 300) throw new Error("Please wait a moment before sending another message.");
    this.lastMessages.set(socketId, now);
    return {
      message: {
        id: randomBytes(8).toString("hex"), senderWebId: sender.webId,
        recipientWebId: data.recipientWebId, senderName: sender.name,
        content: data.content.trim(), timestamp: now
      },
      sockets: [...new Set([
        ...recipients.map(([id]) => id),
        ...[...this.sessions.entries()].filter(([, session]) => session.webId === sender.webId).map(([id]) => id)
      ])]
    };
  }
}
