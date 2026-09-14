from pathlib import Path

path = Path('scripts/sept14-claude-stop-hook.py')
text = path.read_text()
old = "text = replace_once(text, old, new, 'install Claude Stop hook')"
new = "\nif text.count(old) < 1:\n    raise SystemExit('install Claude Stop hook: no match')\ntext = text.replace(old, new, 1)"
if old not in text:
    raise SystemExit('repair target missing')
path.write_text(text.replace(old, new, 1))
