// LINE 連携の予約カード拡張。/api/config が LINE 連携の情報を返したときだけ
// app.js から動的に読み込まれます。未設定のインストールでは取得すらされません。
// mode "capability" = 連携の開始と解除、mode "cleanup" = 既存連携の確認と解除のみ
// (LINE への通信は一切行いません)。

const INTENT_STORAGE_KEY = "salon-reservation:line-link-intent:v1";

const rowFor = (card) => {
  let row = card.querySelector("[data-line-link-row]");
  if (row) return row;
  row = document.createElement("div");
  row.dataset.lineLinkRow = "";
  row.className = "line-link-row";
  const label = document.createElement("p");
  label.className = "section-label";
  label.textContent = "LINE 通知";
  const status = document.createElement("p");
  status.dataset.lineLinkStatus = "";
  status.className = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.dataset.lineLinkActions = "";
  actions.className = "button-row";
  row.append(label, status, actions);
  const summary = card.querySelector("[data-booking-summary]");
  if (summary) summary.insertAdjacentElement("afterend", row);
  else card.append(row);
  return row;
};

export const enhanceBookingCards = ({ mode, list, records, api }) => {
  const recordById = new Map(records.map((record) => [record.reservationId, record]));

  const setRow = (row, message, buttons) => {
    row.querySelector("[data-line-link-status]").textContent = message;
    const actions = row.querySelector("[data-line-link-actions]");
    actions.replaceChildren(...buttons);
  };

  const button = (label, className, onClick) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.addEventListener("click", () => {
      element.disabled = true;
      onClick().finally(() => {
        element.disabled = false;
      });
    });
    return element;
  };

  const startLink = async (record, row) => {
    try {
      const intent = await api(
        `/api/reservations/${encodeURIComponent(record.reservationId)}/line/link-intent`,
        {
          method: "POST",
          body: JSON.stringify({ date: record.date, managementKey: record.managementKey }),
        },
      );
      sessionStorage.setItem(
        INTENT_STORAGE_KEY,
        JSON.stringify({ nonce: intent.nonce, expiresAt: intent.expiresAt }),
      );
      // 固定の同一オリジンページのみに遷移します。
      window.location.assign("/line.html");
    } catch (error) {
      setRowError(row, error);
    }
  };

  const unlink = async (record, card, row) => {
    try {
      await api(
        `/api/reservations/${encodeURIComponent(record.reservationId)}/line/unlink`,
        {
          method: "POST",
          body: JSON.stringify({ date: record.date, managementKey: record.managementKey }),
        },
      );
      await renderCard(record, card);
    } catch (error) {
      setRowError(row, error);
    }
  };

  const setRowError = (row, error) => {
    setRow(
      row,
      error instanceof Error && error.message
        ? error.message
        : "現在処理できません。しばらく待ってからお試しください。",
      [],
    );
  };

  const renderCard = async (record, card) => {
    const row = rowFor(card);
    let linked = null;
    try {
      const status = await api(
        `/api/reservations/${encodeURIComponent(record.reservationId)}/line/status`,
        {
          method: "POST",
          body: JSON.stringify({ date: record.date, managementKey: record.managementKey }),
        },
      );
      linked = status.linked;
    } catch (error) {
      if (error?.status !== 404) {
        setRow(row, "LINE 連携の状態を確認できませんでした。", []);
        return;
      }
    }
    const state = card.dataset.bookingState;
    if (linked === "final") {
      setRow(row, "この予約は LINE と連携済みです。状態が変わるとお知らせします。", [
        button("連携を解除する", "text-button", () => unlink(record, card, row)),
      ]);
      return;
    }
    if (linked === "provisional") {
      setRow(
        row,
        "LINE 連携の手続きが完了していません。",
        mode === "capability"
          ? [
              button("連携を続ける", "secondary-button", () => startLink(record, row)),
              button("手続きを取りやめる", "text-button", () => unlink(record, card, row)),
            ]
          : [button("手続きを取りやめる", "text-button", () => unlink(record, card, row))],
      );
      return;
    }
    if (mode === "capability" && (state === "pending" || state === "approved")) {
      setRow(row, "予約の承認や変更を LINE で受け取れます。", [
        button("LINE で通知を受け取る", "secondary-button", () => startLink(record, row)),
      ]);
      return;
    }
    // 連携がなく、開始もできない状態では何も描画しません。
    row.remove();
  };

  const cards = list.querySelectorAll("[data-booking-card][data-reservation-id]");
  for (const card of cards) {
    const record = recordById.get(card.dataset.reservationId);
    if (record !== undefined) void renderCard(record, card);
  }
};

export { INTENT_STORAGE_KEY };
