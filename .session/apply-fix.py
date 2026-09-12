from pathlib import Path

def replace_once(path, old, new):
    file = Path(path)
    text = file.read_text()
    assert text.count(old) == 1, (path, old)
    file.write_text(text.replace(old, new))

for page, token in [('setup', 'setup-owner-token'), ('admin', 'owner-token')]:
    path = f'public/{page}.html'
    replace_once(path, f'id="{token}"\n              type="password"', f'id="{token}"\n              type="password"\n              disabled')
    label = '認証して設定を開く' if page == 'setup' else '認証して予定表を開く'
    replace_once(path, f'type="submit">{label}</button>', f'type="submit" disabled>{label}</button>')
    # This is functional guidance, not an error message that later login clears.
    replace_once(path, '<form id="' + ('setup-auth-form' if page == 'setup' else 'auth-form') + '"', '<noscript><p class="helper">認証にはJavaScriptが必要です。ブラウザで有効にして再読み込みしてください。</p></noscript>\n        <form id="' + ('setup-auth-form' if page == 'setup' else 'auth-form') + '"')

# An async starter resolves only after every listener was installed. A failed
# initialization keeps the controls disabled instead of accepting a dead click.
for next_function in ['startSetup', 'startLegal']:
    boundary = '\n};\n\nconst ' + next_function + ' = async () => {'
    replacement = '\n  tokenInput.disabled = false;\n  authForm.querySelector(\'button[type="submit"]\').disabled = false;\n};\n\nconst ' + next_function + ' = async () => {'
    replace_once('public/app.js', boundary, replacement)

replace_once('.github/workflows/ci.yml', 'path: .playwright\n          retention-days: 3', 'path: .playwright\n          include-hidden-files: true\n          retention-days: 3')
replace_once('scripts/release-audit.mjs', '  "path: .playwright",\n  "retention-days: 3",', '  "path: .playwright",\n  "include-hidden-files: true",\n  "retention-days: 3",')
