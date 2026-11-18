import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { createRemoteJWKSet, decodeJwt } from "jose";
import { SignJWT } from "jose";
import { createSolidTokenVerifier } from "@solid/access-token-verifier";
import { IssuerKeySetCache } from "@solid/access-token-verifier/dist/class/IssuerKeySetCache.js";
import { WebIDIssuersCache } from "@solid/access-token-verifier/dist/class/WebIDIssuersCache.js";
import type { RequestHandler } from "express";

export interface SecurityOptions {
  issuer: string;
  publicOrigin: string;
  databasePath: string;
  allowInsecureLocalOrigins?: boolean;
}

const caller = new AsyncLocalStorage<string>();
let active = 0;
const users = new Map<string, number>();

export class AiBusyError extends Error {}

export function currentCaller(): string | undefined {
  return caller.getStore();
}

export async function createRealtimeTicket(webId: string, secret: string): Promise<string> {
  return new SignJWT({ webid: webId, scope: "realtime" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("solid-app-services")
    .setSubject(webId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

export async function withAiCapacity<T>(task: () => Promise<T>): Promise<T> {
  const webId = caller.getStore() ?? "internal";
  const current = users.get(webId) ?? 0;
  if (active >= 8 || current >= 2) throw new AiBusyError("AI services are busy. Please try again shortly.");
  active++;
  users.set(webId, current + 1);
  try {
    return await task();
  } finally {
    active--;
    const remaining = (users.get(webId) ?? 1) - 1;
    if (remaining === 0) users.delete(webId);
    else users.set(webId, remaining);
  }
}

export function httpsOrigin(value: string): string {
  return securityOrigin(value);
}

export function securityOrigin(value: string, allowInsecureLocalOrigins = false): string {
  const url = new URL(value);
  const isAllowedHttpLocalOrigin = allowInsecureLocalOrigins &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((!isAllowedHttpLocalOrigin && url.protocol !== "https:") ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Security origins must be HTTPS origins without a path, credentials, query or fragment");
  }
  return url.origin;
}

class PivotWebIds extends WebIDIssuersCache {
  constructor(private readonly issuer: string) { super(); }

  override async getIssuers(webid: string): Promise<string[]> {
    const url = new URL(webid);
    if (url.origin !== new URL(this.issuer).origin || url.username || url.password) {
      throw new Error("WebID is not hosted by the trusted Pivot");
    }
    // Pivot is explicitly trusted to assert identities in its own namespace.
    // Never dereference a WebID supplied by an unverified token.
    return [this.issuer];
  }
}

class PivotKeys extends IssuerKeySetCache {
  constructor(private readonly issuer: string, private readonly keys: ReturnType<typeof createRemoteJWKSet>) { super(); }

  override async getKeySet(issuer: string) {
    if (issuer !== this.issuer) throw new Error("Untrusted token issuer");
    return this.keys;
  }
}

export function createPivotVerifier(options: SecurityOptions, keys = createRemoteJWKSet(
  new URL("/.oidc/jwks", options.issuer), { timeoutDuration: 5_000 }
)) {
  const issuer = `${securityOrigin(options.issuer, options.allowInsecureLocalOrigins)}/`;
  if (options.issuer !== issuer) throw new Error("The Pivot issuer must include its trailing slash");
  const origin = securityOrigin(options.publicOrigin, options.allowInsecureLocalOrigins);
  const targetOrigins = [origin];
  if (options.allowInsecureLocalOrigins && ["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) {
    const alias = new URL(origin);
    alias.hostname = alias.hostname === "localhost" ? "127.0.0.1" : "localhost";
    targetOrigins.push(alias.origin);
  }
  const verify = createSolidTokenVerifier(undefined, new PivotKeys(issuer, keys), new PivotWebIds(issuer));
  return async (authorization: string, proof: string, method: string, path: string) => {
    if (!/^DPoP [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization) ||
        authorization.length > 16_384 || proof.length > 16_384 || method !== "POST") {
      throw new Error("A DPoP-bound Solid access token is required");
    }
    const token = decodeJwt(authorization.slice(5));
    const claims = decodeJwt(proof);
    const now = Math.floor(Date.now() / 1000);
    if (token.iss !== issuer) {
      throw new Error(`Token issuer mismatch: received ${String(token.iss ?? "(missing)")}; expected ${issuer}`);
    }
    if (typeof token.client_id !== "string" || !token.client_id) throw new Error("Token client_id is missing");
    if (typeof token.exp !== "number" || token.exp <= now) throw new Error("Token is expired or has no valid expiry");
    if (typeof claims.ath !== "string" || !claims.ath) throw new Error("DPoP proof is missing the access-token hash");
    if (typeof claims.jti !== "string" || !claims.jti || claims.jti.length > 256) throw new Error("DPoP proof has no valid replay identifier");
    if (typeof claims.iat !== "number" || claims.iat < now - 60 || claims.iat > now + 5) throw new Error("DPoP proof timestamp is outside the allowed clock window");
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("API request path is invalid");
    let verified: Awaited<ReturnType<typeof verify>> | undefined;
    let verificationError: unknown;
    for (const targetOrigin of targetOrigins) {
      const target = new URL(path, targetOrigin);
      target.search = "";
      target.hash = "";
      try {
        verified = await verify(authorization, {
          header: proof, method, url: target.href, isDuplicateJTI: () => false
        });
        break;
      } catch (error) {
        verificationError = error;
      }
    }
    if (!verified) throw verificationError instanceof Error ? verificationError : new Error("Invalid API target");
    const cnf = verified.cnf;
    if (!cnf || typeof cnf !== "object" || !("jkt" in cnf) || typeof cnf.jkt !== "string") {
      throw new Error("Missing proof key binding");
    }
    return { webId: verified.webid, replayKey: `${cnf.jkt}:${claims.jti}`, expires: (claims.iat + 61) * 1000 };
  };
}

export class SecurityStore {
  private readonly db: DatabaseSync;
  private lastCleanup = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS proofs (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quotas (
        scope TEXT, window INTEGER, count INTEGER NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY (scope, window)
      );
    `);
  }

  consumeProof(id: string, expires: number, now = Date.now()): boolean {
    if (now - this.lastCleanup > 60_000) {
      this.db.prepare("DELETE FROM proofs WHERE expires < ?").run(now);
      this.db.prepare("DELETE FROM quotas WHERE expires < ?").run(now);
      this.lastCleanup = now;
    }
    return this.db.prepare("INSERT OR IGNORE INTO proofs VALUES (?, ?)").run(id, expires).changes === 1;
  }

  consumeQuota(webId: string, now = Date.now()): boolean {
    const windows = [
      { scope: `minute:${webId}`, duration: 60_000, limit: 30 },
      { scope: `day:${webId}`, duration: 86_400_000, limit: 200 },
      { scope: "global", duration: 86_400_000, limit: 1000 }
    ];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { scope, duration, limit } of windows) {
        const window = Math.floor(now / duration);
        const row = this.db.prepare("SELECT count FROM quotas WHERE scope = ? AND window = ?").get(scope, window);
        if (row && Number(row.count) >= limit) {
          this.db.exec("ROLLBACK");
          return false;
        }
      }
      for (const { scope, duration } of windows) {
        const window = Math.floor(now / duration);
        this.db.prepare(`INSERT INTO quotas VALUES (?, ?, 1, ?)
          ON CONFLICT(scope, window) DO UPDATE SET count = count + 1`).run(scope, window, (window + 1) * duration);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.db.close(); }
}

export function createApiSecurity(options: SecurityOptions): RequestHandler {
  const verify = createPivotVerifier(options);
  const store = new SecurityStore(options.databasePath);
  return apiSecurity(verify, store, options.allowInsecureLocalOrigins === true);
}

export function apiSecurity(
  verify: ReturnType<typeof createPivotVerifier>,
  store: SecurityStore,
  exposeDevelopmentErrors = false
): RequestHandler {
  let verifying = 0;
  return async (request, response, next) => {
    response.set("Cache-Control", "no-store");
    const authorization = request.get("authorization");
    const proof = request.get("dpop");
    if (!authorization || !proof) {
      response.set("WWW-Authenticate", "DPoP").status(401).json({ error: "login_required", message: "Log in with your Pivot WebID to use AI features." });
      return;
    }
    if (verifying >= 16) {
      response.set("Retry-After", "5").status(429).json({ error: "busy", message: "Please try again shortly." });
      return;
    }
    let identity: Awaited<ReturnType<typeof verify>>;
    verifying++;
    try {
      identity = await verify(authorization, proof, request.method, request.originalUrl);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown verification error";
      console.warn("API authentication rejected", reason);
      response.set("WWW-Authenticate", 'DPoP error="invalid_token"').status(401).json({
        error: "invalid_token",
        message: exposeDevelopmentErrors
          ? `Local development authentication failed: ${reason}`
          : "Your WebID session could not be verified. Please log in again."
      });
      return;
    } finally {
      verifying--;
    }
    try {
      if (!store.consumeProof(identity.replayKey, identity.expires)) {
        response.status(401).json({ error: "invalid_token", message: "This request has already been used." });
        return;
      }
      if (!store.consumeQuota(identity.webId)) {
        response.set("Retry-After", "60").status(429).json({ error: "usage_limit", message: "The AI usage limit has been reached. Please try again later." });
        return;
      }
      caller.run(identity.webId, next);
    } catch (error) {
      console.error("API security storage failed", error);
      response.status(503).json({ error: "security_unavailable", message: "AI services are temporarily unavailable." });
    }
  };
}
