from pathlib import Path
import sys

def replace(path, old, new):
    p = Path(path); text = p.read_text()
    assert text.count(old) == 1, (path, old)
    p.write_text(text.replace(old, new))

if sys.argv[1] == 'tests':
    replace('test/worker.test.ts', '              reservationId,\n              rescheduleHistory: [', '              reservationId,\n              resourceId: "resource-chair-b",\n              rescheduleHistory: [')
    sys.exit(0)

replace('src/worker.ts', '    ...projected,\n    ...(reservation.resourceLabel', '    ...projected,\n    resourceId: reservation.resourceId,\n    ...(reservation.resourceLabel')
replace('tests-browser/studio.spec.ts', '  await expect(other).toBeFocused();\n  await expect(other).toHaveAttribute("aria-pressed", "true");', '  const selected = page.locator(`.date-strip-day[data-date="${next}"]`);\n  await expect(selected).toBeFocused();\n  await expect(selected).toHaveAttribute("aria-pressed", "true");')
replace('tests-browser/studio.spec.ts', '  await expect(page.locator(".schedule-timeline")).toBeVisible();', '''  await expect(page.locator(".schedule-timeline")).toBeVisible();
  const resources = await page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    return (await response.json()).resources as { id: string; label: string }[];
  });
  await expect(page.locator(".timeline-lane")).toHaveCount(resources.length);
  const chosenResource = await page.locator("#owner-resource")).inputValue();
  await expect(page.locator(`.timeline-lane[data-resource-id="${chosenResource}"] [data-timeline-reservation]`)).toHaveCount(1);'''.replace('locator("#owner-resource"))', 'locator("#owner-resource")'))
replace('public/studio.mjs', '  for (const reservation of reservations) {', '  for (const reservation of reservations) {\n    if (typeof reservation.resourceId !== "string" || !reservation.resourceId) return null;')
replace('public/studio.mjs', '    const column = node("div", "timeline-lane");', '    const column = node("div", "timeline-lane");\n    column.dataset.resourceId = lane.id;')
replace('public/studio.mjs', '      tile.title = description;', '      tile.title = description;\n      if (closure) tile.setAttribute("role", "img");')
with Path('public/studio.css').open('a') as file:
    file.write('''
/* Whole cards are large click targets; the checkbox itself is not a giant field. */
.service-list [data-service-option] { grid-template-columns: 1.2rem minmax(0, 1fr); column-gap: 0.7rem; align-content: center; }
.service-list [data-service-option] input[type="checkbox"] { grid-column: 1; grid-row: 1 / span 2; align-self: center; width: 1.15rem; height: 1.15rem; min-height: 0; padding: 0; margin: 0; }
.service-list [data-service-option] strong, .service-list [data-service-option] .helper { grid-column: 2; margin: 0; }
''')
with Path('test/studio.test.ts').open('a') as file:
    file.write('''
test("identical labels do not combine resource lanes and missing IDs fall back safely", () => {
  const resources = [{ id: "a", label: "同名担当" }, { id: "b", label: "同名担当" }];
  const result = timelineLayout(board([booking(), booking({ reservationId: "r2", resourceId: "b" })]), resources);
  assert.deepEqual(result.lanes.map((lane) => lane.entries.map((entry) => entry.record.resourceId)), [["a"], ["b"]]);
  assert.equal(timelineLayout(board([booking({ resourceId: undefined })]), resources), null);
});
''')
replace('.github/workflows/ci.yml', '      - name: Verify the rendered pages\n', '      - name: Install Japanese browser fonts\n        run: sudo apt-get update && sudo apt-get install -y fonts-noto-cjk\n\n      - name: Verify the rendered pages\n')
replace('scripts/release-audit.mjs', '  "- name: Verify the rendered pages",', '  "- name: Install Japanese browser fonts",\n  "run: sudo apt-get update && sudo apt-get install -y fonts-noto-cjk",\n  "- name: Verify the rendered pages",')
replace('docs/DESIGN-STUDIO.md', 'it does not copy or generalize private production source or claim migration parity.', 'it does not copy or generalize private production source or claim migration parity.\nThe authenticated schedule projection adds the existing stable resource ID so\nidentically named resources remain separate. The customer projection is unchanged.')
replace('docs/DESIGN-STUDIO.md', 'Record the actual run and observed remaining differences in the PR before merge.', 'The CI browser environment installs Japanese fonts to make rendered evidence readable.\nRecord the actual run and observed remaining differences in the PR before merge.')
replace('CHANGELOG.md', '### Changed\n', '### Changed\n\n- Image-first studio presentation for customer and operator pages: a keyboard-operable\n  week strip, compact booking stages, and a protected day timetable with an agenda fallback.\n  Dense schedules keep contact information in the detail panel instead of every card.\n- Authenticated schedule records include their stable resource ID; resources with identical\n  labels remain separate in the timetable. Booking transactions and customer projections\n  are unchanged. Browser CI installs Japanese fonts for readable visual evidence.\n')
