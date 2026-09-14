from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


# Tighten the markerless Claude fallback around terminal review closure,
# not generic "finding-looking" prose. Quoted examples are blanked before
# progress/final signal detection so a finished review can discuss the very
# progress strings this classifier is guarding against.
path = Path('src/adapters/vendors.ts')
text = path.read_text()
pattern = re.compile(
    r"const CLAUDE_FINAL_REVIEW_SIGNAL =.*?\n\}\n\n/\*\* Claude Code: invoke the native `/code-review` skill through print mode\. \*/",
    re.S,
)
replacement = r'''const CLAUDE_FINAL_REVIEW_SIGNAL =
  /(?:\bnothing else\b[^\n]{0,180}\b(?:turned up|found)\b[^\n]{0,120}\b(?:bugs?|issues?|findings?|defects?|regressions?)\b|\bthe rest of (?:the )?(?:diff|changes|code)\b[^\n]{0,180}\b(?:look(?:ed|s)?|appear(?:ed|s)?|seem(?:ed|s)?)\b[^\n]{0,120}\b(?:correct|fine|good|sound)\b|\bno (?:other|additional|further|actionable|concrete) (?:bugs?|issues?|findings?|defects?|regressions)(?:\s+(?:were )?(?:identified|found))?\b|\b(?:i )?found no (?:actionable )?(?:bugs?|issues?|findings?|defects?|regressions)\b)/gi;

const CLAUDE_PROGRESS_SIGNAL =
  /(?:\b(?:waiting|awaiting)\b[^\n]{0,120}\b(?:agents?|subagents?|tasks?|results?|responses?)\b|\b(?:agents?|subagents?|tasks?)\b[^\n]{0,120}\b(?:still\s+(?:running|working|reviewing)|pending|not\s+(?:all\s+)?(?:done|finished|complete))\b|\bstill\s+(?:working|reviewing|waiting)\b|\b(?:i(?:'|’)ll|i will|we(?:'|’)ll|we will|they(?:'|’)ll|they will)\b[^\n]{0,100}\b(?:wait|be notified|report back|continue(?: reviewing)?|keep reviewing)\b|\breviewing the remaining\b|\bcontinuing (?:the )?review\b|\bso far\b)/gi;

function blankQuotedClaudeExamples(text: string): string {
  const blank = (value: string): string => ' '.repeat(value.length);

  return text
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\r\n]*`/g, blank)
    .replace(/"[^"\r\n]*"/g, blank)
    .replace(/“[^”\r\n]*”/g, blank);
}

function lastClaudeSignalIndex(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  let last = -1;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    last = match.index;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }

  pattern.lastIndex = 0;
  return last;
}

function looksLikeCompletedClaudeOutputWithoutMarker(output: string): boolean {
  const text = output.trim();
  if (text === '') return false;

  // Consolidation is structured. Markerless JSON — including fenced/wrapped
  // cluster payloads — remains fail-closed rather than borrowing a prose
  // review heuristic.
  try {
    JSON.parse(text);
    return false;
  } catch {
    // Prose review; continue below.
  }

  if (/```(?:json)?\s*[\[{]/i.test(text) || /["']clusters["']\s*:/.test(text)) {
    return false;
  }

  const signals = blankQuotedClaudeExamples(text);
  const finalIndex = lastClaudeSignalIndex(CLAUDE_FINAL_REVIEW_SIGNAL, signals);
  if (finalIndex < 0) return false;

  // A markerless acceptance needs a terminal-looking closure, not an early
  // "found two issues" or severity heading. Keep the closure near the end.
  if (finalIndex < Math.max(0, signals.length - 1600)) return false;

  const progressIndex = lastClaudeSignalIndex(CLAUDE_PROGRESS_SIGNAL, signals);

  // If Claude explicitly says work is still underway after its last closure,
  // the response is incomplete. Quoted examples do not count as live status.
  return progressIndex < finalIndex;
}

/** Claude Code: invoke the native `/code-review` skill through print mode. */'''
text, count = pattern.subn(lambda _: replacement, text, count=1)
if count != 1:
    raise SystemExit(f'Claude heuristic block: expected one match, got {count}')
path.write_text(text)


# Add regressions from the latest four-model review, including the important
# case where a completed review quotes progress phrases while explaining the
# classifier bug itself.
path = Path('test/claude-completion.test.ts')
text = path.read_text()
anchor = "test('Claude accepts a terse completed review when the completion marker is present', () => {\n"
addition = r'''test('Claude rejects the latest ordinary subagent progress wordings', () => {
  for (const stdout of [
    'So far I found 2 issues. The 3 review agents are still running; I’ll be notified when they finish.',
    'No issues in the first file. Waiting for the subagents to finish.',
    'I found one issue so far. Waiting for the subagents to finish.',
    'I found two problems so far; the agents are still running.',
  ]) {
    assert.deepEqual(
      claudeAdapter.checkCompletion(result(stdout)),
      { ok: false, reason: 'incomplete_review' },
    );
  }
});

test('Claude accepts a finished review that quotes progress phrases as examples', () => {
  const stdout =
    'I found one real bug in the completion fallback.\n\n' +
    '- It misses "agents are still running" and "Waiting for the subagents to finish."\n' +
    '- Those quoted examples should not themselves make this final review look live.\n\n' +
    'Nothing else in the diff turned up a concrete bug.';

  assert.deepEqual(claudeAdapter.checkCompletion(result(stdout)), { ok: true });
});

test('Claude rejects wrapped merge-style JSON without the marker', () => {
  const stdout = '## Overall\n```json\n{"clusters":[]}\n```';
  assert.deepEqual(
    claudeAdapter.checkCompletion(result(stdout)),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude does not treat a severity line or finding count alone as completion', () => {
  for (const stdout of [
    '[P1] src/a.ts:10 — possible bug',
    'I found two issues in the first pass.',
    '## Overall\nStill checking the remaining files.',
  ]) {
    assert.deepEqual(
      claudeAdapter.checkCompletion(result(stdout)),
      { ok: false, reason: 'incomplete_review' },
    );
  }
});

'''
text = replace_once(text, anchor, addition + anchor, 'add completion regressions')
path.write_text(text)
