import OpenAI from "openai";
import { gradingResponseSchema, type GradingRequest, type GradingResponse } from "./contracts.js";

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["correct", "partial", "needs-review"] },
    score: { type: "integer", minimum: 0 },
    maxScore: { type: "integer", minimum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    feedback: { type: "string" },
    matchedCriteria: { type: "array", items: { type: "string" } },
    missingCriteria: { type: "array", items: { type: "string" } },
    needsReview: { type: "boolean" }
  },
  required: ["decision", "score", "maxScore", "confidence", "feedback", "matchedCriteria", "missingCriteria", "needsReview"]
} as const;

export function createGrader(apiKey: string | undefined, model: string) {
  const client = apiKey ? new OpenAI({ apiKey }) : undefined;

  return async function gradeAnswer(request: GradingRequest): Promise<GradingResponse> {
    if (!client) {
      throw new Error("OPENAI_API_KEY is required to grade an answer");
    }
    const response = await client.responses.create({
      model,
      instructions: [
        "You grade a questionnaire short answer against the supplied rubric.",
        "Award only points supported by the student's answer. Use needs-review when the answer is ambiguous.",
        "Confidence is an estimate, not a guaranteed probability. Return only the requested JSON."
      ].join(" "),
      input: JSON.stringify(request),
      text: {
        format: {
          type: "json_schema",
          name: "short_answer_grading",
          strict: true,
          schema: responseSchema
        }
      }
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.output_text);
    } catch {
      throw new Error("OpenAI returned invalid grading JSON");
    }
    const result = gradingResponseSchema.parse(parsed);
    if (result.maxScore !== request.maxScore || result.score > result.maxScore) {
      throw new Error("OpenAI returned an invalid score");
    }
    return result;
  };
}

export type GradeAnswer = (request: GradingRequest) => Promise<GradingResponse>;
