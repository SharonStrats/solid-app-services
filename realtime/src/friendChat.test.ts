import assert from "node:assert/strict";
import { test } from "node:test";
import { FriendChatStore } from "./friendChat.js";

const alice = "https://chat.example/alice#me";
const bob = "https://chat.example/bob#me";
const other = "https://chat.example/other#me";
const dave = "https://chat.example/dave#me";

test("presence and delivery are limited to mutual online friends", () => {
  const store = new FriendChatStore();
  store.register("alice", { webId: alice, name: "Alice", friends: [bob] });
  store.register("bob", { webId: bob, name: "Bob", friends: [alice] });
  store.register("other", { webId: other, name: "Other", friends: [alice] });
  assert.deepEqual(store.onlineFriends("alice"), [bob]);
  const delivery = store.send("alice", { recipientWebId: bob, content: " Hello! " });
  assert.equal(delivery.message.content, "Hello!");
  assert.equal(delivery.message.senderWebId, alice);
  assert.deepEqual(new Set(delivery.sockets), new Set(["alice", "bob"]));
  store.remove("bob");
  assert.deepEqual(store.onlineFriends("alice"), []);
  assert.throws(() => store.send("alice", { recipientWebId: bob, content: "Hello" }), /offline/);
});

test("multiple tabs stay online until the last tab disconnects", () => {
  const store = new FriendChatStore();
  store.register("alice", { webId: alice, name: "Alice", friends: [bob] });
  store.register("bob1", { webId: bob, name: "Bob", friends: [alice] });
  store.register("bob2", { webId: bob, name: "Bob", friends: [alice] });
  store.remove("bob1");
  assert.deepEqual(store.onlineFriends("alice"), [bob]);
  store.remove("bob2");
  assert.deepEqual(store.onlineFriends("alice"), []);
});

test("invalid requests and nonfriends are rejected explicitly", () => {
  const store = new FriendChatStore();
  assert.throws(() => store.register("a", { webId: "invalid", name: "A", friends: [] }), /invalid/);
  store.register("a", { webId: alice, name: "Alice", friends: [bob] });
  assert.throws(() => store.send("a", { recipientWebId: other, content: "hi" }), /friend list/);
  assert.throws(() => store.send("a", { recipientWebId: bob, content: "x".repeat(501) }), /500/);
});

test("group participants receive replies, while outsiders cannot join or see history", () => {
  const store = new FriendChatStore();
  store.register("alice", { webId: alice, name: "Alice", friends: [bob, other] });
  store.register("bob", { webId: bob, name: "Bob", friends: [alice] });
  store.register("other", { webId: other, name: "Other", friends: [alice] });
  store.register("outsider", { webId: "https://chat.example/outsider#me", name: "Outsider", friends: [alice] });
  const conversation = store.createConversation("alice", { recipients: [bob, other] });
  const delivery = store.sendToConversation("bob", { conversationId: conversation.id, content: "Hello everyone" });
  assert.deepEqual(new Set(delivery.sockets), new Set(["alice", "bob", "other"]));
  assert.equal(store.conversationForSocket("other", conversation.id).messages[0].content, "Hello everyone");
  assert.throws(() => store.conversationForSocket("outsider", conversation.id), /not a participant/);
  assert.throws(() => store.createConversation("bob", { recipients: [other] }), /friends/);
  store.remove("other");
  store.register("other-again", { webId: other, name: "Other", friends: [alice] });
  assert.equal(store.conversationsForSocket("other-again")[0].id, conversation.id);
});

test("creator can name a conversation and invalid names are rejected", () => {
  const store = new FriendChatStore();
  store.register("alice", { webId: alice, name: "Alice", friends: [bob] });
  store.register("bob", { webId: bob, name: "Bob", friends: [alice] });
  const conversation = store.createConversation("alice", { recipients: [bob], title: "Study group" });
  assert.equal(conversation.title, "Study group");
  assert.throws(() => store.createConversation("alice", { recipients: [bob], title: "x".repeat(101) }), /100/);
});

test("conversation participants can add friends and leave, while creators can remove others", () => {
  const store = new FriendChatStore();
  store.register("alice", { webId: alice, name: "Alice", friends: [bob, other, dave] });
  store.register("bob", { webId: bob, name: "Bob", friends: [alice, dave] });
  store.register("other", { webId: other, name: "Other", friends: [alice] });
  store.register("dave", { webId: dave, name: "Dave", friends: [alice, bob] });
  const conversation = store.createConversation("alice", { recipients: [bob] });
  const added = store.addParticipants("bob", { conversationId: conversation.id, recipients: [dave] });
  assert.deepEqual(added.conversation.participantWebIds, [alice, bob, dave]);
  assert.throws(() => store.removeParticipant("bob", { conversationId: conversation.id, participantWebId: alice }), /creator/);
  const removed = store.removeParticipant("alice", { conversationId: conversation.id, participantWebId: bob });
  assert.deepEqual(removed.conversation.participantWebIds, [alice, dave]);
  assert.throws(() => store.conversationForSocket("bob", conversation.id), /not a participant/);
});
