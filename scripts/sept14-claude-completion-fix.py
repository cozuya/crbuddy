from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


# Tighten Claude markerless completion fallback.
path = Path('src/adapters/vendors.ts')
text = path.read_text()
old = """const CLAUDE_FINAL_REVIEW_SIGNAL =
  /(?:^\\s*(?:[-*]\\s*)?\\[P[0-3]\\]|\\bno (?:actionable )?(?:findings|defects|regressions|issues)\\b|\\bfound (?:no|\\d+|one|two|three|four|five|six|seven|eight|nine|ten) (?:problems?|issues?|findings?|defects?|regressions?)\\b|^##\\s+(?:assessment|code review results|overall)\\b)/im;

const CLAUDE_PROGRESS_SIGNAL =
  /(?:waiting for (?:the )?(?:background )?(?:agents?|tasks?)|(?:background|delegated) (?:agents?|tasks?) (?:are )?still running|(?:agents?|tasks?) still running|(?:i(?:'|’)ll|i will) wait)/i;

function looksLikeCompletedClaudeOutputWithoutMarker(output: string): boolean {
  const text = output.trim();
  if (text === '') return false;

  try {
    JSON.parse(text);
    return true;
  } catch {
    // Most reviews are prose. JSON is only a strong completion signal
    // for exact-format tasks such as consolidation.
  }

  const hasFinalSignal = CLAUDE_FINAL_REVIEW_SIGNAL.test(text);
  const tail = text.slice(-1000);

  if (CLAUDE_PROGRESS_SIGNAL.test(tail) && !hasFinalSignal) return false;
  if (hasFinalSignal) return true;

  // The marker remains the preferred contract, but Claude has now omitted it
  // after multiple clearly finished long reviews. Accept a substantial
  // zero-exit payload while still rejecting short ambiguous status/progress
  // replies like the original background-agent failure.
  return text.length >= 500;
}
"""
new = """const CLAUDE_FINAL_REVIEW_SIGNAL =
  /(?:^\\s*(?:[-*]\\s*)?\\[P[0-3]\\]|\\bno (?:actionable )?(?:findings|defects|regressions|issues)\\b|\\bfound (?:no|\\d+|one|two|three|four|five|six|seven|eight|nine|ten) (?:problems?|issues?|findings?|defects?|regressions?)\\b|^##\\s+(?:assessment|code review results|overall)\\b|\\bthe rest of (?:the )?(?:diff|changes) looked correct\\b)/im;

const CLAUDE_PROGRESS_SIGNAL =
  /(?:waiting (?:for|on) (?:the )?(?:background )?(?:agents?|tasks?)|(?:background|delegated) (?:agents?|tasks?) (?:are )?still running|(?:agents?|tasks?) still running|(?:i(?:'|’)ll|i will) wait|(?:agents?|tasks?) (?:will|should) (?:report|return)|report back when|reviewing the remaining|continuing (?:the )?review)/i;

function looksLikeCompletedClaudeOutputWithoutMarker(output: string): boolean {
  const text = output.trim();
  if (text === '') return false;

  // Structured payloads are used by consolidation as well as review lanes.
  // checkCompletion has no operation context, so markerless JSON must remain
  // fail-closed rather than letting a valid-looking merge payload bypass the
  // completion protocol.
  try {
    JSON.parse(text);
    return false;
  } catch {
    // Prose review; continue with conservative review-shape checks below.
  }

  // Explicit evidence that Claude is still working always wins over a phrase
  // that happens to look final earlier in the same response. This preserves
  // the original protection against background-agent progress replies.
  const tail = text.slice(-1500);
  if (CLAUDE_PROGRESS_SIGNAL.test(tail)) return false;

  // The marker remains the preferred contract. This fallback exists only for
  // the observed case where Claude exits 0 after a clearly final prose review
  // but omits the requested marker. Do not use output length as completion
  // evidence: a long progress report is still just a progress report.
  return CLAUDE_FINAL_REVIEW_SIGNAL.test(text);
}
"""
text = replace_once(text, old, new, 'tighten Claude completion fallback')
path.write_text(text)

# Update regression coverage.
path = Path('test/claude-completion.test.ts')
text = path.read_text()
old = """test('Claude accepts an exact JSON payload without the marker', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('{\"clusters\":[]}')),
    { ok: true },
  );
});

"""
new = """test('Claude rejects markerless JSON because completion is shared with merge tasks', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('{\"clusters\":[]}')),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude rejects final-looking prose when the tail says work is still running', () => {
  for (const stdout of [
    'I found two issues so far; the delegated agents are still running, I will wait for them.',
    'No actionable issues so far. Waiting for the background agents to finish.',
  ]) {
    assert.deepEqual(
      claudeAdapter.checkCompletion(result(stdout)),
      { ok: false, reason: 'incomplete_review' },
    );
  }
});

test('Claude rejects long markerless progress text even when it is substantial', () => {
  const stdout = (
    'I have dispatched four review agents and am continuing the review. ' +
    'They will report back when done. '
  ).repeat(8);

  assert.ok(stdout.length > 500);
  assert.deepEqual(
    claudeAdapter.checkCompletion(result(stdout)),
    { ok: false, reason: 'incomplete_review' },
  );
});

"""
text = replace_once(text, old, new, 'replace markerless JSON test')
path.write_text(text)
