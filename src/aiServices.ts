import OpenAI from "openai";
import type { UsageTracker } from "./usage.js";
import {
  essayFeedbackResponseSchema,
  flashcardGenerationResponseSchema,
  quizGenerationResponseSchema,
  type EssayFeedbackRequest,
  type EssayFeedbackResponse,
  type FlashcardGenerationResponse,
  type QuizGenerationResponse,
  type TextGenerationRequest
} from "./contracts.js";

type JsonSchema = Record<string, unknown>;

async function structured<T> (
  client: OpenAI,
  model: string,
  name: string,
  schema: JsonSchema,
  instructions: string,
  input: unknown,
  parse: (value: unknown) => T,
  usage: UsageTracker | undefined
): Promise<T> {
  const response = await client.responses.create({
    model,
    instructions,
    input: JSON.stringify(input),
    max_output_tokens: 16_000,
    text: { format: { type: "json_schema", name, strict: true, schema } }
  });
  if (response.usage) usage?.record(name, model, response.usage);
  let value: unknown;
  try {
    value = JSON.parse(response.output_text);
  } catch {
    throw new Error("OpenAI returned invalid JSON");
  }
  return parse(value);
}

export interface AiServices {
  essayFeedback: (request: EssayFeedbackRequest) => Promise<EssayFeedbackResponse>;
  generateQuiz: (request: TextGenerationRequest) => Promise<QuizGenerationResponse>;
  generateFlashcards: (request: TextGenerationRequest) => Promise<FlashcardGenerationResponse>;
}

export function createAiServices (apiKey: string | undefined, model: string, usage?: UsageTracker): AiServices {
  const client = apiKey ? new OpenAI({ apiKey, timeout: 120_000, maxRetries: 0 }) : undefined;
  const requireClient = (): OpenAI => {
    if (!client) throw new Error("OPENAI_API_KEY is required for AI generation");
    return client;
  };

  return {
    essayFeedback: (request) => structured(
      requireClient(),
      model,
      "essay_feedback",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          overallFeedback: { type: "string" },
          strengths: { type: "array", items: { type: "string" } },
          areasToImprove: { type: "array", items: { type: "string" } },
          paragraphFeedback: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                paragraph: { type: "integer", minimum: 1 },
                feedback: { type: "string" },
                suggestion: { type: "string" }
              },
              required: ["paragraph", "feedback", "suggestion"]
            }
          },
          needsReview: { type: "boolean" }
        },
        required: ["overallFeedback", "strengths", "areasToImprove", "paragraphFeedback", "needsReview"]
      },
      "Give constructive, specific feedback on the student's actual writing. Do not rewrite it. Assess each supplied rubric criterion using concrete phrases or omissions from the student's text, explain why each improvement matters, and give an actionable next step tied to the assignment. Only return paragraphFeedback for the paragraphs that actually exist; if paragraphCount is supplied, return no more than that many paragraph entries. Identify strengths before improvements.",
      request,
      (value) => essayFeedbackResponseSchema.parse(value),
      usage
    ),
    generateQuiz: (request) => structured(
      requireClient(),
      model,
      "quiz_generation",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string", enum: ["multiple-choice", "true-false", "short-answer"] },
                question: { type: "string" },
                options: { type: "array", items: { type: "string" } },
                answer: { type: "string" },
                explanation: { type: "string" },
                sourceReference: { type: "string" }
              },
              required: ["type", "question", "options", "answer", "explanation", "sourceReference"]
            }
          }
        },
        required: ["title", "questions"]
      },
      "Create accurate, varied questions from the supplied source. Cover the important ideas, avoid trivia, include explanations and source references, and follow the requested count and difficulty.",
      request,
      (value) => quizGenerationResponseSchema.parse(value),
      usage
    ),
    generateFlashcards: (request) => structured(
      requireClient(),
      model,
      "flashcard_generation",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          cards: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                front: { type: "string" },
                back: { type: "string" },
                sourceReference: { type: "string" },
                difficulty: { type: "string", enum: ["easy", "medium", "hard"] }
              },
              required: ["front", "back", "sourceReference", "difficulty"]
            }
          }
        },
        required: ["title", "cards"]
      },
      "Create concise, useful study flashcards from the supplied source. Test important concepts, avoid duplicate cards, and include source references.",
      request,
      (value) => flashcardGenerationResponseSchema.parse(value),
      usage
    )
  };
}
