import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

const maxExtractedCharacters = 100_000;

export interface ExtractedDocument {
  filename: string;
  mediaType: string;
  text: string;
  characters: number;
}

function normalizeText (text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, maxExtractedCharacters);
}

export async function extractDocument (
  file: { originalname: string, mimetype: string, buffer: Buffer }
): Promise<ExtractedDocument> {
  const extension = file.originalname.toLowerCase().split(".").pop();
  let text: string;

  if (extension === "docx" || file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
  } else if (extension === "pdf" || file.mimetype === "application/pdf") {
    const parser = new PDFParse({ data: file.buffer });
    try {
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else if (extension === "txt" || extension === "md" || file.mimetype.startsWith("text/")) {
    text = file.buffer.toString("utf8");
  } else {
    throw new Error("Only PDF, DOCX, Markdown, and text files are supported.");
  }

  const normalized = normalizeText(text);
  if (!normalized) throw new Error("The document did not contain extractable text.");
  return {
    filename: file.originalname,
    mediaType: file.mimetype,
    text: normalized,
    characters: normalized.length
  };
}
