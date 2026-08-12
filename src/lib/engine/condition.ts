import type { Condition, SlotValues } from './types';

/**
 * Serializable `askIf` DSL (plan.MD §3). Kept as data rather than JS predicates
 * so category schemas can move into a DB table later without touching the engine.
 *
 * A slot that is UNKNOWN or SKIPPED counts as *not filled* — a conditional
 * follow-up is not asked on the back of an answer the student never gave.
 */
export function evaluateCondition(cond: Condition | undefined, slots: SlotValues): boolean {
  if (!cond) return true;

  if ('and' in cond) return cond.and.every((c) => evaluateCondition(c, slots));
  if ('or' in cond) return cond.or.some((c) => evaluateCondition(c, slots));
  if ('not' in cond) return !evaluateCondition(cond.not, slots);

  const entry = slots[cond.slot];
  const filled = entry !== undefined && entry.state === 'FILLED';
  const value = filled ? entry.value : undefined;

  switch (cond.op) {
    case 'filled':
      return filled;
    case 'unfilled':
      return !filled;
    case 'eq':
      return filled && looseEq(value, cond.value);
    case 'ne':
      return !filled || !looseEq(value, cond.value);
    case 'in':
      return filled && asArray(cond.value).some((v) => looseEq(value, v));
    case 'nin':
      return !filled || !asArray(cond.value).some((v) => looseEq(value, v));
    default:
      return true;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Multi-select slots hold arrays; `eq`/`in` against them means "contains". */
function looseEq(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((a) => a === expected);
  return actual === expected;
}
