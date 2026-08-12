// Core abstraction (plan.MD §3): a category declares the information that *may*
// be useful; the engine decides what to actually ask.

export type Condition =
  | { slot: string; op: 'eq' | 'ne' | 'in' | 'nin' | 'filled' | 'unfilled'; value?: unknown }
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition };

export type SlotType =
  | 'enum'
  | 'multi'
  | 'text'
  | 'number'
  | 'boolean'
  | 'location'
  | 'date'
  | 'media';

export type Importance = 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';

/**
 * One cross-category vocabulary for physical danger. Each category words its
 * own options ("Smoke", "Ceiling is leaking onto a switchboard"), and maps the
 * dangerous ones onto these, so the priority rubric scores hazard without
 * knowing a single category's slot keys or option values (Layer 4).
 */
export type Hazard =
  | 'FIRE'
  | 'SMOKE'
  | 'BURNING_SMELL'
  | 'SPARKING'
  | 'ELECTRIC_SHOCK'
  | 'EXPOSED_WIRE'
  | 'GAS_LEAK'
  | 'CHEMICAL'
  | 'MAJOR_LEAK'
  | 'FLOODING'
  | 'SEWAGE'
  | 'STRUCTURAL'
  | 'SECURITY_THREAT'
  | 'HARASSMENT'
  | 'FOOD_ILLNESS'
  | 'INJURY';

/**
 * Marks a slot whose answer the classifier reads in a category-independent way
 * (plan.MD §4 — scope, impact and duration are rubric terms shared by every
 * category). Without this, `classify.ts` would have to match on slot key names.
 */
export type SlotSignal = 'SCOPE' | 'IMPACT' | 'DURATION' | 'RECURRING' | 'PERSON_AT_RISK';

export interface SlotOption {
  value: string;
  label: string;
  /** Phrases that map free text onto this option in the rules extractor. */
  hints?: string[];
  /** Set on options that describe physical danger. Drives the priority rubric. */
  hazard?: Hazard;
}

export interface Slot {
  key: string;
  question: string;
  type: SlotType;
  options?: SlotOption[];
  importance: Importance;
  /** §7 conditional relevance — only ask when this passes. */
  askIf?: Condition;
  /** §10 — "I'm not sure" is always recorded rather than blocking, unless disabled. */
  allowUnsure?: boolean;
  /** §10 — defaults to true unless the slot is REQUIRED. */
  allowSkip?: boolean;
  /** 0..1 base ordering weight. */
  infoGain: number;
  /** Jumps the queue unconditionally, and can short-circuit the conversation. */
  safetyCritical?: boolean;
  /**
   * Values that mean live danger. When a safetyCritical slot lands on one of
   * these, questioning stops immediately and the complaint submits as CRITICAL
   * (plan.MD §3 short-circuit).
   */
  criticalValues?: unknown[];
  /** Answers here can move the priority band → +15 in next-question scoring. */
  priorityDiscriminating?: boolean;
  /**
   * Declares that this slot carries one of the rubric's shared signals, so the
   * classifier can read it without knowing the category (Layer 4).
   */
  signal?: SlotSignal;
  /** Keywords for the rules-based extractor (Layer 2). */
  extractHints?: string[];
  /** Coarse fallback used when a REQUIRED slot is answered "I'm not sure" (§10). */
  unsureDefault?: unknown;
  placeholder?: string;
  helpText?: string;
}

export interface CategorySchema {
  key: string;
  label: string;
  /** Shown in the category picker. */
  description: string;
  /** Matched by the rules-based classifier / picker search. */
  keywords: string[];
  subcategorySlot?: string;
  slots: Slot[];
  /** Dedup window in hours (plan.MD §5). */
  dedupWindowHours: number;
}

export type SlotState = 'FILLED' | 'UNKNOWN' | 'SKIPPED';
export type SlotSource = 'EXTRACTED' | 'ANSWERED' | 'DEFAULTED';

export interface SlotValue {
  value: unknown;
  state: SlotState;
  source: SlotSource;
  confidence: number;
}

export type SlotValues = Record<string, SlotValue>;

export type TurnRole = 'SYSTEM' | 'ASSISTANT' | 'USER';

export interface Turn {
  role: TurnRole;
  text: string;
  /** Set on assistant turns that asked about a specific slot. */
  slotKey?: string;
  at: string;
}

export interface DraftState {
  rawText: string;
  categoryKey: string | null;
  slots: SlotValues;
  askedSlots: string[];
  turns: Turn[];
}
