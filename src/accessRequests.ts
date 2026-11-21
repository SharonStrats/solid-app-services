import { DatabaseSync } from "node:sqlite";
import { Resend } from "resend";
import { z } from "zod";
import { currentCaller } from "./security.js";

const resourceLabels = {
  "grade-9-chemistry": "Grade 9 Chemistry Quizzes"
} as const;

export const questionnaireAccessRequestSchema = z.object({
  resourceKey: z.enum(["grade-9-chemistry"]),
  resourceLabel: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(120).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional()
}).superRefine((value, context) => {
  if (value.resourceLabel !== resourceLabels[value.resourceKey]) {
    context.addIssue({ code: "custom", path: ["resourceLabel"], message: "resourceLabel does not match resourceKey" });
  }
});

export interface AccessRequestMailer {
  send(input: { to: string; from: string; subject: string; text: string }): Promise<void>;
}

export class ResendAccessRequestMailer implements AccessRequestMailer {
  private readonly client: Resend;

  constructor(private readonly apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(input: { to: string; from: string; subject: string; text: string }): Promise<void> {
    const { error } = await this.client.emails.send(input);
    if (error) throw new Error(`Resend request failed: ${error.message}`);
  }
}

export class AccessRequestStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS questionnaire_access_requests (
        web_id TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        request_day TEXT NOT NULL,
        idempotency_key TEXT,
        PRIMARY KEY (web_id, resource_key, request_day)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS questionnaire_access_requests_idempotency
        ON questionnaire_access_requests(web_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
  }

  claim(webId: string, resourceKey: string, idempotencyKey: string | undefined, now = new Date()): boolean {
    const requestDay = now.toISOString().slice(0, 10);
    return this.db.prepare(`
      INSERT OR IGNORE INTO questionnaire_access_requests
        (web_id, resource_key, request_day, idempotency_key)
      VALUES (?, ?, ?, ?)
    `).run(webId, resourceKey, requestDay, idempotencyKey ?? null).changes === 1;
  }

  close(): void {
    this.db.close();
  }
}

export interface AccessRequestClaimStore {
  claim(webId: string, resourceKey: string, idempotencyKey?: string, now?: Date): boolean;
}

export interface AccessRequestService {
  request(input: z.infer<typeof questionnaireAccessRequestSchema>): Promise<{ duplicate: boolean }>;
}

const safeDisplayName = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
};

export function createAccessRequestService(
  to: string,
  from: string,
  apiKey: string,
  databasePath: string,
  mailer: AccessRequestMailer = new ResendAccessRequestMailer(apiKey),
  store: AccessRequestClaimStore = new AccessRequestStore(databasePath)
): AccessRequestService {
  return {
    async request(input) {
      const webId = currentCaller();
      if (!webId) throw new Error("Authenticated WebID is unavailable");
      const duplicate = !store.claim(webId, input.resourceKey, input.idempotencyKey);
      if (duplicate) return { duplicate: true };
      const displayName = safeDisplayName(input.displayName);
      const requestedAt = new Date().toISOString();
      await mailer.send({
        to,
        from,
        subject: `Questionnaire access request: ${resourceLabels[input.resourceKey]}`,
        text: [
          "Questionnaire access request",
          `Requester WebID: ${webId}`,
          ...(displayName ? [`Requester display name: ${displayName}`] : []),
          `Requested resource: ${resourceLabels[input.resourceKey]} (${input.resourceKey})`,
          `Requested at: ${requestedAt}`
        ].join("\n")
      });
      return { duplicate: false };
    }
  };
}
