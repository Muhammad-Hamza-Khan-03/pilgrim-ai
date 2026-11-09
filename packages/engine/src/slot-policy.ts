import { evaluateExpression, ExpressionEvaluationError } from './expression-evaluator.js';

export type SlotValue = unknown;
export type SlotDefinition = {
  type: 'text' | 'int' | 'number' | 'money' | 'date' | 'boolean' | 'enum' | 'map';
  required?: boolean;
  min?: number;
  max?: number;
  future?: boolean;
  values?: readonly string[];
  keys_from?: string;
};
export type SlotPack = {
  slots: Record<string, SlotDefinition>;
  rules: readonly { check?: string; derive?: string }[];
};
export type SlotState = Record<string, SlotValue>;
export type SlotPolicyOptions = {
  mapKeys?: Record<string, readonly string[]>;
  maxDerivations?: number;
};
export type NextAction = { type: 'ask'; slots: string[] } | { type: 'search' };
export type SlotPolicyResult = {
  slots: SlotState;
  valid: boolean;
  missing: string[];
  derived: string[];
};

const DEFAULT_MAX_DERIVATIONS = 32;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class SlotPolicyError extends Error {
  readonly code: string;

  constructor(message: string, code = 'SLOT_POLICY_INVALID') {
    super(message);
    this.name = 'SlotPolicyError';
    this.code = code;
  }
}

function fail(message: string, code?: string): never {
  throw new SlotPolicyError(message, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateValue(name: string, definition: SlotDefinition, value: unknown): void {
  if (value === undefined) return;
  const numeric = definition.type === 'int' || definition.type === 'number' || definition.type === 'money';
  if (definition.type === 'text' && typeof value !== 'string') fail(`Slot '${name}' must be text`, 'SLOT_TYPE');
  if (definition.type === 'boolean' && typeof value !== 'boolean') fail(`Slot '${name}' must be boolean`, 'SLOT_TYPE');
  if (numeric && (typeof value !== 'number' || !Number.isFinite(value))) fail(`Slot '${name}' must be a finite number`, 'SLOT_TYPE');
  if (definition.type === 'int' && typeof value === 'number' && !Number.isInteger(value)) fail(`Slot '${name}' must be an integer`, 'SLOT_TYPE');
  if (definition.type === 'date' && !validDate(value)) fail(`Slot '${name}' must be a valid ISO date`, 'SLOT_TYPE');
  if (definition.type === 'enum' && (typeof value !== 'string' || (definition.values && !definition.values.includes(value)))) fail(`Slot '${name}' is not an allowed value`, 'SLOT_VALUE');
  if (definition.type === 'map' && !isRecord(value)) fail(`Slot '${name}' must be a map`, 'SLOT_TYPE');
  if (numeric && typeof value === 'number') {
    if (definition.min !== undefined && value < definition.min) fail(`Slot '${name}' is below its minimum`, 'SLOT_RANGE');
    if (definition.max !== undefined && value > definition.max) fail(`Slot '${name}' is above its maximum`, 'SLOT_RANGE');
  }
  if (definition.future && typeof value === 'string' && value <= new Date().toISOString().slice(0, 10)) fail(`Slot '${name}' must be in the future`, 'SLOT_RANGE');
}

function validateSlots(pack: SlotPack, slots: SlotState): void {
  for (const name of Object.keys(slots)) {
    if (!(name in pack.slots)) fail(`Unknown slot '${name}'`, 'UNKNOWN_SLOT');
    validateValue(name, pack.slots[name], slots[name]);
  }
  for (const [name, definition] of Object.entries(pack.slots)) {
    if (definition.required && slots[name] !== undefined) validateValue(name, definition, slots[name]);
  }
}

export function parseDeriveRule(source: string): { target: string; expression: string } {
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\[missing\]\s*=\s*(.+)$/.exec(source.trim());
  if (!match || !match[2].trim() || /[;{}]/.test(match[2])) fail(`Invalid derive rule syntax: '${source}'`, 'DERIVE_SYNTAX');
  if (/(?:^|[^A-Za-z0-9_$])(?!sum\b|min\b|max\b)[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(match[2])) fail(`Invalid derive expression: '${match[2]}'`, 'DERIVE_SYNTAX');
  return { target: match[1], expression: match[2].trim() };
}

export function getMissingSlots(pack: SlotPack, slots: SlotState): string[] {
  return Object.entries(pack.slots).filter(([name, definition]) => definition.required && slots[name] === undefined).map(([name]) => name);
}

function evaluatorContext(slots: SlotState): Record<string, unknown> {
  return Object.fromEntries(Object.entries(slots).map(([name, value]) => [name, isRecord(value) ? Object.values(value) : value]));
}

function ruleReferencesAvailable(expression: string, slots: SlotState): boolean {
  try {
    evaluateExpression(expression, evaluatorContext(slots));
    return true;
  } catch (error) {
    if (error instanceof ExpressionEvaluationError && error.code === 'MISSING_REFERENCE') return false;
    throw error;
  }
}

function applyDerivations(pack: SlotPack, slots: SlotState, options: SlotPolicyOptions, derived: string[]): void {
  const max = options.maxDerivations ?? DEFAULT_MAX_DERIVATIONS;
  if (!Number.isInteger(max) || max < 0) fail('maxDerivations must be a non-negative integer', 'DERIVATION_LIMIT');
  let attempts = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of pack.rules) {
      if (!rule.derive) continue;
      if (++attempts > max) fail('Derivation limit exceeded', 'DERIVATION_LIMIT');
      const { target, expression } = parseDeriveRule(rule.derive);
      const current = slots[target];
      if (!isRecord(current)) continue;
      const keys = options.mapKeys?.[target] ?? Object.keys(current).filter((key) => current[key] !== undefined);
      const missing = keys.filter((key) => current[key] === undefined);
      if (missing.length !== 1 || !ruleReferencesAvailable(expression, slots)) continue;
      const value = evaluateExpression(expression, evaluatorContext(slots));
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`Derived '${target}[${missing[0]}]' must be a finite number`, 'DERIVATION_TYPE');
      current[missing[0]] = value;
      derived.push(`${target}[${missing[0]}]`);
      changed = true;
    }
  }
}

function checkRules(pack: SlotPack, slots: SlotState): void {
  for (const rule of pack.rules) {
    if (!rule.check || !ruleReferencesAvailable(rule.check, slots)) continue;
    if (evaluateExpression(rule.check, evaluatorContext(slots)) !== true) fail(`Slot check failed: ${rule.check}`, 'CHECK_FAILED');
  }
}

export function applySlotUpdates(pack: SlotPack, current: SlotState, updates: SlotState, options: SlotPolicyOptions = {}): SlotPolicyResult {
  if (!isRecord(current) || !isRecord(updates)) fail('Slots and updates must be objects', 'SLOT_TYPE');
  const candidate = structuredClone(current);
  for (const [name, value] of Object.entries(updates)) candidate[name] = structuredClone(value);
  validateSlots(pack, candidate);
  const derived: string[] = [];
  applyDerivations(pack, candidate, options, derived);
  validateSlots(pack, candidate);
  checkRules(pack, candidate);
  return { slots: candidate, valid: true, missing: getMissingSlots(pack, candidate), derived };
}

export function nextAction(pack: SlotPack, slots: SlotState): NextAction {
  const missing = getMissingSlots(pack, slots);
  return missing.length > 0 ? { type: 'ask', slots: missing } : { type: 'search' };
}
