import { createHash } from "node:crypto";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { strFromU8, unzipSync } from "fflate";

const maxExtractedCharacters = 100_000;

export interface ExtractedDocument {
  filename: string;
  mediaType: string;
  text: string;
  characters: number;
  sourceDocumentHash: string;
  sourceDocumentVersion: string;
  warnings: string[];
}

function normalizeText (text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, maxExtractedCharacters);
}

function xmlText (xml: string): string {
  return [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map(match => match[1]
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"").replace(/&apos;/g, "'"))
    .join(" ");
}

function extractPowerPointText (buffer: Buffer): string {
  const files = unzipSync(new Uint8Array(buffer));
  const slideNames = Object.keys(files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  return slideNames.map(name => {
    const xml = strFromU8(files[name]);
    const shapes = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? [];
    const slideText = shapes.map(shape => xmlText(shape)).filter(Boolean);
    const tables = xml.match(/<a:tbl\b[\s\S]*?<\/a:tbl>/g) ?? [];
    slideText.push(...tables.map(table => xmlText(table)).filter(Boolean));
    return slideText.join("\n");
  }).filter(Boolean).join("\n\n");
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
  } else if (extension === "pptx" || file.mimetype === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    text = extractPowerPointText(file.buffer);
  } else {
    throw new Error("Only PDF, DOCX, PowerPoint, Markdown, and text files are supported.");
  }

  const normalized = normalizeText(text);
  if (!normalized) throw new Error("The document did not contain extractable text.");
  const sourceDocumentHash = createHash("sha256").update(file.buffer).digest("hex");
  const warnings = text.length > maxExtractedCharacters
    ? ["Extracted text was truncated at 100,000 characters."]
    : [];
  return {
    filename: file.originalname,
    mediaType: file.mimetype,
    text: normalized,
    characters: normalized.length,
    sourceDocumentHash,
    sourceDocumentVersion: `sha256-${sourceDocumentHash}`,
    warnings
  };
}
