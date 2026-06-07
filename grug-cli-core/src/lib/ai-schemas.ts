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
    status: z.literal("discussion"),
    discussionText: z.string(),
    suggestedOptions: z.array(z.string()),
  }),
  z.object({
    status: z.literal("resolved"),
    target_files: z.array(z.string()),
    plan: z.array(PlanTaskSchema),
  }),
]);

export type PlanningResponse = z.infer<typeof PlanningResponseSchema>;