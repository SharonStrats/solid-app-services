import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import cors from "cors";
import multer from "multer";
import { createAiServices, type AiServices } from "./aiServices.js";
import { extractDocument } from "./documentExtractor.js";
import { diagramDrawingEvaluationRequestSchema, essayFeedbackRequestSchema, gradingRequestSchema, promptGenerationRequestSchema, quizImportRequestSchema, textGenerationRequestSchema } from "./contracts.js";
import type { GradeAnswer } from "./grader.js";
import { handleMcpRequest } from "./mcp.js";
import type { UsageTracker } from "./usage.js";
import { AiBusyError, createRealtimeTicket, currentCaller, withAiCapacity } from "./security.js";
import { questionnaireAccessRequestSchema, type AccessRequestService } from "./accessRequests.js";

export function createApp (
  gradeAnswer: GradeAnswer,
  corsOrigins: string[],
  aiServices?: AiServices,
  usage?: UsageTracker,
  usageMetricsToken?: string,
  security: RequestHandler = (_request, response) => {
    response.status(503).json({ error: "security_unconfigured" });
  },
  realtimeTicketSecret?: string,
  accessRequests?: AccessRequestService
) {
  const app = express();
  app.disable("x-powered-by");
  const upload = multer({ limits: { fileSize: 40 * 1024 * 1024, files: 1 } });
  const services = aiServices ?? createAiServices(undefined, "gpt-6.1-sol");

  app.use(cors({
    origin: corsOrigins.includes("*") ? true : corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Mcp-Session-Id", "Authorization", "DPoP"]
  }));
  app.use(["/api", "/mcp", "/realtime"], security);
  app.use(express.json({ limit: "12mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "solid-app-services" });
  });
  const issueRealtimeTicket: RequestHandler = async (_request, response) => {
    const webId = currentCaller();
    if (!webId || !realtimeTicketSecret) {
      response.status(503).json({ error: "realtime_unconfigured" });
      return;
    }
    response.json({ ticket: await createRealtimeTicket(webId, realtimeTicketSecret) });
  };
  app.post("/api/realtime/ticket", issueRealtimeTicket);
  app.post("/realtime/ticket", issueRealtimeTicket);
  app.post("/api/access-requests/questionnaires", async (request, response, next) => {
    if (!accessRequests) {
      response.status(503).json({ error: "access_requests_unconfigured" });
      return;
    }
    const parsed = questionnaireAccessRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      return;
    }
    try {
      const result = await accessRequests.request(parsed.data);
      response.status(202).json({
        accepted: true,
        duplicate: result.duplicate,
        message: result.duplicate ? "Your request was already sent recently." : "Your request was sent."
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/metrics/usage", (request, response) => {
    if (!usage || !usageMetricsToken || request.get("authorization") !== `Bearer ${usageMetricsToken}`) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.json(usage.summary());
  });

  app.post("/api/grade/short-answer", async (request, response, next) => {
    const parsed = gradingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_request",
        message: "Request did not match the short-answer grading contract",
        details: parsed.error.issues
      });

      app.post("/api/grade/diagram-drawing", async (request, response, next) => {
        const parsed = diagramDrawingEvaluationRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({
            error: "invalid_request",
            message: "Request did not match the diagram-drawing evaluation contract",
            details: parsed.error.issues
          });
          return;
        }
        try {
          response.json(await withAiCapacity(() => services.evaluateDiagramDrawing(parsed.data)));
        } catch (error) {
          next(error);
        }
      });
      return;
    }
    try {
      response.json(await withAiCapacity(() => gradeAnswer(parsed.data)));
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
      response.json(await withAiCapacity(() => services.essayFeedback(parsed.data)));
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
      const file = request.file;
      response.json(await withAiCapacity(() => extractDocument(file)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/import/quiz", async (request, response, next) => {
    const parsed = quizImportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      return;
    }
    try {
      const sourceText = parsed.data.document.blocks.map((block) => block.text).join("\n\n");
      const generated = await withAiCapacity(() => services.generateQuiz({
        text: sourceText,
        title: parsed.data.document.name,
        count: parsed.data.maxQuestions,
        difficulty: "mixed"
      }));
      response.json({
        questions: generated.questions.map((question, index) => {
          const block = parsed.data.document.blocks[index % parsed.data.document.blocks.length];
          return {
            title: question.question,
            type: question.type,
            options: question.options ?? [],
            correctAnswers: [question.answer],
            confidence: 0.8,
            warnings: [],
            sourceItems: [question.sourceReference],
            sourceBlock: block
          };
        }),
        warnings: parsed.data.document.warnings
      });
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
        response.json(await withAiCapacity(() => generate(parsed.data)));
      } catch (error) {
        next(error);
      }
    });
  };
  generationRoute("/api/generate/quiz", services.generateQuiz);
  generationRoute("/api/generate/flashcards", services.generateFlashcards);
  app.post("/api/generate/english-prompts", async (request, response, next) => {
    const parsed = promptGenerationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      return;
    }
    try {
      response.json(await withAiCapacity(() => services.generatePrompts(parsed.data)));
    } catch (error) {
      next(error);
    }
  });

  if (aiServices) {
    app.post("/mcp", async (request, response, next) => {
      try {
        await withAiCapacity(() => handleMcpRequest(request, response, aiServices));
      } catch (error) {
        next(error);
      }
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    console.error("API request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error)
    });
    if (error instanceof AiBusyError) {
      response.set("Retry-After", "5").status(429).json({ error: "busy", message: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : "The request could not be completed";
    const clientError = message.includes("supported") || message.includes("extractable") || error?.code === "LIMIT_FILE_SIZE";
    const clientMessage = error?.code === "LIMIT_FILE_SIZE"
      ? "The document is too large. Please choose a file smaller than 40 MB."
      : message;
    response.status(clientError ? 400 : 502).json({
      error: clientError ? "invalid_request" : "ai_unavailable",
      message: clientError ? clientMessage : "The AI provider could not produce a result"
    });
  };
  app.use(errorHandler);
  return app;
}
