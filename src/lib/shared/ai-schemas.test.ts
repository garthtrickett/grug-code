import { describe, it, expect } from "vitest";
import { PlanningResponseSchema, FeatureImplementationPlanSchema } from "./ai-schemas.ts";

describe("PlanningResponseSchema Validation", () => {
  it("should successfully parse valid status 'exploring'", () => {
    const payload = {
      status: "exploring",
      reason: "Needs payment service schema context to proceed",
      request_skeletons_for: ["src/services/payment.ts"],
    };

    const parsed = PlanningResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("exploring");
      expect((parsed.data as any).request_skeletons_for).toEqual(["src/services/payment.ts"]);
    }
  });

  it("should successfully parse valid status 'resolved'", () => {
    const payload = {
      status: "resolved",
      target_files: ["src/services/payment.ts"],
      plan: [
        {
          id: "step-1",
          description: "Initialize client connection",
          targetFiles: ["src/services/payment.ts"],
          status: "pending",
          developerNotes: "Add timeout controls",
        },
      ],
    };

    const parsed = PlanningResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("resolved");
      expect((parsed.data as any).plan.length).toBe(1);
    }
  });

  it("should reject payloads with invalid status parameters", () => {
    const payload = {
      status: "invalid-status",
      reason: "Wrong status",
    };

    const parsed = PlanningResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });

  it("should reject resolved plans missing mandatory step attributes", () => {
    const payload = {
      status: "resolved",
      target_files: ["src/services/payment.ts"],
      plan: [
        {
          id: "step-1",
          // missing description
          targetFiles: ["src/services/payment.ts"],
          status: "pending",
        },
      ],
    };

    const parsed = PlanningResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });
});

describe("FeatureImplementationPlanSchema Validation", () => {
  it("should successfully parse a complete, valid blueprint", () => {
    const payload = {
      featureSummary: "Add payment gateway",
      gapAnalysis: [
        {
          aspect: "Service Layer",
          currentCodebaseStatus: "Missing driver for Stripe integration",
          requiredChanges: "Create StripePaymentService under src/services",
        },
      ],
      implementationSteps: [
        {
          stepNumber: 1,
          phaseTitle: "Service Setup",
          targetFiles: ["src/services/stripe.ts"],
          stepSummary: "Draft base integration adapter class",
          testingUpdates: "Run bun test src/services/stripe.test.ts",
        },
      ],
    };

    const parsed = FeatureImplementationPlanSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.featureSummary).toBe("Add payment gateway");
      expect(parsed.data.gapAnalysis[0]?.aspect).toBe("Service Layer");
    }
  });

  it("should reject blueprints containing missing step metrics", () => {
    const payload = {
      featureSummary: "Incomplete plan",
      gapAnalysis: [],
      implementationSteps: [
        {
          // missing stepNumber
          phaseTitle: "Service Setup",
          targetFiles: [],
          stepSummary: "Summary",
          testingUpdates: "None",
        },
      ],
    };

    const parsed = FeatureImplementationPlanSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });
});