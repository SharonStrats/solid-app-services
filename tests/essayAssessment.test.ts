import { describe, expect, it, vi } from "vitest";
import {
  essayAssessmentJsonSchema, essayScoringInstructions, essayTutoringInstructions,
  validateEssayAssessment, validateEssayFeedback, writingTaskGuidance
} from "../src/essayAssessment.js";
import { createAiServices } from "../src/aiServices.js";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { create }; } }));

const request = {
  essay: "Homework is bad. Students need free time. Schools should stop giving homework.",
  assignment: "Year 9. Write a 100–180-word persuasive paragraph about homework.",
  paragraphCount: 1,
  rubric: [{ criterion: "Ideas and content: relevant, clear and developed ideas", points: 5 }]
};

function analysis() {
  return {
    criteria: [{
      criterion: request.rubric[0].criterion, score: 2,
      justification: "The position is clear but the relevant ideas are only asserted.",
      quotes: ["Students need free time."], missing: ["Explanation of consequences"],
      confidence: 0.9, evidenceQuality: "direct" as const
    }],
    structure: { opening: "satisfactory" as const, conclusion: "weak" as const, explanation: "The final sentence repeats the position." },
    languageErrors: []
  };
}

function feedback() {
  return {
    overallFeedback: "Your position is clear, but explain the consequences.",
    strengths: ["Your position is clear."],
    areasToImprove: ["Explain why free time matters."],
    criterionFeedback: [{
      criterion: request.rubric[0].criterion, score: 2, maxScore: 5 as const,
      assessment: "The relevant ideas are stated rather than developed.",
      evidence: "Students need free time.",
      nextStep: "Explain one consequence of reduced free time.",
      exampleRevision: "Hypothetical example: a student with sports training may have less time for rest."
    }],
    nextChallenge: "Explain one consequence, then connect a specific example to it.",
    paragraphFeedback: [],
    needsReview: false
  };
}

describe("evidence-based essay assessment", () => {
  it("calibrates development, structure and language advice independently of clarity", () => {
    expect(essayScoringInstructions).toContain("check each reason separately");
    expect(essayScoringInstructions).toContain("present but weak");
    expect(essayScoringInstructions).toContain("every sentence");
    expect(essayScoringInstructions).toContain("Calibrate achievement to the supplied year level");
    expect(essayTutoringInstructions).toContain("Name the actual word, phrase, sentence or reasoning gap");
    expect(essayTutoringInstructions).toContain("mentioning another viewpoint");
    expect(essayTutoringInstructions).toContain("do not recommend sophisticated synonyms");
    expect(essayTutoringInstructions).toContain("Keep the criteria distinct");
    expect(essayTutoringInstructions).toContain("Do not suggest changing a sentence that is already clear");
    expect(essayTutoringInstructions).toContain("no more than two priority improvements");
    expect(essayTutoringInstructions).toContain("one primary, concrete and prioritised activity");
    expect(essayTutoringInstructions).toContain("optional refinement");
    expect(essayTutoringInstructions).toContain("explicitly tell the student that the work is excellent");
    expect(essayTutoringInstructions).toContain("varied improvement techniques");
  });

  it("uses the requested writing purpose instead of applying one generic rubric interpretation", () => {
    const descriptive = writingTaskGuidance({
      essay: "It was dark.",
      assignment: "Year 9. Describe a frightening experience using sensory language.",
      rubric: request.rubric
    });
    expect(descriptive).toContain("creates an experience for the reader");
    expect(descriptive).toContain("Do not require a moral, lesson");
    expect(descriptive).toContain("Do not award a high score merely because several senses are listed");
    expect(descriptive).toContain("do not recommend adding them");

    const persuasive = writingTaskGuidance(request);
    expect(persuasive).toContain("clarity and development of the position");
    expect(persuasive).not.toContain("creates an experience for the reader");
  });

  it("constrains provider quotations to actual submitted sentences without changing punctuation", () => {
    const schema = essayAssessmentJsonSchema({ essay: "I don't agree. Why is that?" });
    expect(schema.properties.criteria.items.properties.quotes).toEqual({
      type: "array", minItems: 1, items: { type: "string", enum: ["I don't agree.", "Why is that?"] }
    });
    expect(schema.properties.languageErrors.items.properties.quote.enum).toEqual(["I don't agree.", "Why is that?"]);
  });

  it("rejects invented quotations and language errors", () => {
    const inventedQuote = analysis();
    inventedQuote.criteria[0].quotes = ["Most students copy homework."];
    expect(() => validateEssayAssessment(inventedQuote, request)).toThrow("quoted text absent");
    expect(() => validateEssayAssessment({
      ...analysis(), languageErrors: [{ quote: "they was", rule: "Subject–verb agreement", correction: "they were" }]
    }, request)).toThrow("language error absent");
  });

  it("rejects a missing, duplicated or renamed rubric criterion", () => {
    expect(() => validateEssayAssessment({ ...analysis(), criteria: [] }, request)).toThrow();
    expect(() => validateEssayAssessment({
      ...analysis(), criteria: [analysis().criteria[0], analysis().criteria[0]]
    }, request)).toThrow("requested rubric");
    const renamed = analysis();
    renamed.criteria[0].criterion = "Structure";
    expect(() => validateEssayAssessment(renamed, request)).toThrow("requested rubric");
  });

  it("rejects high marks with no direct evidence, without imposing a fixed low score", () => {
    const high = analysis();
    high.criteria[0].score = 5;
    expect(validateEssayAssessment(high, request).criteria[0].score).toBe(5);
    high.criteria[0].quotes = [];
    expect(() => validateEssayAssessment(high, request)).toThrow("high score without direct evidence");
  });

  it("does not let feedback generation inflate an established score", () => {
    const inflated = feedback();
    inflated.criterionFeedback[0].score = 4;
    expect(() => validateEssayFeedback(inflated, analysis(), request)).toThrow("changed");
  });

  it.each([
    "In a survey, 70% of students admitted to not completing homework.",
    "70% of students do not complete homework.",
    "70 percent of students do not complete homework.",
    "According to a study, homework causes stress.",
    "Research shows homework reduces motivation."
  ])("rejects unsupported suggested evidence: %s", revision => {
    const invented = feedback();
    invented.criterionFeedback[0].exampleRevision = revision;
    expect(() => validateEssayFeedback(invented, analysis(), request)).toThrow("unsupported");
  });

  it("accepts a reasoned hypothetical example and carries uncertainty forward", () => {
    const uncertain = analysis();
    uncertain.criteria[0].confidence = 0.5;
    const result = validateEssayFeedback(feedback(), uncertain, request);
    expect(result.needsReview).toBe(true);
    expect(result.criterionFeedback?.[0].confidence).toBe(0.5);
  });

  it("scores before generating feedback and supplies fixed rubric levels to both stages", async () => {
    const tutoringOutput = feedback();
    tutoringOutput.criterionFeedback[0].score = 4;
    tutoringOutput.criterionFeedback[0].evidence = "A quotation the tutor invented.";
    create.mockReset()
      .mockResolvedValueOnce({ output_text: JSON.stringify(analysis()) })
      .mockResolvedValueOnce({ output_text: JSON.stringify(tutoringOutput) });
    const result = await createAiServices("test-key", "test-model").essayFeedback(request);
    expect(create).toHaveBeenCalledTimes(2);
    const scoring = create.mock.calls[0][0];
    const tutoring = create.mock.calls[1][0];
    expect(scoring.text.format.name).toBe("essay_assessment");
    expect(JSON.parse(scoring.input).rubric[0].levels).toHaveLength(5);
    expect(JSON.parse(tutoring.input).assessment).toEqual(analysis());
    expect(tutoring.text.format.schema.properties.criterionFeedback.items.properties).not.toHaveProperty("score");
    expect(result.criterionFeedback?.[0].score).toBe(2);
    expect(result.criterionFeedback?.[0].evidence).toBe("Students need free time.");
  });

  it("stops before feedback generation when the scoring evidence is invalid", async () => {
    const invalid = analysis();
    invalid.criteria[0].quotes = ["An invented sentence."];
    create.mockReset().mockResolvedValueOnce({ output_text: JSON.stringify(invalid) });
    await expect(createAiServices("test-key", "test-model").essayFeedback(request)).rejects.toThrow("quoted text absent");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("accepts feedback without a sentence revision while preserving the assessment", async () => {
    const assessed = analysis();
    assessed.criteria[0].score = 5;
    const tutoringOutput = feedback();
    tutoringOutput.criterionFeedback[0].exampleRevision = "";
    tutoringOutput.criterionFeedback[0].nextStep = "No correction is required; further practice is optional.";
    create.mockReset()
      .mockResolvedValueOnce({ output_text: JSON.stringify(assessed) })
      .mockResolvedValueOnce({ output_text: JSON.stringify(tutoringOutput) });

    const result = await createAiServices("test-key", "test-model").essayFeedback(request);

    expect(result.criterionFeedback?.[0]).toMatchObject({
      exampleRevision: "",
      nextStep: tutoringOutput.criterionFeedback[0].nextStep,
      score: 5,
      evidence: "Students need free time.",
      confidence: 0.9
    });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
