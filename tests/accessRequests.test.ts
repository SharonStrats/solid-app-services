import { describe, expect, it, vi } from "vitest";
import { AccessRequestStore, createAccessRequestService } from "../src/accessRequests.js";
import { runWithCaller } from "../src/security.js";

describe("questionnaire access requests", () => {
  it("does not send duplicate requests for the same WebID and resource in one day", async () => {
    const store = new AccessRequestStore(":memory:");
    const mailer = { send: vi.fn().mockResolvedValue(undefined) };
    const service = createAccessRequestService("admin@example.com", "quiz@example.com", "test", ":memory:", mailer, store);
    const input = { resourceKey: "grade-9-chemistry" as const, resourceLabel: "Grade 9 Chemistry Quizzes" };

    await runWithCaller("https://id.example/profile#me", () => service.request(input));
    const duplicate = await runWithCaller("https://id.example/profile#me", () => service.request(input));

    expect(duplicate).toEqual({ duplicate: true });
    expect(mailer.send).toHaveBeenCalledOnce();
    store.close();
  });
});
