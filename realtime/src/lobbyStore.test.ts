import assert from "node:assert/strict";
import { test } from "node:test";
import { LobbyStore } from "./lobbyStore.js";

const game = {
  name: "Alice",
  quizUri: "https://pod.example/quiz",
  questionCount: 3
};

test("the host can cancel a waiting lobby and remove all of its players", () => {
  const store = new LobbyStore();
  const lobby = store.create("host-socket", game);
  store.join("guest-socket", { name: "Bob", lobbyId: lobby.id });

  const cancelled = store.cancel("host-socket");

  assert.equal(cancelled?.id, lobby.id);
  assert.equal(store.getForSocket("host-socket"), undefined);
  assert.equal(store.getForSocket("guest-socket"), undefined);
});

test("only the host can cancel a waiting lobby", () => {
  const store = new LobbyStore();
  const lobby = store.create("host-socket", game);
  store.join("guest-socket", { name: "Bob", lobbyId: lobby.id });

  assert.equal(store.cancel("guest-socket"), undefined);
  assert.equal(store.getForSocket("host-socket")?.id, lobby.id);
});

test("the host can cancel a game after it has started", () => {
  const store = new LobbyStore();
  const lobby = store.create("host-socket", game);
  store.join("guest-socket", { name: "Bob", lobbyId: lobby.id });
  assert.ok(store.start("host-socket"));

  const cancelled = store.cancel("host-socket");

  assert.equal(cancelled?.id, lobby.id);
  assert.equal(store.getForSocket("guest-socket"), undefined);
});
