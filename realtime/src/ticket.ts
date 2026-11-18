import { createHmac, timingSafeEqual } from "node:crypto";

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function verifyRealtimeTicket(token: unknown, secret: string): string {
  if (typeof token !== "string" || token.length > 4096) throw new Error("Realtime login required.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid realtime ticket.");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const expected = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const received = Buffer.from(encodedSignature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Invalid realtime ticket.");
  }
  const header = JSON.parse(decode(encodedHeader)) as { alg?: string; typ?: string };
  const payload = JSON.parse(decode(encodedPayload)) as { iss?: string; sub?: string; webid?: string; scope?: string; exp?: number };
  if (header.alg !== "HS256" || header.typ !== "JWT" ||
      payload.iss !== "solid-app-services" || payload.scope !== "realtime" ||
      typeof payload.sub !== "string" || payload.sub !== payload.webid ||
      !/^https?:\/\//.test(payload.sub) || typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Invalid realtime ticket.");
  }
  return payload.sub;
}
