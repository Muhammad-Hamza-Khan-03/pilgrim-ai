import { parse } from 'yaml';
import { z } from 'zod';

const scalarType = z.enum(['text', 'int', 'number', 'money', 'date', 'boolean', 'enum', 'map']);

const attributeSchema = z.union([
  scalarType,
  z.object({
    type: scalarType,
    role: z.string().optional(),
    per: z.string().optional(),
    better: z.enum(['higher', 'lower']).optional(),
    values_from: z.string().optional(),
  }).passthrough(),
]);

const catalogEntitySchema = z.object({
  attributes: z.record(z.string(), attributeSchema),
  children: z.string().optional(),
}).passthrough();

const slotSchema = z.object({
  type: scalarType,
  required: z.boolean().optional(),
  describe: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  future: z.boolean().optional(),
  keys_from: z.string().optional(),
}).passthrough();

const ruleSchema = z.object({
  check: z.string().optional(),
  derive: z.string().optional(),
}).refine((rule) => rule.check !== undefined || rule.derive !== undefined, {
  message: 'a rule must define check or derive',
});

const objectiveSchema = z.object({
  direction: z.enum(['min', 'max']),
  weight: z.number().nonnegative(),
}).passthrough();

export const packSchema = z.object({
  pack: z.string().min(1),
  version: z.number().int().positive(),
  locale: z.object({
    default: z.string().min(1),
    supported: z.array(z.string().min(1)).min(1),
  }).passthrough(),
  persona: z.object({
    tone: z.string().min(1),
    currency: z.string().min(1),
  }).passthrough(),
  catalog: z.record(z.string(), catalogEntitySchema).refine((catalog) => Object.keys(catalog).length > 0, {
    message: 'catalog must contain at least one entity',
  }),
  slots: z.record(z.string(), slotSchema).refine((slots) => Object.keys(slots).length > 0, {
    message: 'slots must contain at least one slot',
  }),
  rules: z.array(ruleSchema),
  bundle: z.record(z.string(), z.unknown()).refine((bundle) => Object.keys(bundle).length > 0, {
    message: 'bundle must not be empty',
  }),
  objectives: z.record(z.string(), objectiveSchema).refine((objectives) => Object.keys(objectives).length > 0, {
    message: 'objectives must contain at least one objective',
  }),
  results: z.object({
    count: z.number().int().positive(),
    diversity: z.number().min(0).max(1),
  }).passthrough(),
  llm: z.record(z.string(), z.unknown()).optional(),
  handoff: z.record(z.string(), z.unknown()).optional(),
  knowledge: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type Pack = z.infer<typeof packSchema>;

export class PackCompileError extends Error {
  declare readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'PackCompileError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function compilePack(source: string): Pack {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new PackCompileError(`YAML parsing failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const result = packSchema.safeParse(parsed);
  if (!result.success) {
    throw new PackCompileError(`Pack validation failed: ${result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`, { cause: result.error });
  }

  return result.data;
}
