import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { z } from "zod";
import type { AiServices } from "./aiServices.js";

function result (value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

export async function handleMcpRequest (
  request: Request,
  response: Response,
  services: AiServices
): Promise<void> {
  const server = new McpServer({
    name: "solid-ai-services",
    version: "0.1.0"
  });

  server.registerTool("essay_feedback", {
    description: "Give constructive paragraph-level feedback on an essay without rewriting it.",
    inputSchema: {
      essay: z.string().min(1).max(50_000),
      assignment: z.string().max(10_000).optional(),
      rubric: z.array(z.object({
        criterion: z.string().min(1).max(1_000),
        points: z.number().int().min(0).max(100)
      })).max(20).optional()
    }
  }, async (input) => result(await services.essayFeedback(input)));

  server.registerTool("generate_quiz", {
    description: "Generate an editable quiz from source text with explanations and source references.",
    inputSchema: {
      text: z.string().min(1).max(100_000),
      title: z.string().max(500).optional(),
      count: z.number().int().min(1).max(30).default(10),
      difficulty: z.enum(["easy", "medium", "hard", "mixed"]).default("mixed")
    }
  }, async (input) => result(await services.generateQuiz(input)));

  server.registerTool("generate_flashcards", {
    description: "Generate concise study flashcards from source text.",
    inputSchema: {
      text: z.string().min(1).max(100_000),
      title: z.string().max(500).optional(),
      count: z.number().int().min(1).max(30).default(10),
      difficulty: z.enum(["easy", "medium", "hard", "mixed"]).default("mixed")
    }
  }, async (input) => result(await services.generateFlashcards(input)));

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(request, response, request.body);
}
