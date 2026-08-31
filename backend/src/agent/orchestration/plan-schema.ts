import { z } from 'zod';

/**
 * The schema a model must satisfy to produce a plan (ADR-020).
 *
 * This is the contract between the model and the platform, and it is deliberately
 * strict. A plan is what a human approves and what the implementation step then
 * applies, so a malformed one must fail at generation rather than halfway through
 * being carried out.
 *
 * Bounds are on every field. They are not defensive clutter: a model asked for a
 * plan can return forty steps or a ten-thousand-character summary, and a plan that
 * cannot be read is a plan that gets approved without being read.
 */

export const planStepSchema = z.object({
  order: z.number().int().min(1).max(20),
  title: z.string().min(3).max(200).describe('A short imperative title for the step.'),
  detail: z
    .string()
    .min(10)
    .max(1000)
    .describe('What to do, naming the specific file and symbol involved.'),
});

export const plannedFileChangeSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe(
      'Path relative to the repository root. Must be a file you have read, or a new file in a module that exists.',
    ),
  change: z.enum(['added', 'modified', 'deleted']),
  reason: z.string().min(5).max(500).describe('Why this file changes.'),
});

export const implementationPlanSchema = z.object({
  summary: z
    .string()
    .min(20)
    .max(1000)
    .describe(
      'What the change does and where, in two or three sentences. Name the Odoo model and the module.',
    ),
  odooVersion: z
    .string()
    .max(20)
    .nullable()
    .describe('The Odoo series the repository targets, or null if it could not be determined.'),
  steps: z.array(planStepSchema).min(1).max(12),
  filesToModify: z.array(plannedFileChangeSchema).min(1).max(20),
  validation: z
    .array(z.string().max(100))
    .min(1)
    .max(10)
    .describe('The validation tools to run, by name.'),
  risks: z
    .array(z.string().min(5).max(500))
    .max(12)
    .describe(
      'What could go wrong, or what the reviewer should check. Be specific to this repository rather than generic.',
    ),
});

export type ModelImplementationPlan = z.infer<typeof implementationPlanSchema>;
