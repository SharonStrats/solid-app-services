import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { RequestHandler } from "express";
import { createAccessRequestService } from "../src/accessRequests.js";
import { runWithCaller } from "../src/security.js";

const authenticated: RequestHandler = (_request, _response, next) => next();
const testApp = (grader = vi.fn()) => createApp(grader, ["https://quiz.example"], undefined, undefined, undefined, authenticated);
const accessRequestMailer = { send: vi.fn().mockResolvedValue(undefined) };
const accessRequestApp = () => createApp(
  vi.fn(),
  ["https://quiz.example"],
  undefined,
  undefined,
  undefined,
  (_request, _response, next) => runWithCaller("https://id.example/profile#me", next),
  undefined,
  createAccessRequestService("admin@example.com", "quiz@example.com", "test-key", ":memory:", accessRequestMailer, {
    claim: vi.fn().mockReturnValue(true),
  })
);

const validRequest = {
  question: "Why do plants need sunlight?",
  studentAnswer: "They use sunlight to make food.",
  rubric: [
    { criterion: "mentions sunlight", points: 1 },
    { criterion: "explains that plants make food", points: 1 }
  ],
  maxScore: 2
};

describe("sidecar HTTP API", () => {
  it("reports health", async () => {
    const response = await request(createApp(vi.fn(), ["http://localhost:3000"])).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("rejects malformed grading requests", async () => {
    const response = await request(testApp())
      .post("/api/grade/short-answer")
      .send({ ...validRequest, maxScore: 3 });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
  });

  it("grades a valid request through the injected grader", async () => {
    const result = {
      decision: "correct",
      score: 2,
      maxScore: 2,
      confidence: 0.9,
      feedback: "Good answer.",
      matchedCriteria: ["mentions sunlight", "explains that plants make food"],
      missingCriteria: [],
      needsReview: false
    } as const;
    const gradeAnswer = vi.fn().mockResolvedValue(result);
    const response = await request(testApp(gradeAnswer))
      .post("/api/grade/short-answer")
      .send(validRequest);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(gradeAnswer).toHaveBeenCalledOnce();
  });

  it("fails closed when security is not configured", async () => {
    const grader = vi.fn();
    const app = createApp(grader, []);
    for (const path of ["/api/grade/short-answer", "/api/import/document", "/mcp", "/realtime/ticket"]) {
      expect((await request(app).post(path).send(validRequest)).status).toBe(503);
    }
    expect(grader).not.toHaveBeenCalled();
  });

  it("sends a validated authenticated questionnaire access request", async () => {
    const response = await request(accessRequestApp())
      .post("/api/access-requests/questionnaires")
      .send({ resourceKey: "grade-9-chemistry", resourceLabel: "Grade 9 Chemistry Quizzes", displayName: "A Student" });
    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);
    expect(accessRequestMailer.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "admin@example.com",
      from: "quiz@example.com",
      text: expect.stringContaining("Requester WebID: https://id.example/profile#me")
    }));
  });

  it("rejects unknown questionnaire resources", async () => {
    accessRequestMailer.send.mockClear();
    const response = await request(accessRequestApp())
      .post("/api/access-requests/questionnaires")
      .send({ resourceKey: "all-quizzes", resourceLabel: "All quizzes" });
    expect(response.status).toBe(400);
    expect(accessRequestMailer.send).not.toHaveBeenCalled();
  });
});
