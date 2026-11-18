import OpenAI from "openai";
import type { UsageTracker } from "./usage.js";
import {
  assembleEssayFeedback, assessmentRubric, evidenceSentences, essayAssessmentJsonSchema, essayScoringInstructions,
  essayTutoringInstructions, validateEssayAssessment, writingTaskGuidance
} from "./essayAssessment.js";
import {
  flashcardGenerationResponseSchema,
  quizGenerationResponseSchema,
  type EssayFeedbackRequest,
  type EssayFeedbackResponse,
  promptGenerationResponseSchema,
  type PromptGenerationRequest,
  type PromptGenerationResponse,
  diagramDrawingEvaluationResponseSchema,
  type DiagramDrawingEvaluationRequest,
  type DiagramDrawingEvaluationResponse,
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
  generatePrompts: (request: PromptGenerationRequest) => Promise<PromptGenerationResponse>;
  generateQuiz: (request: TextGenerationRequest) => Promise<QuizGenerationResponse>;
  generateFlashcards: (request: TextGenerationRequest) => Promise<FlashcardGenerationResponse>;
  evaluateDiagramDrawing: (request: DiagramDrawingEvaluationRequest) => Promise<DiagramDrawingEvaluationResponse>;
}

export function createAiServices (apiKey: string | undefined, model: string, usage?: UsageTracker): AiServices {
  const client = apiKey ? new OpenAI({ apiKey, timeout: 120_000, maxRetries: 0 }) : undefined;
  const requireClient = (): OpenAI => {
    if (!client) throw new Error("OPENAI_API_KEY is required for AI generation");
    return client;
  };

  return {
    essayFeedback: async (request) => {
      const rubric = assessmentRubric(request);
      const analysis = await structured(
        requireClient(), model, "essay_assessment", essayAssessmentJsonSchema(request),
        `${essayScoringInstructions}\n${writingTaskGuidance(request)}`,
        { ...request, rubric, evidenceSentences: evidenceSentences(request.essay) },
        value => validateEssayAssessment(value, request), usage
      );
      return structured(
      requireClient(),
      model,
      "essay_feedback",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          overallFeedback: { type: "string" },
          strengths: { type: "array", items: { type: "string" } },
          areasToImprove: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
          criterionFeedback: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                criterion: { type: "string" },
                assessment: { type: "string" },
                nextStep: { type: "string" },
                exampleRevision: { type: "string" }
              },
              required: [
                "criterion",
                "assessment",
                "nextStep",
                "exampleRevision"
              ]
            }
          },
          nextChallenge: { type: "string" },
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
        required: ["overallFeedback", "strengths", "areasToImprove", "criterionFeedback", "nextChallenge", "paragraphFeedback", "needsReview"]
      },
      `${essayTutoringInstructions}\n${writingTaskGuidance(request)}`,
      { ...request, rubric, assessment: analysis },
      (value) => assembleEssayFeedback(value, analysis, request),
      usage
      );
    },
    generatePrompts: (request) => structured(
      requireClient(),
      model,
      "english_prompt_generation",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          prompts: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                instruction: { type: "string" },
                writingType: { type: "string" },
                suggestedWordCount: { type: "string" },
                skills: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
                rubric: {
                  type: "array",
                  maxItems: 8,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: { criterion: { type: "string" }, description: { type: "string" } },
                    required: ["criterion", "description"]
                  }
                }
              },
              required: ["title", "instruction", "writingType", "suggestedWordCount", "skills", "rubric"]
            }
          }
        },
        required: ["prompts"]
      },
      "Create age-appropriate English writing prompts for the Victorian Curriculum. Generate distinct prompts for the requested topic and writing type. Match the year level, difficulty, and word range. Each instruction must be specific enough to answer, and each skills list and rubric must describe what the student should practise. Do not require research or specialist knowledge unless the request asks for it.",
      request,
      (value) => promptGenerationResponseSchema.parse(value),
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
    ),
    evaluateDiagramDrawing: (request) => structured(
      requireClient(),
      model,
      "diagram_drawing_evaluation",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          decision: { type: "string", enum: ["correct", "possibly-correct", "incorrect", "needs-review"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          feedback: { type: "string" },
          evidence: { type: "array", items: { type: "string" }, maxItems: 10 },
          needsReview: { type: "boolean" }
        },
        required: ["decision", "confidence", "feedback", "evidence", "needsReview"]
      },
      "Compare the learner's drawing with the reference diagram and the question. Determine whether the learner appears to have completed the requested diagram task. Treat visual ambiguity, missing rubric detail, and uncertain interpretation as needs-review or possibly-correct rather than claiming certainty. Do not infer correctness from visual similarity alone when the prompt does not specify what should be drawn. Return concise evidence grounded in visible features.",
      {
        question: request.question,
        referenceImage: request.referenceImage,
        answerImage: request.answerImage
      },
      (value) => diagramDrawingEvaluationResponseSchema.parse(value),
      usage
    )
  };
}
