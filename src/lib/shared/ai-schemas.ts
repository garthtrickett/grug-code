import { z } from "zod";

export const PlanTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  targetFiles: z.array(z.string()),
  status: z.enum(["pending", "running", "completed", "failed"]),
  developerNotes: z.string().optional(),
});

export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const PlanningResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("exploring"),
    reason: z.string(),
    request_skeletons_for: z.array(z.string()),
  }),
  z.object({
    status: z.literal("resolved"),
    target_files: z.array(z.string()),
    plan: z.array(PlanTaskSchema),
  }),
]);

export type PlanningResponse = z.infer<typeof PlanningResponseSchema>;

export const GapAnalysisItemSchema = z.object({
  aspect: z.string(),
  currentCodebaseStatus: z.string(),
  requiredChanges: z.string(),
});

export type GapAnalysisItem = z.infer<typeof GapAnalysisItemSchema>;

export const PhasedStepSchema = z.object({
  stepNumber: z.number(),
  phaseTitle: z.string(),
  targetFiles: z.array(z.string()),
  stepSummary: z.string(),
  testingUpdates: z.string(),
});

export type PhasedStep = z.infer<typeof PhasedStepSchema>;

export const FeatureImplementationPlanSchema = z.object({
  featureSummary: z.string(),
  gapAnalysis: z.array(GapAnalysisItemSchema),
  implementationSteps: z.array(PhasedStepSchema),
});

export type FeatureImplementationPlan = z.infer<typeof FeatureImplementationPlanSchema>;

export const ResearchRequestSchema = z.object({
  mode: z.enum(["standard", "discussion"]).default("standard"),
});

export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;
