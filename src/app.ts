import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import multer from "multer";
import { createAiServices, type AiServices } from "./aiServices.js";
import { extractDocument } from "./documentExtractor.js";
import { essayFeedbackRequestSchema, gradingRequestSchema, textGenerationRequestSchema } from "./contracts.js";
import type { GradeAnswer } from "./grader.js";
import { handleMcpRequest } from "./mcp.js";

export function createApp (
  gradeAnswer: GradeAnswer,
  corsOrigins: string[],
  aiServices?: AiServices
) {
  const app = express();
  const upload = multer({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  const services = aiServices ?? createAiServices(undefined, "gpt-6.1-sol");

  app.use(cors({
    origin: corsOrigins.includes("*") ? true : corsOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Mcp-Session-Id"]
  }));
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "solid-ai-services" });
  });

  app.post("/api/grade/short-answer", async (request, response, next) => {
    const parsed = gradingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_request",
        message: "Request did not match the short-answer grading contract",
        details: parsed.error.issues
      });
      return;
    }
    try {
      response.json(await gradeAnswer(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/feedback/essay", async (request, response, next) => {
    const parsed = essayFeedbackRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      return;
    }
    try {
      response.json(await services.essayFeedback(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/import/document", upload.single("file"), async (request, response, next) => {
    if (!request.file) {
      response.status(400).json({ error: "invalid_request", message: "A file field is required." });
      return;
    }
    try {
      response.json(await extractDocument(request.file));
    } catch (error) {
      next(error);
    }
  });

  const generationRoute = (
    path: string,
    generate: (input: ReturnType<typeof textGenerationRequestSchema.parse>) => Promise<unknown>
  ): void => {
    app.post(path, async (request, response, next) => {
      const parsed = textGenerationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_request", details: parsed.error.issues });
        return;
      }
      try {
        response.json(await generate(parsed.data));
      } catch (error) {
        next(error);
      }
    });
  };
  generationRoute("/api/generate/quiz", services.generateQuiz);
  generationRoute("/api/generate/flashcards", services.generateFlashcards);

  if (aiServices) {
    app.post("/mcp", async (request, response, next) => {
      try {
        await handleMcpRequest(request, response, aiServices);
      } catch (error) {
        next(error);
      }
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    console.error(error);
    const message = error instanceof Error ? error.message : "The request could not be completed";
    const clientError = message.includes("supported") || message.includes("extractable");
    response.status(clientError ? 400 : 502).json({
      error: clientError ? "invalid_request" : "ai_unavailable",
      message: clientError ? message : "The AI provider could not produce a result"
    });
  };
  app.use(errorHandler);
  return app;
}
