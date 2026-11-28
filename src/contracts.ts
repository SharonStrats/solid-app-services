import { z } from "zod";

export const gradingRequestSchema = z.object({
  question: z.string().trim().min(1).max(10_000),
  studentAnswer: z.string().trim().min(1).max(10_000),
  expectedAnswer: z.string().trim().max(10_000).optional(),
  rubric: z.array(z.object({
    criterion: z.string().trim().min(1).max(1_000),
    points: z.number().int().min(0).max(100)
  })).min(1).max(20),
  maxScore: z.number().int().positive().max(2_000)
}).superRefine((value, context) => {
  const rubricPoints = value.rubric.reduce((sum, item) => sum + item.points, 0);
  if (rubricPoints !== value.maxScore) {
    context.addIssue({
      code: "custom",
      path: ["maxScore"],
      message: "maxScore must equal the sum of rubric points"
    });
  }
});

export type GradingRequest = z.infer<typeof gradingRequestSchema>;

const imageDataUrlSchema = z.string()
  .max(12_000_000)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Image must be a PNG, JPEG, or WebP data URL");

export const diagramDrawingEvaluationRequestSchema = z.object({
  question: z.string().trim().min(1).max(10_000),
  referenceImage: imageDataUrlSchema,
  answerImage: imageDataUrlSchema
});

export type DiagramDrawingEvaluationRequest = z.infer<typeof diagramDrawingEvaluationRequestSchema>;

export const diagramDrawingEvaluationResponseSchema = z.object({
  decision: z.enum(["correct", "possibly-correct", "incorrect", "needs-review"]),
  confidence: z.number().min(0).max(1),
  feedback: z.string().min(1).max(4_000),
  evidence: z.array(z.string().min(1)).max(10),
  needsReview: z.boolean()
});

export type DiagramDrawingEvaluationResponse = z.infer<typeof diagramDrawingEvaluationResponseSchema>;

export const gradingResponseSchema = z.object({
  decision: z.enum(["correct", "partial", "needs-review"]),
  score: z.number().int().min(0),
  maxScore: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  feedback: z.string().min(1).max(4_000),
  matchedCriteria: z.array(z.string()),
  missingCriteria: z.array(z.string()),
  needsReview: z.boolean()
});

export type GradingResponse = z.infer<typeof gradingResponseSchema>;

const rubricSchema = z.array(z.object({
  criterion: z.string().trim().min(1).max(1_000),
  points: z.number().int().min(0).max(100)
})).max(20);

export const essayFeedbackRequestSchema = z.object({
  essay: z.string().trim().min(1).max(50_000),
  assignment: z.string().trim().max(10_000).optional(),
  paragraphCount: z.number().int().min(1).max(100).optional(),
  rubric: rubricSchema.optional()
});

export type EssayFeedbackRequest = z.infer<typeof essayFeedbackRequestSchema>;

export const essayFeedbackResponseSchema = z.object({
  overallFeedback: z.string().min(1).max(8_000),
  strengths: z.array(z.string().min(1)).max(10),
  areasToImprove: z.array(z.string().min(1)).max(10),
  criterionFeedback: z.array(z.object({
    criterion: z.string().min(1),
    score: z.number().int().min(1).max(5),
    maxScore: z.literal(5),
    assessment: z.string().min(1),
    evidence: z.string().min(1),
    nextStep: z.string().min(1),
    exampleRevision: z.string(),
    // Optional additive fields keep older questionnaire clients compatible.
    confidence: z.number().min(0).max(1).optional(),
    evidenceQuality: z.enum(["direct", "partial", "missing", "ambiguous"]).optional()
  })).max(20).optional(),
  nextChallenge: z.string().min(1).max(4_000).optional(),
  paragraphFeedback: z.array(z.object({
    paragraph: z.number().int().positive(),
    feedback: z.string().min(1),
    suggestion: z.string().min(1)
  })).max(100),
  needsReview: z.boolean()
});

export type EssayFeedbackResponse = z.infer<typeof essayFeedbackResponseSchema>;

export const promptGenerationRequestSchema = z.object({
  yearLevel: z.number().int().min(1).max(12),
  curriculum: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(200),
  writingType: z.enum(["paragraph", "essay", "creative", "text-response", "persuasive", "comprehension", "exam-practice"]),
  topic: z.string().trim().min(1).max(500),
  difficulty: z.enum(["easy", "medium", "hard"]),
  wordCount: z.object({ min: z.number().int().positive().max(5_000), max: z.number().int().positive().max(5_000) }),
  count: z.number().int().min(1).max(10)
}).superRefine((value, context) => {
  if (value.wordCount.min > value.wordCount.max) {
    context.addIssue({ code: "custom", path: ["wordCount"], message: "Minimum word count cannot exceed maximum" });
  }
});

export type PromptGenerationRequest = z.infer<typeof promptGenerationRequestSchema>;

export const promptGenerationResponseSchema = z.object({
  prompts: z.array(z.object({
    title: z.string().min(1),
    instruction: z.string().min(1),
    writingType: z.string().min(1),
    suggestedWordCount: z.string().min(1),
    skills: z.array(z.string().min(1)).min(1).max(8),
    rubric: z.array(z.object({
      criterion: z.string().min(1),
      description: z.string().min(1)
    })).max(8)
  })).min(1).max(10)
});

export type PromptGenerationResponse = z.infer<typeof promptGenerationResponseSchema>;

export const textGenerationRequestSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  title: z.string().trim().max(500).optional(),
  count: z.number().int().min(1).max(100).default(10),
  difficulty: z.enum(["easy", "medium", "hard", "mixed"]).default("mixed")
});

export type TextGenerationRequest = z.infer<typeof textGenerationRequestSchema>;

export const quizImportRequestSchema = z.object({
  format: z.enum(["quiz", "survey"]),
  document: z.object({
    name: z.string().min(1).max(500),
    mediaType: z.string().max(200),
    blocks: z.array(z.object({
      kind: z.enum(["heading", "paragraph", "list", "table", "notes"]),
      text: z.string().min(1).max(100_000),
      sourceDocument: z.string().min(1),
      mediaType: z.string().max(200),
      page: z.number().int().positive().optional(),
      slide: z.number().int().positive().optional(),
      warnings: z.array(z.string()).default([])
    })).min(1).max(2_000),
    warnings: z.array(z.string()).default([]),
    sourceDocumentUri: z.string().url().optional()
  }),
  maxQuestions: z.number().int().min(1).max(6).default(6)
});

export type QuizImportRequest = z.infer<typeof quizImportRequestSchema>;

export const quizQuestionSchema = z.object({
  type: z.enum(["multiple-choice", "true-false", "short-answer"]),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).max(6),
  answer: z.string().min(1),
  explanation: z.string().min(1),
  sourceReference: z.string().min(1)
});

export const quizGenerationResponseSchema = z.object({
  title: z.string().min(1),
  questions: z.array(quizQuestionSchema).min(1).max(30)
});

export type QuizGenerationResponse = z.infer<typeof quizGenerationResponseSchema>;

export const flashcardSchema = z.object({
  front: z.string().min(1),
  back: z.string().min(1),
  sourceReference: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"])
});

export const flashcardGenerationResponseSchema = z.object({
  title: z.string().min(1),
  cards: z.array(flashcardSchema).min(1).max(100)
});

export type FlashcardGenerationResponse = z.infer<typeof flashcardGenerationResponseSchema>;
