import "dotenv/config";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAiServices } from "../src/aiServices.js";
import { essayFeedbackRequestSchema } from "../src/contracts.js";
import { assessmentRubric } from "../src/essayAssessment.js";

const fixturePath = process.env.ESSAY_CALIBRATION_FILE;
const fixtureSchema = z.array(z.object({
  id: z.string().min(1),
  provenance: z.string().min(1),
  request: essayFeedbackRequestSchema,
  referenceScores: z.array(z.number().int().min(1).max(5)).min(1).max(20)
})).min(1).max(50);

describe.skipIf(!fixturePath)("live essay calibration (explicit opt-in; uses provider credits)", () => {
  it("measures repeated scores against independently marked references", async () => {
    if (!fixturePath || !process.env.OPENAI_API_KEY) {
      throw new Error("ESSAY_CALIBRATION_FILE and OPENAI_API_KEY are required");
    }
    const fixtures = fixtureSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
    const services = createAiServices(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL ?? "gpt-6.1-sol");
    const reports = [];
    for (const fixture of fixtures) {
      const rubric = assessmentRubric(fixture.request);
      expect(fixture.referenceScores).toHaveLength(rubric.length);
      const scores: number[][] = [];
      for (let repetition = 0; repetition < 5; repetition++) {
        const result = await services.essayFeedback(fixture.request);
        if (!result.criterionFeedback) throw new Error("Calibration response is missing criterion feedback");
        scores.push(result.criterionFeedback.map(item => item.score));
      }
      const criteria = rubric.map((item, index) => {
        const runs = scores.map(run => run[index]);
        return {
          criterion: item.criterion,
          reference: fixture.referenceScores[index],
          runs,
          spread: Math.max(...runs) - Math.min(...runs),
          meanAbsoluteError: runs.reduce((sum, score) => sum + Math.abs(score - fixture.referenceScores[index]), 0) / runs.length
        };
      });
      reports.push({ id: fixture.id, provenance: fixture.provenance, criteria });
    }
    console.info(JSON.stringify(reports, null, 2));
    for (const report of reports) {
      for (const criterion of report.criteria) {
        expect(criterion.spread, `${report.id}: ${criterion.criterion} repeated-score spread`).toBeLessThanOrEqual(1);
        expect(criterion.meanAbsoluteError, `${report.id}: ${criterion.criterion} reference-score error`).toBeLessThanOrEqual(1);
      }
    }
  }, 7_200_000);
});
