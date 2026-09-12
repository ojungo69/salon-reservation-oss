from pathlib import Path

for path in Path('public').glob('*.html'):
    text = path.read_text()
    if '<link rel="stylesheet" href="/styles.css">' in text:
        path.write_text(text.replace('<link rel="stylesheet" href="/styles.css">', '<link rel="stylesheet" href="/styles.css">\n    <link rel="stylesheet" href="/studio.css">'))
path = Path('public/app.js')
text = path.read_text()
text = 'import { mountDateStrip, renderTimeline } from "./studio.mjs";\n' + text
old = '\n};\n\nconst startBookings ='
assert text.count(old) == 1
text = text.replace(old, '\n  mountDateStrip(dateInput);\n};\n\nconst startBookings =')
old = '    $("[data-day-board-summary]").textContent ='
assert text.count(old) == 1
text = text.replace(old, '''    if (!statusFilter.value) {
      const timeline = renderTimeline(board, config.resources, (reservation) => {
        renderDetail(reservation, true);
        detail.scrollIntoView({ block: "start" });
      });
      if (timeline) reservationList.prepend(timeline);
    }
''' + old)
old = 'const customer = createElement("p", "", `${reservation.customerName} / ${reservation.contact}`);'
assert text.count(old) == 1
text = text.replace(old, 'const customer = createElement("p", "", reservation.customerName);')
path.write_text(text)
path = Path('public/index.html')
text = path.read_text().replace('予定を選び、内容を確認して送信する', '次のご来店を、ここから。').replace('予約は確認後に受付状態になります。予約番号と管理キーは、このブラウザで予約を確認・取消するために使います。', 'サービスと日時を選んで、予約を申請できます。サロンの承認後に予約が確定します。')
path.write_text(text)
path = Path('public/admin.html')
text = path.read_text().replace('今日の対応を、ひとつの予定表で進める', '予約管理').replace('<a href="/">お客様用画面</a>', '<a href="/admin.html" aria-current="page">予約</a>\n        <a href="/">お客様用画面</a>').replace('<h2 id="reservation-detail-title"', '<a class="text-button" href="#day-board">予定表へ戻る</a>\n          <h2 id="reservation-detail-title"')
path.write_text(text)
path = Path('package.json')
text = path.read_text()
assert text.count('test/staff-roster.test.ts"') == 1
path.write_text(text.replace('test/staff-roster.test.ts"', 'test/staff-roster.test.ts test/studio.test.ts"'))
path = Path('release/public-files.txt')
paths = set(path.read_text().splitlines())
paths.update(['public/studio.css', 'public/studio.mjs', 'test/studio.test.ts', 'tests-browser/studio.spec.ts', 'docs/DESIGN-STUDIO.md'])
path.write_text('\n'.join(sorted(paths)) + '\n')
