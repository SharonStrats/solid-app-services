import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { calculateJwkThumbprint, createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { apiSecurity, createPivotVerifier, securityOrigin, SecurityStore, withAiCapacity } from "../src/security.js";
import { createApp } from "../src/app.js";

const issuer = "https://sharonsolidosplayground.com/";
const publicOrigin = "https://quiz.sharonsolidosplayground.com";
const path = "/api/grade/short-answer";
const options = { issuer, publicOrigin, databasePath: ":memory:" };
const signing = await generateKeyPair("ES256");
const client = await generateKeyPair("ES256");
const issuerJwk = { ...await exportJWK(signing.publicKey), alg: "ES256", kid: "pivot" };
const clientJwk = await exportJWK(client.publicKey);
const jkt = await calculateJwkThumbprint(clientJwk);
const keyServer = createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ keys: [issuerJwk] }));
});
let verify: ReturnType<typeof createPivotVerifier>;

beforeAll(async () => {
  await new Promise<void>(resolve => keyServer.listen(0, "127.0.0.1", resolve));
  const address = keyServer.address();
  if (!address || typeof address === "string") throw new Error("Missing test JWKS port");
  verify = createPivotVerifier(options, createRemoteJWKSet(new URL(`http://127.0.0.1:${address.port}/jwks`)));
});
afterAll(() => new Promise<void>((resolve, reject) => keyServer.close(error => error ? reject(error) : resolve())));

async function credentials(tokenClaims: Record<string, unknown> = {}, proofClaims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    webid: `${issuer}alice/profile/card#me`, client_id: "pivot-client",
    iss: issuer, aud: "solid", iat: now, exp: now + 300, cnf: { jkt }, ...tokenClaims
  }).setProtectedHeader({ alg: "ES256", kid: "pivot", typ: "at+jwt" }).sign(signing.privateKey);
  const proof = await new SignJWT({
    htm: "POST", htu: `${publicOrigin}${path}`, jti: randomUUID(), iat: now,
    ath: createHash("sha256").update(token).digest("base64url"), ...proofClaims
  }).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: clientJwk }).sign(client.privateKey);
  return { authorization: `DPoP ${token}`, proof };
}

describe("Pivot Solid OIDC authentication", () => {
  it("allows HTTP only for explicitly enabled localhost development origins", () => {
    expect(securityOrigin("http://localhost:3100/", true)).toBe("http://localhost:3100");
    expect(securityOrigin("http://127.0.0.1:5001", true)).toBe("http://127.0.0.1:5001");
    expect(() => securityOrigin("http://localhost:3100/")).toThrow();
    expect(() => securityOrigin("http://example.test/", true)).toThrow();
  });

  it("verifies signed tokens and URL-bound proofs; ignores the query, not proxy headers", async () => {
    const { authorization, proof } = await credentials();
    expect(await verify(authorization, proof, "POST", `${path}?view=1`)).toMatchObject({
      webId: `${issuer}alice/profile/card#me`
    });
    await expect(verify(authorization, proof, "POST", "/other")).rejects.toThrow();
    await expect(verify(authorization, proof, "GET", path)).rejects.toThrow();
    await expect(verify(authorization.replace("DPoP", "Bearer"), proof, "POST", path)).rejects.toThrow();
  });

  it.each([
    { iss: "https://attacker.example/" }, { aud: "not-solid" },
    { webid: "http://127.0.0.1/private" }, { webid: "https://attacker.example/me" },
    { webid: "https://user:pass@sharonsolidosplayground.com/me" },
    { exp: 1 }, { client_id: undefined }, { cnf: { jkt: "wrong-key" } },
    { iat: Math.floor(Date.now() / 1000) + 600 }
  ])("rejects untrusted/invalid access-token claims %j", async claims => {
    const { authorization, proof } = await credentials(claims);
    await expect(verify(authorization, proof, "POST", path)).rejects.toThrow();
  });

  it.each([
    { ath: undefined }, { ath: "wrong-hash" }, { iat: 1 },
    { iat: Math.floor(Date.now() / 1000) + 30 }, { jti: "" },
    { htm: "GET" }, { htu: "https://attacker.example/api/grade/short-answer" }
  ])("rejects invalid proof claims %j", async claims => {
    const { authorization, proof } = await credentials({}, claims);
    await expect(verify(authorization, proof, "POST", path)).rejects.toThrow();
  });

  it("rejects forged access-token and proof signatures", async () => {
    const { authorization, proof } = await credentials();
    const corrupt = (jwt: string) => {
      const parts = jwt.split(".");
      parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
      return parts.join(".");
    };
    await expect(verify(corrupt(authorization), proof, "POST", path)).rejects.toThrow();
    await expect(verify(authorization, corrupt(proof), "POST", path)).rejects.toThrow();
  });

  it("protects every API route and MCP before parsing malformed bodies or invoking providers", async () => {
    const store = new SecurityStore(":memory:");
    const grader = vi.fn();
    const app = createApp(grader, [publicOrigin], undefined, undefined, undefined, apiSecurity(verify, store));
    for (const route of [
      path, "/api/import/document", "/api/import/quiz", "/api/generate/quiz",
      "/api/generate/flashcards", "/api/feedback/essay", "/mcp"
    ]) {
      const response = await request(app).post(route).set("Content-Type", "application/json").send("{");
      expect(response.status).toBe(401);
    }
    expect(grader).not.toHaveBeenCalled();
    expect((await request(app).get("/health")).status).toBe(200);
    expect((await request(app).get("/metrics/usage")).status).toBe(404);
    store.close();
  });

  it("rejects replay atomically, while allowing a fresh proof and normal grading", async () => {
    const store = new SecurityStore(":memory:");
    const grader = vi.fn().mockResolvedValue({ feedback: "ok" });
    const app = createApp(grader, [publicOrigin], undefined, undefined, undefined, apiSecurity(verify, store));
    const auth = await credentials();
    const post = () => request(app).post(path).set({
      Authorization: auth.authorization, DPoP: auth.proof,
      "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http"
    }).send({ question: "Why?", studentAnswer: "Because.", rubric: [{ criterion: "Reason", points: 1 }], maxScore: 1 });
    const responses = await Promise.all([post(), post()]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
    expect(grader).toHaveBeenCalledOnce();
    store.close();
  });
});

describe("durable limits", () => {
  it("persists replay protection and quota across restart without early eviction", () => {
    const dir = mkdtempSync(join(tmpdir(), "solid-security-"));
    const file = join(dir, "security.sqlite");
    const now = Date.now();
    let store = new SecurityStore(file);
    expect(store.consumeProof("proof", now + 65_000, now)).toBe(true);
    for (let n = 0; n < 30; n++) expect(store.consumeQuota("alice", 120_000)).toBe(true);
    store.close();
    store = new SecurityStore(file);
    expect(store.consumeQuota("alice", 120_000)).toBe(false);
    expect(store.consumeQuota("bob", 120_000)).toBe(true);
    expect(store.consumeQuota("alice", 180_000)).toBe(true);
    expect(store.consumeProof("proof", now + 65_000, now + 64_000)).toBe(false);
    store.close();
    rmSync(file);
    rmdirSync(dir);
  });

  it("enforces daily per-user and global limits", () => {
    const store = new SecurityStore(":memory:");
    for (let n = 0; n < 200; n++) expect(store.consumeQuota("alice", n * 60_000)).toBe(true);
    expect(store.consumeQuota("alice", 201 * 60_000)).toBe(false);
    for (let n = 0; n < 800; n++) expect(store.consumeQuota(`user${n}`, 0)).toBe(true);
    expect(store.consumeQuota("another", 0)).toBe(false);
    store.close();
  });

  it("holds provider capacity until work finishes, including rejected work", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = withAiCapacity(() => pending);
    const second = withAiCapacity(() => pending);
    await expect(withAiCapacity(async () => {})).rejects.toThrow("busy");
    release();
    await Promise.all([first, second]);
    await expect(withAiCapacity(async () => { throw new Error("provider failed"); })).rejects.toThrow("provider failed");
    await expect(withAiCapacity(async () => "ok")).resolves.toBe("ok");
  });
});
