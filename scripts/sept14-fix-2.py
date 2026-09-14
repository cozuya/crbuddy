from pathlib import Path

path = Path('test/saved-review-instructions.test.ts')
text = path.read_text()
old = "class TestUI implements WizardUI {\n  readonly interactive = false;"
new = "class TestUI implements WizardUI {\n  readonly interactive: boolean = false;"
count = text.count(old)
if count != 1:
    raise SystemExit(f'expected one TestUI interactive declaration, got {count}')
path.write_text(text.replace(old, new, 1))
