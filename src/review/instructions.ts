import type { Operation } from '../adapters/types.js';
import type { PanelEntry } from '../config/schema.js';
import type { ResolvedTarget } from '../git/target.js';

/**
 * Persisted preset ids include a semantic version so a saved config keeps the
 * prompt it selected even after crbuddy ships a revised preset later.
 */
export const PRIORITIZED_FINDINGS_PRESET_ID = 'prioritized-findings-v1' as const;
export type ReviewPresetId = typeof PRIORITIZED_FINDINGS_PRESET_ID;

/** Internal maintained prompts also carry ids for run provenance. */
export const GENERIC_DEFAULT_REVIEW_PRESET_ID = 'generic-default-v1' as const;
export const WHOLE_CHECKOUT_DEFAULT_PRESET_ID = 'whole-checkout-default-v1' as const;

export type InstructionSource = 'default' | 'preset' | 'custom' | 'override';

type ReviewSubject = 'diff' | 'whole-checkout';

export interface ReviewInstructionSelection {
  operation: Operation;
  source: InstructionSource;
  /** Maintained prompt id actually used, when there is one. */
  presetId: string | null;
}

function prioritizedFindingsV1(subject: ReviewSubject): string {
  const opening =
    subject === 'diff'
      ? 'Review the changes in the supplied branch or commit range against its base branch. Read the current code around each change; do not rely only on the diff, commit messages, comments, or tests.'
      : 'Review this repository as it currently stands. There is no diff to review, so treat the checked-out code itself as the subject. Read the current code around each area you inspect; do not rely only on comments or tests.';

  const findingScope =
    subject === 'diff'
      ? 'Report actionable defects introduced by the changes.'
      : 'Report actionable defects present in the checked-out code.';

  const focusRule =
    subject === 'diff'
      ? 'Focus on defects caused by the reviewed changes or made reachable by them.'
      : 'Focus on reachable defects in the reviewed checkout.';

  return `${opening}

${findingScope} Prioritize every finding with exactly one severity:

- P0: catastrophic security failure, destructive data loss, credential exposure, or corruption with broad/immediate impact.
- P1: must fix before merge or release; the primary workflow is broken, a security or correctness boundary is bypassed, recovery is impossible, or persisted/public results can be materially false.
- P2: a real correctness, reliability, compatibility, or significant performance defect on a reachable path.
- P3: lower-risk defect with concrete behavioral impact. Omit style, naming, duplication, speculative future hazards, and general cleanup unless they cause a current failure.

Output requirements:

1. Begin with a short overall verdict.
2. List findings in strict P0, P1, P2, then P3 order.
3. Format each finding as:

   [P1] Imperative, actionable title — path/to/file:line

   Explain the exact triggering condition, trace the resulting behavior, and state the concrete impact. Include a minimal reproduction or regression-test shape when practical.

4. ${focusRule}
5. Deduplicate findings with the same root cause.
6. Verify that each premise can actually occur in production. Do not present speculation as a finding.
7. Treat passing tests as evidence, not proof: check that a test exercises the real dependency and failure mode it claims to cover.
8. Do not inflate severity merely because code is security-adjacent.
9. If there are no actionable findings, say so plainly.
10. End with a concise coverage note naming the areas inspected and commands or tests actually run.

Return Markdown, not JSON. Keep the main report focused on actionable P0-P2 findings.`;
}

const GENERIC_DEFAULT_REVIEW_V1 =
  'Review the supplied changes for concrete, actionable defects. Read the current code ' +
  'around each change, not only the diff. Focus on correctness, reliability, security, ' +
  'compatibility, error handling, resource cleanup, and significant performance regressions. ' +
  'Report only reachable problems introduced by the changes, with file paths and line numbers. ' +
  'Deduplicate findings with the same root cause and say plainly if there are no actionable findings.';

const WHOLE_CHECKOUT_SUBJECT =
  'Review this repository as it currently stands. There is no diff to review, ' +
  'so treat the checked-out code itself as the subject.';

const WHOLE_CHECKOUT_DEFAULT_V1 =
  `${WHOLE_CHECKOUT_SUBJECT} Report concrete, actionable defects with file ` +
  `paths and line numbers, covering correctness bugs, error handling, ` +
  `resource cleanup, and security. Do not modify any files.`;

export function isReviewPresetId(value: unknown): value is ReviewPresetId {
  return value === PRIORITIZED_FINDINGS_PRESET_ID;
}

export function reviewPresetInstructions(
  id: ReviewPresetId,
  subject: ReviewSubject = 'diff',
): string {
  switch (id) {
    case PRIORITIZED_FINDINGS_PRESET_ID:
      return prioritizedFindingsV1(subject);
  }
}

export function wholeCheckoutPrompt(instructions: string | undefined): string {
  if (!instructions) return WHOLE_CHECKOUT_DEFAULT_V1;

  return (
    `${WHOLE_CHECKOUT_SUBJECT}\n\n` +
    `${instructions}\n\n` +
    `Report concrete, actionable findings with file paths and line numbers. ` +
    `Do not modify any files.`
  );
}

/**
 * Resolve one configured reviewer into the semantic operation sent to its
 * adapter plus provenance describing where its instructions came from.
 *
 * The one-off positional override remains strongest. A persisted preset is
 * expanded here rather than copied into config. Native-review vendors keep
 * their native default when nothing is selected; vendors without one (today,
 * Gemini) receive crbuddy's maintained generic default.
 */
export function buildReviewerOperation(options: {
  entry: Pick<PanelEntry, 'instructions' | 'instructionsPreset'>;
  target: ResolvedTarget;
  nativeReview: boolean;
  wholeCheckout: boolean;
  instructionsOverride?: string;
}): ReviewInstructionSelection {
  const { entry, target, nativeReview, wholeCheckout, instructionsOverride } = options;

  let instructions: string | undefined;
  let source: InstructionSource = 'default';
  let presetId: string | null = null;

  if (instructionsOverride) {
    instructions = instructionsOverride;
    source = 'override';
  } else if (entry.instructionsPreset) {
    instructions = reviewPresetInstructions(
      entry.instructionsPreset,
      wholeCheckout ? 'whole-checkout' : 'diff',
    );
    source = 'preset';
    presetId = entry.instructionsPreset;
  } else if (entry.instructions) {
    instructions = entry.instructions;
    source = 'custom';
  }

  if (wholeCheckout) {
    const wholeInstructions =
      source === 'preset' && instructions
        ? `${instructions}\n\nDo not modify any files.`
        : wholeCheckoutPrompt(instructions);

    return {
      operation: {
        kind: 'generic',
        target: null,
        instructions: wholeInstructions,
      },
      source,
      presetId:
        source === 'default' ? WHOLE_CHECKOUT_DEFAULT_PRESET_ID : presetId,
    };
  }

  if (instructions) {
    return {
      operation: { kind: 'generic', target, instructions },
      source,
      presetId,
    };
  }

  if (nativeReview) {
    return {
      operation: { kind: 'review', target },
      source: 'default',
      presetId: null,
    };
  }

  return {
    operation: {
      kind: 'generic',
      target,
      instructions: GENERIC_DEFAULT_REVIEW_V1,
    },
    source: 'default',
    presetId: GENERIC_DEFAULT_REVIEW_PRESET_ID,
  };
}
