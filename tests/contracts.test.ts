import { describe, expect, it } from "vitest";
import { essayFeedbackResponseSchema } from "../src/contracts.js";

const legacyResponse = {
  overallFeedback: "Your position is clear.",
  strengths: ["The claim is relevant."],
  areasToImprove: ["Add a specific explanation."],
  criterionFeedback: [{
    criterion: "Ideas and content",
    score: 3,
    maxScore: 5,
    assessment: "The idea is relevant.",
    evidence: "\"The claim\"",
    nextStep: "Explain why the claim matters.",
    exampleRevision: "The claim matters because ..."
  }],
  nextChallenge: "Add one explanation.",
  paragraphFeedback: [],
  needsReview: false
};

describe("essay feedback contract", () => {
  it("continues to accept responses without the additive evidence signal", () => {
    expect(essayFeedbackResponseSchema.parse(legacyResponse)).toEqual(legacyResponse);
  });

  it("accepts the optional confidence and evidence quality signal", () => {
    const response = essayFeedbackResponseSchema.parse({
      ...legacyResponse,
      criterionFeedback: [{
        ...legacyResponse.criterionFeedback[0],
        confidence: 0.85,
        evidenceQuality: "direct"
      }]
    });
    expect(response.criterionFeedback?.[0]).toMatchObject({
      confidence: 0.85,
      evidenceQuality: "direct"
    });
  });
});
