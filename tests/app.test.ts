import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

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
    const response = await request(createApp(vi.fn(), ["*"]))
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
    const response = await request(createApp(gradeAnswer, ["*"]))
      .post("/api/grade/short-answer")
      .send(validRequest);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(gradeAnswer).toHaveBeenCalledOnce();
  });
});
