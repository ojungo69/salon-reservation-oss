// Presentation only: these helpers never decide availability or mutate a booking.
const DAY = 86_400_000;
const asDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};

export const weekDates = (value, min = "", max = "") => {
  const selected = asDate(value);
  if (!selected || (min && !asDate(min)) || (max && !asDate(max))) return [];
  const monday = selected.getTime() - ((selected.getUTCDay() + 6) % 7) * DAY;
  return Array.from({ length: 7 }, (_, index) => new Date(monday + index * DAY).toISOString().slice(0, 10))
    .filter((date) => (!min || date >= min) && (!max || date <= max));
};

const minute = (value) => {
  if (value === "24:00") return 1440;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
};
const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const node = (tag, className = "", text = "") => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

export const timelineLayout = (board, resources = []) => {
  if (!board) return null;
  const lanes = new Map(resources.map(({ id, label }) => [id, { id, label, entries: [] }]));
  const reservations = (board.reservations ?? []).filter(({ status }) => status === "pending" || status === "approved");
  for (const reservation of reservations) {
    if (!lanes.has(reservation.resourceId)) lanes.set(reservation.resourceId, {
      id: reservation.resourceId, label: reservation.resourceLabel ?? reservation.resourceId, entries: [],
    });
    const start = minute(reservation.startTime);
    const duration = reservation.serviceMinutes + reservation.cleanupMinutes;
    if (!Number.isInteger(reservation.serviceMinutes) || reservation.serviceMinutes <= 0 || !Number.isInteger(reservation.cleanupMinutes) || reservation.cleanupMinutes < 0 || start === null || !Number.isInteger(duration) || duration < 30 || start + duration > 1440) return null;
    lanes.get(reservation.resourceId).entries.push({ kind: "reservation", start, end: start + duration, record: reservation });
  }
  // A dense roster remains an agenda rather than an unreadable miniature grid.
  if (lanes.size === 0 || lanes.size > 4) return null;
  for (const closure of (board.closures ?? []).filter(({ active }) => active)) {
    const start = minute(closure.startTime); const end = minute(closure.endTime);
    if (start === null || end === null || end <= start) return null;
    if (closure.resourceId !== null && !lanes.has(closure.resourceId)) return null;
    for (const lane of lanes.values()) {
      if (closure.resourceId === null || closure.resourceId === lane.id) {
        lane.entries.push({ kind: "closure", start, end, record: closure });
      }
    }
  }
  for (const lane of lanes.values()) {
    lane.entries.sort((a, b) => a.start - b.start || a.end - b.end);
    if (lane.entries.some((entry, index) => index > 0 && entry.start < lane.entries[index - 1].end)) return null;
  }
  const all = [...lanes.values()].flatMap(({ entries }) => entries);
  const opens = minute(board.opensAt); const closes = minute(board.closesAt);
  if (opens === null || closes === null || closes <= opens) return null;
  const start = Math.floor(Math.min(opens, ...all.map((entry) => entry.start)) / 60) * 60;
  const end = Math.ceil(Math.max(closes, ...all.map((entry) => entry.end)) / 60) * 60;
  return { start, end, lanes: [...lanes.values()] };
};

/** Supplement the native date field; never label an unchecked day as available. */
export const mountDateStrip = (input) => {
  const region = node("div", "date-strip");
  region.setAttribute("role", "group");
  region.setAttribute("aria-label", "同じ週の日付を選ぶ");
  input.closest(".field-grid").after(region);
  const weekday = new Intl.DateTimeFormat("ja-JP", { weekday: "short", timeZone: "UTC" });
  let signature = "";
  const refresh = () => {
    const dates = weekDates(input.value, input.min, input.max);
    region.hidden = dates.length === 0;
    const next = dates.join(",");
    if (signature !== next) {
      region.replaceChildren();
      for (const date of dates) {
        const button = node("button", "date-strip-day");
        button.type = "button";
        button.dataset.date = date;
        button.setAttribute("aria-label", `${date} ${weekday.format(asDate(date))}曜日`);
        button.append(node("span", "date-strip-number", `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`), node("span", "date-strip-weekday", weekday.format(asDate(date))));
        button.addEventListener("click", () => {
          if (input.disabled) return;
          input.value = date;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          refresh();
        });
        region.append(button);
      }
      signature = next;
    }
    for (const button of region.querySelectorAll("button")) {
      button.disabled = input.disabled;
      button.setAttribute("aria-pressed", String(button.dataset.date === input.value));
    }
  };
  input.addEventListener("change", refresh);
  input.addEventListener("input", refresh);
  new MutationObserver(refresh).observe(input, { attributes: true, attributeFilter: ["min", "max", "disabled"] });
  refresh();
};

/** The server remains authoritative. The agenda below retains every status. */
export const renderTimeline = (board, resources, onOpen) => {
  const layout = timelineLayout(board, resources);
  if (!layout) return null;
  const region = node("section", "schedule-timeline");
  region.setAttribute("aria-label", "受付中の予約と休業時間の時間割");
  const legend = node("p", "timeline-legend");
  legend.append(node("span", "timeline-approved", "予約確定"), node("span", "timeline-pending", "確認待ち"), node("span", "timeline-closed", "休業"));
  region.append(legend);
  const scroll = node("div", "timeline-scroll");
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "group");
  scroll.setAttribute("aria-label", "時間割。上下にスクロールできます");
  const columns = `3.5rem repeat(${layout.lanes.length}, minmax(0, 1fr))`;
  const header = node("div", "timeline-header");
  header.style.gridTemplateColumns = columns;
  header.append(node("span", "", "時間"));
  for (const lane of layout.lanes) header.append(node("span", "", lane.label));
  const grid = node("div", "timeline-grid");
  grid.style.gridTemplateColumns = columns;
  grid.style.height = `${(layout.end - layout.start) * 2 + 24}px`;
  const ruler = node("div", "timeline-ruler");
  ruler.setAttribute("aria-hidden", "true");
  for (let time = layout.start; time <= layout.end; time += 60) {
    const label = node("span", "", clock(time));
    label.style.top = `${(time - layout.start) * 2}px`;
    ruler.append(label);
  }
  grid.append(ruler);
  for (const lane of layout.lanes) {
    const column = node("div", "timeline-lane");
    for (const entry of lane.entries) {
      const closure = entry.kind === "closure";
      const state = closure ? "休業" : entry.record.status === "pending" ? "確認待ち" : "予約確定";
      const tile = node(closure ? "div" : "button", `timeline-tile ${closure ? "timeline-closure" : `timeline-${entry.record.status}`}`);
      tile.style.top = `${(entry.start - layout.start) * 2 + 2}px`;
      tile.style.height = `${(entry.end - entry.start) * 2 - 4}px`;
      const label = closure ? entry.record.label : entry.record.services.map(({ label }) => label).join("、");
      const description = `${clock(entry.start)}〜${clock(entry.end)} ${lane.label} ${label} ${state}`;
      tile.title = description;
      tile.setAttribute("aria-label", closure ? description : `${description}。詳細を開く`);
      tile.append(node("span", "timeline-time", `${clock(entry.start)}–${clock(entry.end)}`), node("strong", "timeline-label", label), node("span", "timeline-state", state));
      if (!closure) {
        tile.type = "button";
        tile.dataset.timelineReservation = entry.record.reservationId;
        tile.addEventListener("click", () => onOpen(entry.record));
      }
      column.append(tile);
    }
    grid.append(column);
  }
  scroll.append(header, grid);
  region.append(scroll, node("p", "helper", "時間枠には準備時間を含みます。空白は予約可能を意味しません。取消・来店済みなどは下の一覧で確認できます。"));
  return region;
};
