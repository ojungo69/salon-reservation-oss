import {
  decodeJourneyDraft,
  decodePendingMutationRecord,
  encodeJourneyDraft,
  encodePendingMutationRecord,
  COMPACT_SERVICE_THRESHOLD,
  filterServiceCatalog,
  duplicateAcknowledgementNeeded,
  duplicateCheckCandidates,
  getJourneyStep,
  pickAutoResource,
  readOwnedBookingRecords,
  removeOwnedBookingRecord,
  restoreJourneyDraft,
  saveOwnedBookingRecord,
  summarizeJourney,
  summarizeServiceSelection,
} from "./journey.js";
import {
  aggregateOwnedProofs,
  chooseOperatorLocation,
  choosePublicLocation,
  explicitLocation,
  scopedPath,
  storageKey,
  validLocationDirectory,
} from "./location.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const DAY_MS = 86_400_000;
const DRAFT_KEY = "salon-reservation:journey-draft:v1";
const PENDING_CREATE_KEY = "salon-reservation:pending-customer-create:v1";
const OWNER_PENDING_CREATE_KEY = "salon-reservation:pending-owner-create:v1";
const OWNED_BOOKINGS_KEY = "salon-reservation:owned-bookings:v1";
const SETUP_STEP_KEY = "salon-reservation:setup-step:v1";

const STATUS_LABELS = {
  pending: "確認待ち",
  approved: "予約確定",
  rejected: "受付見送り",
  cancelled: "取消済み",
  completed: "来店済み",
  expired: "期限切れ",
  no_show: "無断不来",
};

const ACTION_LABELS = {
  approve: "承認",
  reject: "見送り",
  cancel: "取消",
  reschedule: "日時変更",
  complete: "来店済み",
  no_show: "無断不来",
};

const createElement = (tag, className = "", text = "") => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

const setStatus = (element, message, tone = "") => {
  if (!element) return;
  element.textContent = message;
  if (tone) element.dataset.tone = tone;
  else delete element.dataset.tone;
};

const focusWithoutScroll = (element) => {
  if (!element) return;
  // Only teach non-focusable targets (headings, fieldsets) to accept focus; a
  // tabindex="-1" on a native control would drop it from the Tab order.
  if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) {
    element.setAttribute("tabindex", "-1");
  }
  element.focus({ preventScroll: true });
};

const api = async (path, options = {}) => {
  let response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error("通信結果を確認できませんでした。接続を確認して、同じ操作をもう一度お試しください。");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("応答を確認できませんでした。しばらく待ってから、同じ操作をお試しください。");
  }
  if (!response.ok) {
    const error = new Error(
      body?.error?.message ?? "現在処理できません。しばらく待ってからお試しください。",
    );
    error.status = response.status;
    error.code = body?.error?.code;
    if (response.status === 429) error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return body;
};

const staleOwnerSessionError = () => {
  const error = new Error("認証状態が変わりました。もう一度認証してください。");
  error.status = 401;
  return error;
};

const createOwnerApi = (getToken) => async (path, options = {}) => {
  const token = getToken();
  if (!token) throw staleOwnerSessionError();
  const response = await api(path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
  });
  if (getToken() !== token) throw staleOwnerSessionError();
  return response;
};

const jstToday = () =>
  new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);

const addDays = (date, amount) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + amount * DAY_MS)
    .toISOString()
    .slice(0, 10);

const newManagementKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const digestHex = async (value) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const copyText = async (value, status) => {
  try {
    await navigator.clipboard.writeText(value);
    setStatus(status, "コピーしました。", "success");
  } catch {
    setStatus(status, "コピーできませんでした。文字列を選択して控えてください。", "error");
  }
};

const formatPrice = (priceYen) =>
  priceYen === null || priceYen === undefined
    ? "料金は当日ご案内します"
    : `${new Intl.NumberFormat("ja-JP").format(priceYen)}円`;

const formatDateTime = (date, time) => `${date} ${time}`;

// The store's clock, not the visitor's: a customer in another timezone reading
// "18:00までに承認されないと期限切れ" has to be reading the salon's 18:00.
const formatDeadline = (iso) =>
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

const reviewHelpText = (pending, mode, turnstileToken) => {
  if (pending) return "前回の受付結果だけを再確認できます。新しい予約は作成しません。";
  if (mode !== "live") {
    return "デモ・設定中のため送信できません。実在する方の情報は入力しないでください。";
  }
  if (turnstileToken) return "送信時に空き状況をもう一度確認します。";
  return "内容を確認し、自動送信防止の確認を完了すると送信できます。";
};

const bookingStatusDescription = (booking, statusLabel) => {
  if (booking.rejectionReason) {
    return `${STATUS_LABELS[booking.status] ?? booking.status}（${booking.rejectionReason}）`;
  }
  if (booking.expiresAt) {
    return `${statusLabel}（${formatDeadline(booking.expiresAt)}までに確認されないと期限切れになります）`;
  }
  return statusLabel;
};

const liveButtonLabel = (pendingLive, mode) => {
  if (pendingLive) return "未確認の切替結果を再確認する";
  if (mode === "live") return "公開予約を停止してデモに戻す";
  return "公開予約を有効にする";
};

const setupHelpText = (authenticated, pending, accepting, setupState) => {
  if (!authenticated) return "認証すると、各項目の編集と保存ができるようになります。";
  if (pending) return "前回の結果が未確認です。同じ操作を再送して確認できます。";
  if (accepting) return "現在は公開予約を受け付けています。設定変更は新しい版として保存されます。";
  if (setupState.mode === "live") {
    return "公開設定は有効ですが、保護設定が不足しているため受付は停止中です。要確認の項目を復旧してください。";
  }
  if (setupState.readiness.ready) {
    return "4つの準備が完了しました。内容を確認して公開予約を有効にできます。";
  }
  return "要確認の項目を修正して設定を保存してください。";
};

const setupModeNoticeText = (accepting, mode) => {
  if (accepting) {
    return "現在は公開予約を受け付けています。設定変更後も、保存済みの予約内容は書き換わりません。";
  }
  if (mode === "live") {
    return "公開設定は有効のままですが、保護設定が不足しているため予約受付は停止中です。要確認の項目を復旧してください。";
  }
  return "現在はデモ・設定中です。公開予約は、4つの準備項目がすべて完了するまで有効になりません。";
};

const firstVisible = (root, selector) =>
  [...root.querySelectorAll(selector)].find((el) => !el.closest("[hidden]"));

const collectRejectReason = (detailStatus) => {
  const reason = window.prompt("お客様にも表示する見送り理由を200文字以内で入力してください。");
  if (reason === null) return null;
  if (!reason.trim() || Array.from(reason.trim()).length > 200) {
    setStatus(detailStatus, "見送り理由を1〜200文字で入力してください。", "error");
    return null;
  }
  return reason.trim();
};

const collectRescheduleSlot = async (reservation, ownerApi, detailStatus, isCurrent) => {
  setStatus(detailStatus, "同じ日の空き時間を確認しています。");
  let available;
  try {
    available = await ownerApi(
      availabilityPath(
        reservation.date,
        reservation.services.map(({ id }) => id),
        reservation.reservationId,
        "/api/admin/availability",
      ),
    );
  } catch (error) {
    if (isCurrent()) setStatus(detailStatus, error.message, "error");
    return null;
  }
  if (!isCurrent()) return null;
  const resources = available.resources.filter(({ startTimes }) => startTimes.length);
  if (!resources.length) {
    setStatus(detailStatus, "同じ日に移動できる空き時間がありません。", "error");
    return null;
  }
  const resourceId = window.prompt(
    `移動先の識別子を入力してください。\n${resources.map(({ id, label }) => id + ": " + label).join("\n")}`,
    resources[0].id,
  );
  if (resourceId === null) return null;
  const resource = resources.find(({ id }) => id === resourceId.trim());
  if (!resource) {
    setStatus(detailStatus, "一覧にある担当・設備を選んでください。", "error");
    return null;
  }
  const startTime = window.prompt(
    `開始時間を入力してください。\n${resource.startTimes.join(" / ")}`,
    resource.startTimes[0],
  );
  if (startTime === null) return null;
  if (!resource.startTimes.includes(startTime.trim())) {
    setStatus(detailStatus, "一覧にある開始時間を選んでください。", "error");
    return null;
  }
  return { resourceId: resource.id, startTime: startTime.trim() };
};

const confirmDestructiveTransition = (action) => {
  const message =
    action === "cancel"
      ? "この予約を取り消します。元に戻せません。続けますか？"
      : "この予約を無断不来として記録しますか？";
  return window.confirm(message);
};

const collectTransitionCommand = async (action, reservation, ownerApi, detailStatus, isCurrent = () => true) => {
  const command = { commandId: crypto.randomUUID(), date: reservation.date, action };
  if (action === "reject") {
    const reason = collectRejectReason(detailStatus);
    if (reason === null) return null;
    command.reason = reason;
    return command;
  }
  if (action === "reschedule") {
    const slot = await collectRescheduleSlot(reservation, ownerApi, detailStatus, isCurrent);
    if (slot === null) return null;
    command.resourceId = slot.resourceId;
    command.startTime = slot.startTime;
    return command;
  }
  if (["cancel", "no_show"].includes(action) && !confirmDestructiveTransition(action)) {
    return null;
  }
  return command;
};

const lookupDuplicateAcknowledgement = async (lookupDate, api, readOwnedRecords, locations) => {
  const candidates = locations.length === 1
    ? duplicateCheckCandidates(readOwnedRecords(locations[0].id), lookupDate, Date.now())
      .map((record) => ({ locationId: locations[0].id, record }))
    : locations.flatMap(({ id }) =>
      readOwnedRecords(id).map((record) => ({ locationId: id, record })))
      .filter(({ record }) => record.date === lookupDate)
      .sort((left, right) => left.record.savedAt - right.record.savedAt)
      .slice(-3);
  const statuses = await Promise.all(
    candidates.map(async ({ locationId, record }) => {
      try {
        const booking = await api(
          scopedPath(`/api/reservations/${encodeURIComponent(record.reservationId)}/status`, locationId),
          {
            method: "POST",
            body: JSON.stringify({
              date: record.date,
              managementKey: record.managementKey,
            }),
          },
        );
        return { status: booking.status, locationId };
      } catch {
        // A failed lookup never blocks the booking.
        return { status: null, locationId };
      }
    }),
  );
  const live = statuses.filter(({ status }) => status === "pending" || status === "approved");
  return {
    needed: duplicateAcknowledgementNeeded(statuses.map(({ status }) => status)),
    labels: [...new Set(live.map(({ locationId }) =>
      locations.find(({ id }) => id === locationId)?.label).filter(Boolean))],
  };
};

const sourceUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

const applyPublicConfig = (config, locationId = "default") => {
  $$("[data-location-name]").forEach((element) => {
    element.textContent = config.locationName;
  });
  const title = document.title.split("|")[0].trim();
  document.title = `${title} | ${config.locationName}`;
  const publicSource = sourceUrl(config.sourceUrl);
  $$("[data-source-link]").forEach((element) => {
    const fallback = element.dataset.locationBaseHref ?? element.getAttribute("href");
    if (!element.dataset.locationBaseHref) element.dataset.locationBaseHref = fallback;
    element.href = publicSource ?? navigationPath(fallback, locationId);
  });
  $$('[data-consent-version]').forEach((element) => {
    element.textContent = config.consentVersion;
  });
  document.documentElement.dataset.theme = config.themeId;
  document.body.dataset.installationMode = config.mode;
};

const navigationPath = (path, locationId) => {
  const scoped = scopedPath(path, locationId);
  if (locationId !== "default" || explicitLocation(window.location.search) !== "default") return scoped;
  const url = new URL(scoped, "https://scope.invalid");
  url.searchParams.set("location", "default");
  return `${url.pathname}${url.search}${url.hash}`;
};

const setPageLocation = (locationId, multiple, method = "replaceState", state = null) => {
  const url = new URL(window.location.href);
  url.searchParams.delete("location");
  if (locationId !== "default" || multiple) url.searchParams.set("location", locationId);
  window.history[method](state, "", `${url.pathname}${url.search}${url.hash}`);
};

const applyLocationLinks = (locationId) => {
  $$("a[href]").forEach((link) => {
    let original = link.dataset.locationBaseHref ?? link.getAttribute("href");
    if (!original.startsWith("/") || original.startsWith("//")) return;
    if (!link.dataset.locationBaseHref) {
      const parsed = new URL(original, "https://scope.invalid");
      parsed.searchParams.delete("location");
      original = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    link.dataset.locationBaseHref = original;
    link.setAttribute("href", navigationPath(original, locationId));
  });
};

const readLocationDirectory = async () => {
  const { locations } = await api("/api/locations");
  if (!validLocationDirectory(locations)) {
    throw new Error("場所の一覧を確認できませんでした。再読み込みしてください。");
  }
  return locations;
};

const readPendingMutation = (storageKey = PENDING_CREATE_KEY) => {
  try {
    const encoded = sessionStorage.getItem(storageKey);
    const pending = decodePendingMutationRecord(encoded, Date.now());
    if (!pending && encoded) sessionStorage.removeItem(storageKey);
    return pending;
  } catch {
    return null;
  }
};

const writePendingMutation = (pending, storageKey = PENDING_CREATE_KEY) => {
  try {
    sessionStorage.setItem(storageKey, encodePendingMutationRecord(pending));
  } catch {
    throw new Error("通信結果を安全に再確認できないため、このブラウザでは送信できません。");
  }
};

const clearPendingMutation = (storageKey = PENDING_CREATE_KEY) => {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // The record can only replay the same command and expires after 24 hours.
  }
};

const readOwnedRecords = (locationId = "default") => {
  try {
    const encoded = localStorage.getItem(storageKey(OWNED_BOOKINGS_KEY, locationId));
    if (!encoded || encoded.length > 16 * 1_024) return [];
    return readOwnedBookingRecords(JSON.parse(encoded), Date.now());
  } catch {
    return [];
  }
};

const writeOwnedRecords = (records, locationId = "default") => {
  const key = storageKey(OWNED_BOOKINGS_KEY, locationId);
  if (records.length === 0) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(records));
};

const readDraft = (locationId = "default") => {
  try {
    const key = storageKey(DRAFT_KEY, locationId);
    const encoded = localStorage.getItem(key);
    const draft = decodeJourneyDraft(encoded, Date.now());
    if (!draft && encoded) localStorage.removeItem(key);
    return draft;
  } catch {
    return null;
  }
};

const clearDraft = (locationId = "default") => {
  try {
    localStorage.removeItem(storageKey(DRAFT_KEY, locationId));
  } catch {
    // Draft persistence is optional and never authoritative.
  }
};

const availabilityPath = (
  date,
  serviceIds,
  reservationId,
  path = "/api/availability",
) => {
  const query = new URLSearchParams({ date });
  for (const serviceId of serviceIds) query.append("serviceId", serviceId);
  if (reservationId) query.set("reservationId", reservationId);
  return `${path}?${query}`;
};

const serviceOption = (service, name, selected, onChange) => {
  const label = createElement("label");
  label.dataset.serviceOption = "";
  label.dataset.selected = String(selected);
  const input = createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.value = service.id;
  input.checked = selected;
  const title = createElement("strong", "", service.label);
  const details = createElement(
    "span",
    "helper",
    [
      service.category,
      `${service.durationMinutes}分`,
      service.cleanupMinutes ? `準備 ${service.cleanupMinutes}分` : null,
      formatPrice(service.priceYen),
    ].filter(Boolean).join(" / "),
  );
  input.addEventListener("change", () => {
    label.dataset.selected = String(input.checked);
    onChange(input);
  });
  label.append(input, title, details);
  return label;
};

const startCustomer = async () => {
  const root = $("[data-journey-root]");
  const form = $("[data-booking-form]");
  const serviceList = $("[data-service-list]");
  const serviceHelp = $("[data-service-help]");
  const dateInput = $("#booking-date");
  const resourceSelect = $("#booking-resource");
  const slotField = $("#slot-field");
  const slotList = $("[data-slot-list]");
  const availabilityHelp = $("[data-availability-help]");
  const nameInput = $("#customer-name");
  const contactInput = $("#customer-contact");
  const consentInput = $("#booking-consent");
  const selectionNext = $("[data-journey-next='details']");
  const detailsNext = $("[data-journey-next='review']");
  const submit = $("[data-booking-submit]");
  const live = $("[data-journey-live]");
  const status = $("[data-booking-status]");
  const result = $("[data-booking-result]");
  const resultId = $("#result-reservation-id");
  const resultKey = $("#result-management-key");
  const resultStatus = $("[data-booking-result-status]");
  const remember = $("[data-remember-booking]");
  const keyStatus = $("#key-status");
  const modeNotice = $("[data-installation-mode-notice]");
  const resourceRow = $("[data-resource-row]");
  const assignedResource = $("[data-assigned-resource]");
  const serviceFilter = $("[data-service-filter]");
  const serviceFilterInput = $("[data-service-filter-input]");
  const serviceFilterCount = $("[data-service-filter-count]");
  const serviceChips = $("[data-service-chips]");
  const serviceTotals = $("[data-service-totals]");
  const availabilityNotice = $("[data-availability-notice]");
  const availabilityRefresh = $("[data-availability-refresh]");
  const duplicateDialog = $("[data-duplicate-dialog]");
  const duplicateLocationSummary = $("[data-duplicate-location-summary]");
  const locationAnchor = $("[data-location-anchor]");
  let config;
  let locations = [];
  let locationId = "default";
  let locationSelect = null;
  let locationEpoch = 0;
  let availability = null;
  let journeyStep = "selection";
  let availabilitySequence = 0;
  let pending = null;
  let turnstileToken = "";
  let widgetId;
  let resultRecord = null;
  let resultLocationId = null;
  let busy = false;
  let duplicateAcknowledged = false;

  const selectedServiceIds = () =>
    $$("input[name='serviceIds']:checked", serviceList).map(({ value }) => value);

  const selectedStartTime = () =>
    $("input[name='startTime']:checked", slotList)?.value ?? null;

  const selection = () =>
    pending?.request ?? {
      serviceIds: selectedServiceIds(),
      resourceId: resourceSelect.value || null,
      date: dateInput.value || null,
      startTime: selectedStartTime(),
    };

  const details = () =>
    pending?.request ?? {
      customerName: nameInput.value.trim(),
      contact: contactInput.value.trim(),
      consent: consentInput.checked,
    };

  const saveDraft = () => {
    if (!config || pending) return;
    const current = selection();
    try {
      localStorage.setItem(
        storageKey(DRAFT_KEY, locationId),
        encodeJourneyDraft({
          version: 1,
          settingsVersion: config.settingsVersion,
          serviceIds: current.serviceIds,
          resourceId: current.resourceId,
          date: current.date,
          startTime: current.startTime,
          step: journeyStep,
          savedAt: Date.now(),
        }),
      );
    } catch {
      // The journey remains usable without optional draft restoration.
    }
  };

  const updateActions = () => {
    const currentSelection = selection();
    const currentDetails = details();
    const selectionReady =
      getJourneyStep({
        requestedStep: "details",
        selection: currentSelection,
        details: {},
      }) === "details";
    const detailsReady =
      getJourneyStep({
        requestedStep: "review",
        selection: currentSelection,
        details: currentDetails,
      }) === "review";
    selectionNext.disabled = busy || Boolean(pending) || !selectionReady;
    detailsNext.disabled = busy || Boolean(pending) || !detailsReady;
    submit.disabled =
      busy ||
      (!pending && (
        config?.mode !== "live" ||
        journeyStep !== "review" ||
        !detailsReady ||
        !turnstileToken
      ));
    $("[data-journey-help='selection']").textContent = selectionReady
      ? "選択内容を確認しました。連絡先の入力へ進めます。"
      : "サービス、担当・設備、日時を選ぶと次へ進めます。";
    $("[data-journey-help='details']").textContent = detailsReady
      ? "入力内容を確認しました。予約内容の確認へ進めます。"
      : "お名前、ご連絡先、同意を確認すると内容を確認できます。";
    $("[data-journey-help='review']").textContent = reviewHelpText(
      pending,
      config?.mode,
      turnstileToken,
    );
  };

  const setPendingMode = () => {
    const active = Boolean(pending);
    if (locationSelect) locationSelect.disabled = active || busy;
    $$("input[name='serviceIds']", serviceList).forEach((input) => {
      input.disabled = active;
    });
    $$("[data-summary-edit]").forEach((button) => {
      button.disabled = active;
    });
    serviceFilterInput.disabled = active;
    $$("button", serviceChips).forEach((button) => {
      button.disabled = active;
    });
    availabilityRefresh.disabled = active;
    dateInput.disabled = active;
    resourceSelect.disabled = active || !availability;
    slotField.disabled = active || !availability;
    nameInput.disabled = active;
    contactInput.disabled = active;
    consentInput.disabled = active;
    submit.textContent = active
      ? "未確認の予約結果を再確認する"
      : "この内容で予約を申請する";
    updateActions();
  };

  const resourceChoiceExposed = () => config?.exposeResourceChoice !== false;

  const summaryText = () => {
    const summary = summarizeJourney(selection(), config, availability);
    return {
      services: summary.serviceLabels.join("、") || "未選択",
      resource: summary.resourceLabel ?? "未選択",
      time:
        summary.date && summary.startTime
          ? formatDateTime(summary.date, summary.startTime)
          : "未選択",
      duration:
        summary.occupiedMinutes === null
          ? "送信時に再確認します"
          : `${summary.serviceMinutes}分 + 準備 ${summary.cleanupMinutes}分（計 ${summary.occupiedMinutes}分）`,
      // occupiedMinutes doubles as the loaded-availability signal: a null price
      // on loaded availability legitimately means the price is announced on site.
      price:
        summary.occupiedMinutes === null ? "送信時に再確認します" : formatPrice(summary.priceYen),
    };
  };

  const renderSummaryCard = () => {
    const text = summaryText();
    $("[data-summary-location]").textContent = config?.locationName ?? "未選択";
    $("[data-summary-services]").textContent = text.services;
    $("[data-summary-resource]").textContent = text.resource;
    $("[data-summary-time]").textContent = text.time;
    $("[data-summary-duration]").textContent = text.duration;
    $("[data-summary-price]").textContent = text.price;
  };

  const renderReview = () => {
    const text = summaryText();
    $("[data-review-location]").textContent = config?.locationName ?? "未選択";
    $("[data-review-services]").textContent = text.services;
    $("[data-review-resource]").textContent = text.resource;
    $("[data-review-time]").textContent = text.time;
    $("[data-review-duration]").textContent = text.duration;
    $("[data-review-price]").textContent = text.price;
    $("[data-review-name]").textContent = details().customerName || "未入力";
    $("[data-review-contact]").textContent = details().contact || "未入力";
  };

  const ensureTurnstile = async () => {
    if (widgetId !== undefined || config.mode !== "live") return;
    if (!config.turnstileSiteKey) {
      setStatus(status, "自動送信防止の設定が完了していません。", "error");
      return;
    }
    if (!window.turnstile && document.readyState !== "complete") {
      await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
    }
    if (!window.turnstile) {
      setStatus(status, "自動送信防止の確認を読み込めませんでした。", "error");
      return;
    }
    widgetId = window.turnstile.render("#turnstile-widget", {
      sitekey: config.turnstileSiteKey,
      action: "reservation-create",
      callback: (token) => {
        turnstileToken = token;
        updateActions();
      },
      "expired-callback": () => {
        turnstileToken = "";
        updateActions();
      },
      "error-callback": () => {
        turnstileToken = "";
        setStatus(status, "自動送信防止の確認に失敗しました。もう一度お試しください。", "error");
        updateActions();
      },
    });
  };

  const setStep = (requestedStep, { history = "push", focus = true } = {}) => {
    const nextStep = getJourneyStep({
      requestedStep,
      selection: selection(),
      details: details(),
    });
    journeyStep = nextStep;
    $$("[data-journey-stage]").forEach((stage) => {
      stage.hidden = stage.dataset.journeyStage !== nextStep;
    });
    $$("[data-journey-progress-step]").forEach((item) => {
      if (item.dataset.journeyProgressStep === nextStep) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
    if (history === "push") {
      window.history.pushState({ journeyStep: nextStep, locationId }, "");
    } else if (history === "replace") {
      window.history.replaceState({ journeyStep: nextStep, locationId }, "");
    }
    if (nextStep === "details") renderSummaryCard();
    if (nextStep === "review") {
      renderReview();
      void ensureTurnstile();
    }
    live.textContent = {
      selection: "手順1、サービスと日時を選びます。",
      details: "手順2、連絡先と同意を確認します。",
      review: "手順3、予約内容を確認して送信します。",
    }[nextStep];
    if (focus) {
      queueMicrotask(() => focusWithoutScroll($(`#journey-${nextStep} h2`)));
    }
    saveDraft();
    updateActions();
  };

  const renderSlots = (preferredTime = null) => {
    const selected = availability?.resources?.find(
      ({ id }) => id === resourceSelect.value,
    );
    slotList.replaceChildren();
    const times = selected?.startTimes ?? [];
    if (times.length === 0) {
      slotList.append(createElement(
        "p",
        "empty-note",
        availability?.capacityReached
          ? "この日に受付できる予約数の上限に達したため、空き時間があっても新しい予約はお受けできません。"
          : "この条件で選べる時間はありません。",
      ));
      slotField.disabled = true;
      updateActions();
      return;
    }
    for (const time of times) {
      const label = createElement("label", "slot-option");
      const input = createElement("input");
      input.type = "radio";
      input.name = "startTime";
      input.value = time;
      input.required = true;
      input.checked = time === preferredTime;
      input.addEventListener("change", () => {
        saveDraft();
        updateActions();
      });
      label.append(input, createElement("span", "", time));
      slotList.append(label);
    }
    slotField.disabled = Boolean(pending);
    updateActions();
  };

  // Hides the resource select when the operator keeps assignment automatic.
  // The select stays in the DOM as the single source of the chosen resource.
  const applyResourceMode = () => {
    const exposed = resourceChoiceExposed();
    resourceRow.hidden = !exposed;
    $("[data-summary-edit='booking-resource']").hidden = !exposed;
    if (exposed) clearAssignedResource();
  };

  const clearAssignedResource = () => {
    assignedResource.hidden = true;
    assignedResource.textContent = "";
  };

  const applyAvailabilityNotice = () => {
    const notice = config?.availabilityNotice ?? null;
    availabilityNotice.textContent = notice ?? "";
    availabilityNotice.hidden = notice === null;
  };

  const resetAvailability = () => {
    availability = null;
    resourceSelect.replaceChildren(new Option("サービスと日付を選ぶと表示されます", ""));
    resourceSelect.disabled = true;
    slotList.replaceChildren(
      createElement("p", "empty-note", "サービス、日付、担当・設備を選んでください。"),
    );
    slotField.disabled = true;
    clearAssignedResource();
    updateActions();
  };

  const applyResourceSelection = (loaded, requestedResource) => {
    if (!resourceChoiceExposed()) {
      const assigned = pending
        ? loaded.resources.find(({ id }) => id === requestedResource) ?? null
        : pickAutoResource(loaded.resources, requestedResource);
      resourceSelect.value = assigned?.id ?? "";
      clearAssignedResource();
      if (assigned !== null) {
        assignedResource.textContent = `担当・設備は「${assigned.label}」を自動で割り当てました。`;
        assignedResource.hidden = false;
      }
    } else if (loaded.resources.some(({ id }) => id === requestedResource)) {
      resourceSelect.value = requestedResource;
    } else if (loaded.resources.length === 1 && !pending) {
      resourceSelect.value = loaded.resources[0].id;
    }
  };

  const finishAvailabilityLoad = (sequence) => {
    if (sequence === availabilitySequence) {
      root.removeAttribute("aria-busy");
      // A response landing while the details step is open must not leave the
      // card showing the previous selection's services or totals.
      if (journeyStep === "details") renderSummaryCard();
      else if (journeyStep === "review") renderReview();
    }
    setPendingMode();
  };

  const loadAvailability = async ({ quiet = false, preferredResource, preferredTime } = {}) => {
    const serviceIds = pending?.request.serviceIds ?? selectedServiceIds();
    const date = pending?.request.date ?? dateInput.value;
    if (!config || !date || serviceIds.length === 0) {
      resetAvailability();
      return;
    }
    const sequence = ++availabilitySequence;
    const previousResource = preferredResource ?? resourceSelect.value;
    const previousTime = preferredTime ?? selectedStartTime();
    root.setAttribute("aria-busy", "true");
    if (!quiet) setStatus(status, "空き時間を確認しています。");
    resourceSelect.disabled = true;
    slotField.disabled = true;
    try {
      const loaded = await api(scopedPath(availabilityPath(date, serviceIds), locationId));
      if (sequence !== availabilitySequence) return;
      availability = loaded;
      resourceSelect.replaceChildren(new Option("担当・設備を選んでください", ""));
      for (const resource of loaded.resources) {
        resourceSelect.append(new Option(resource.label, resource.id));
      }
      applyResourceSelection(loaded, pending?.request.resourceId ?? previousResource);
      resourceSelect.disabled = Boolean(pending);
      renderSlots(pending?.request.startTime ?? previousTime);
      availabilityHelp.textContent = `${loaded.occupiedMinutes}分の予約枠です。送信時にもう一度確認します。`;
      if (!quiet) setStatus(status, "空き時間を更新しました。", "success");
    } catch (error) {
      if (sequence !== availabilitySequence) return;
      availability = null;
      resetAvailability();
      if (!quiet) setStatus(status, error.message, "error");
    } finally {
      finishAvailabilityLoad(sequence);
    }
  };

  const compactServices = () => config.services.length > COMPACT_SERVICE_THRESHOLD;

  const applyServiceFilter = () => {
    const visible = new Set(
      filterServiceCatalog(config.services, serviceFilterInput.value).map(({ id }) => id),
    );
    $$("[data-service-option]", serviceList).forEach((option) => {
      option.hidden = !visible.has($("input", option).value);
    });
    serviceFilterCount.textContent =
      `${config.services.length}件中${visible.size}件を表示しています。`;
  };

  const renderServiceExtras = () => {
    const totals = summarizeServiceSelection(config.services, selectedServiceIds());
    serviceChips.replaceChildren(
      ...totals.selected.map(({ id, label }) => {
        const item = createElement("li");
        const button = createElement("button", "service-chip", label);
        button.type = "button";
        button.setAttribute("aria-label", `${label}を選択から外す`);
        button.append(createElement("span", "service-chip-remove", "×"));
        button.addEventListener("click", () => {
          const input = $(`input[name='serviceIds'][value='${id}']`, serviceList);
          if (!input) return;
          input.checked = false;
          input.dispatchEvent(new Event("change"));
          // The rebuild just destroyed the focused chip; keep keyboard users
          // on the surface instead of dropping them to the page top.
          focusWithoutScroll($("button", serviceChips) ?? serviceFilterInput);
        });
        item.append(button);
        return item;
      }),
    );
    serviceChips.hidden = totals.count === 0;
    serviceTotals.hidden = totals.count === 0;
    serviceTotals.textContent =
      totals.count === 0
        ? ""
        : `選択中 ${totals.count}件 / 目安 ${totals.durationMinutes}分 / ${formatPrice(totals.priceYen)}`;
  };

  // Past the threshold the same flat checkbox list stays in the DOM; the
  // compact surface only adds filtering (visibility) and chips on top of it.
  const applyCompactServices = () => {
    const active = compactServices();
    serviceFilter.hidden = !active;
    if (!active) {
      serviceChips.hidden = true;
      serviceTotals.hidden = true;
      return;
    }
    applyServiceFilter();
    renderServiceExtras();
  };

  const renderServices = (selected = []) => {
    serviceList.replaceChildren();
    for (const service of config.services) {
      serviceList.append(
        serviceOption(service, "serviceIds", selected.includes(service.id), (input) => {
          const checked = selectedServiceIds();
          if (checked.length > 4) {
            input.checked = false;
            input.closest("[data-service-option]").dataset.selected = "false";
            setStatus(status, "サービスは4件まで選べます。", "error");
            return;
          }
          serviceHelp.textContent = checked.length
            ? `${checked.length}件を選択中です。対応できる担当・設備と時間を更新します。`
            : "1〜4件まで選べます。組み合わせにより選べる担当・設備と時間が変わります。";
          if (compactServices()) renderServiceExtras();
          void loadAvailability();
          saveDraft();
        }),
      );
    }
    applyCompactServices();
  };

  const resumePendingSubmission = async () => {
    dateInput.value = pending.request.date;
    nameInput.value = pending.request.customerName;
    contactInput.value = pending.request.contact;
    consentInput.checked = true;
    await loadAvailability({
      quiet: true,
      preferredResource: pending.request.resourceId,
      preferredTime: pending.request.startTime,
    });
    setPendingMode();
    setStatus(status, "前回の送信結果が未確認です。同じ内容を再送して結果を確認できます。", "error");
    setStep("review", { history: "replace", focus: false });
  };

  const restoreSavedDraft = async (draft, selected, today, epoch) => {
    dateInput.value = draft.date ?? today;
    if (draft.serviceIds.length && draft.date) {
      await loadAvailability({
        quiet: true,
        preferredResource: draft.resourceId,
        preferredTime: draft.startTime,
      });
    }
    if (epoch !== locationEpoch) return;
    const slots = (availability?.resources ?? []).flatMap((resource) =>
      resource.startTimes.map((startTime) => ({
        resourceId: resource.id,
        date: dateInput.value,
        startTime,
      })),
    );
    const restored = restoreJourneyDraft(draft, {
      settingsVersion: config.settingsVersion,
      serviceIds: config.services.map(({ id }) => id),
      resourceIds: (availability?.resources ?? []).map(({ id }) => id),
      slots,
    });
    if (!restored) return;
    if (restored.serviceIds.join() !== selected.join()) renderServices(restored.serviceIds);
    dateInput.value = restored.date ?? today;
    if (availability) {
      // Under automatic assignment loadAvailability already picked the value.
      if (resourceChoiceExposed()) resourceSelect.value = restored.resourceId ?? "";
      renderSlots(restored.startTime);
    }
    setStep(restored.step, { history: "replace", focus: false });
    if (restored.step === "selection" && draft.step !== "selection") {
      setStatus(status, "保存した選択内容が変わっていたため、最初の手順から確認してください。", "error");
    }
  };

  const renderLocationChoice = () => {
    locationAnchor.replaceChildren();
    locationSelect = null;
    const bookable = locations.filter(({ bookable: enabled }) => enabled);
    if (bookable.length < 2 && locations.find(({ id }) => id === locationId)?.bookable !== false) return;
    const row = createElement("div", "field-row selection-field");
    const label = createElement("label", "", "場所を選ぶ");
    label.htmlFor = "booking-location";
    const select = createElement("select");
    select.id = "booking-location";
    select.dataset.locationSelect = "";
    if (!bookable.some(({ id }) => id === locationId)) {
      select.append(new Option("受付中の場所を選ぶ", ""));
    }
    for (const item of bookable) select.append(new Option(item.label, item.id));
    if (bookable.some(({ id }) => id === locationId)) select.value = locationId;
    else select.value = "";
    select.addEventListener("change", () => {
      if (select.value) void activateLocation(select.value, { history: "push" });
    });
    row.append(label, select);
    locationAnchor.append(row);
    locationSelect = select;
    setPendingMode();
  };

  const activateLocation = async (nextId, { history = "replace" } = {}) => {
    if (busy || pending) {
      if (locationSelect) locationSelect.value = locationId;
      if (history === false) {
        setPageLocation(locationId, locations.length > 1, "replaceState", { journeyStep, locationId });
      }
      setStatus(status, "未確認の予約結果を先に再確認してください。", "error");
      return;
    }
    const next = locations.find(({ id }) => id === nextId);
    if (!next) throw new Error("場所を確認できません。リンクを確認してください。");
    const epoch = ++locationEpoch;
    ++availabilitySequence;
    locationId = nextId;
    config = null;
    availability = null;
    duplicateAcknowledged = false;
    turnstileToken = "";
    if (window.turnstile && widgetId !== undefined) window.turnstile.reset(widgetId);
    nameInput.value = "";
    contactInput.value = "";
    consentInput.checked = false;
    serviceList.replaceChildren();
    resetAvailability();
    if (history) {
      setPageLocation(
        nextId,
        locations.length > 1,
        history === "push" ? "pushState" : "replaceState",
        { journeyStep: "selection", locationId: nextId },
      );
    }
    applyLocationLinks(nextId);
    renderLocationChoice();
    $("[data-summary-location-row]").hidden = locations.length === 1;
    $("[data-review-location-row]").hidden = locations.length === 1;
    $("[data-summary-edit='booking-location']").hidden = !locationSelect;
    setStatus(status, `${next.label}の受付内容を確認しています。`);
    try {
      const loaded = await api(scopedPath("/api/config", nextId));
      if (epoch !== locationEpoch) return;
      config = loaded;
      applyPublicConfig(config, nextId);
      applyResourceMode();
      applyAvailabilityNotice();
      modeNotice.hidden = config.mode === "live";
      const today = jstToday();
      dateInput.min = today;
      dateInput.max = addDays(today, config.schedule.horizonDays - 1);
      dateInput.value = today;
      pending = readPendingMutation(storageKey(PENDING_CREATE_KEY, nextId));
      const draft = pending ? null : readDraft(nextId);
      const selected = pending?.request.serviceIds ?? draft?.serviceIds ?? [];
      renderServices(selected);
      if (pending) await resumePendingSubmission();
      else if (draft) await restoreSavedDraft(draft, selected, today, epoch);
      else setStep("selection", { history: "replace", focus: false });
      if (epoch !== locationEpoch) return;
      setPendingMode();
      if (config.mode !== "live") {
        setStatus(status, "現在はデモ・設定中です。実在する方の情報は入力しないでください。", "error");
      } else if (!pending) {
        setStatus(status, "");
      }
    } catch (error) {
      if (epoch !== locationEpoch) return;
      setStatus(status, error.message, "error");
      form.querySelectorAll("input, select, button").forEach((control) => {
        control.disabled = true;
      });
      if (locationSelect) locationSelect.disabled = false;
    }
  };

  try {
    const explicit = explicitLocation(window.location.search);
    const defaultPending = explicit === null ? readPendingMutation() : null;
    locations = await readLocationDirectory();
    const selected = choosePublicLocation(locations, explicit, Boolean(defaultPending));
    if (selected === null) throw new Error("場所を確認できません。リンクを確認してください。");
    await activateLocation(selected, { history: explicit === null ? "replace" : false });
  } catch (error) {
    setStatus(status, error.message, "error");
    form.querySelectorAll("input, select, button").forEach((control) => {
      control.disabled = true;
    });
    return;
  }

  serviceFilterInput.addEventListener("input", () => {
    if (compactServices()) applyServiceFilter();
  });
  availabilityRefresh.addEventListener("click", () => {
    void loadAvailability();
  });
  dateInput.addEventListener("change", () => {
    // A different day means different remembered bookings to check against.
    duplicateAcknowledged = false;
    void loadAvailability();
    saveDraft();
  });
  resourceSelect.addEventListener("change", () => {
    renderSlots();
    saveDraft();
  });
  nameInput.addEventListener("input", updateActions);
  contactInput.addEventListener("input", updateActions);
  consentInput.addEventListener("change", updateActions);
  selectionNext.addEventListener("click", () => setStep("details"));
  detailsNext.addEventListener("click", () => setStep("review"));
  $$("[data-summary-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      setStep("selection", { focus: false });
      queueMicrotask(() => {
        const target = document.getElementById(button.dataset.summaryEdit);
        if (!target) return;
        // Prefer a service checkbox the active filter still shows; when the
        // query hides them all, fall back to any visible input (the filter
        // box itself), because focus() inside a hidden option is a no-op.
        focusWithoutScroll(
          target.matches("fieldset")
            ? (firstVisible(target, "input[name='serviceIds']") ??
              firstVisible(target, "input") ??
              target)
            : target,
        );
      });
    });
  });
  $$("[data-journey-back]").forEach((button) => {
    button.addEventListener("click", () => setStep(button.dataset.journeyBack));
  });
  window.addEventListener("popstate", (event) => {
    if (!result.hidden && resultLocationId) {
      setPageLocation(resultLocationId, locations.length > 1, "replaceState", {
        journeyStep,
        locationId: resultLocationId,
      });
      return;
    }
    let nextId;
    try {
      const explicit = explicitLocation(window.location.search);
      nextId = explicit ?? choosePublicLocation(locations, null, false);
    } catch (error) {
      setStatus(status, error.message, "error");
      return;
    }
    if (nextId !== locationId) {
      void activateLocation(nextId, { history: false }).then(() => {
        if (nextId === locationId) {
          setStep(event.state?.journeyStep ?? "selection", { history: false });
        }
      }).catch((error) => setStatus(status, error.message, "error"));
    } else {
      setStep(event.state?.journeyStep ?? "selection", { history: false });
    }
  });

  // True when the gesture is already answered and must not reach the network.
  const submitGuardBlocked = () => {
    if (pending && Date.now() - pending.retryAt >= DAY_MS) {
      clearPendingMutation(storageKey(PENDING_CREATE_KEY, locationId));
      pending = null;
      setPendingMode();
      setStep("selection", { history: "replace" });
      setStatus(status, "未確認の送信内容は24時間を過ぎたため削除しました。最新の空き時間から選び直してください。", "error");
      return true;
    }
    // A retry of a pending submission skips the pre-flight checks below.
    if (pending) return false;
    if (config.mode !== "live") {
      setStatus(status, "公開予約はまだ有効ではありません。設定完了後にお試しください。", "error");
      return true;
    }
    if (getJourneyStep({ requestedStep: "review", selection: selection(), details: details() }) !== "review") {
      setStep("review");
      return true;
    }
    if (!turnstileToken) {
      setStatus(status, "自動送信防止の確認を完了してください。", "error");
      return true;
    }
    return false;
  };

  // False when this gesture must stop here — left the review step, lost the
  // token, or opened the duplicate dialog whose close handler resubmits.
  const confirmNoDuplicate = async () => {
    busy = true;
    updateActions();
    const lookupDate = dateInput.value;
    const lookupLocationId = locationId;
    let acknowledgement = { needed: false, labels: [] };
    try {
      acknowledgement = await lookupDuplicateAcknowledgement(lookupDate, api, readOwnedRecords, locations);
    } finally {
      busy = false;
      updateActions();
    }
    // The lookup can outlast the review screen: if the visitor left it, or
    // came back through history with a different date, drop this gesture
    // instead of submitting or warning about values it never checked.
    if (journeyStep !== "review" || dateInput.value !== lookupDate || locationId !== lookupLocationId) return false;
    // The anti-bot token can expire while the lookup runs; a submission
    // without it is doomed server-side, so ask for the check again instead.
    if (!turnstileToken) {
      setStatus(status, "自動送信防止の確認を完了してください。", "error");
      return false;
    }
    if (acknowledgement.needed) {
      duplicateLocationSummary.hidden = locations.length === 1;
      duplicateLocationSummary.textContent = `保存されている場所: ${acknowledgement.labels.join("、")}`;
      // Esc closes without setting a value; clear the previous verdict so a
      // stale "confirm" cannot replay as an acknowledgement.
      duplicateDialog.returnValue = "";
      duplicateDialog.showModal();
      return false;
    }
    return true;
  };

  const handleSubmitError = async (error, retrying) => {
    if (
      [400, 404, 409, 413].includes(error.status)
      || (!retrying && [403, 429].includes(error.status))
    ) {
      clearPendingMutation(storageKey(PENDING_CREATE_KEY, locationId));
      pending = null;
    }
    if (error.code !== "UNAVAILABLE" && error.code !== "CONFIGURATION_CONFLICT") {
      setStatus(
        status,
        `${error.message}${pending ? " 同じ内容と管理キーで結果を再確認できます。" : ""}`,
        "error",
      );
      return;
    }
    if (error.code === "CONFIGURATION_CONFLICT") {
      try {
        const selected = selectedServiceIds();
        config = await api(scopedPath("/api/config", locationId));
        applyPublicConfig(config, locationId);
        applyResourceMode();
        applyAvailabilityNotice();
        modeNotice.hidden = config.mode === "live";
        dateInput.max = addDays(jstToday(), config.schedule.horizonDays - 1);
        renderServices(selected.filter((id) => config.services.some((service) => service.id === id)));
      } catch {
        setStatus(status, "最新の公開設定を読み込めませんでした。再読み込みしてお試しください。", "error");
        return;
      }
    }
    setStatus(status, "選んだ内容を現在受け付けられません。最新の空き時間から選び直してください。", "error");
    setStep("selection", { history: "replace" });
    await loadAvailability({ quiet: true });
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitGuardBlocked()) return;
    const retrying = Boolean(pending);
    if (!retrying && !duplicateAcknowledged && !(await confirmNoDuplicate())) return;
    busy = true;
    form.setAttribute("aria-busy", "true");
    updateActions();
    setStatus(status, pending ? "前回の送信結果を確認しています。" : "予約を申請しています。");
    try {
      if (!pending) {
        const currentSelection = selection();
        const currentDetails = details();
        const candidate = {
          commandId: crypto.randomUUID(),
          request: {
            settingsVersion: availability?.settingsVersion ?? config.settingsVersion,
            serviceIds: currentSelection.serviceIds,
            resourceId: currentSelection.resourceId,
            date: currentSelection.date,
            startTime: currentSelection.startTime,
            customerName: currentDetails.customerName,
            contact: currentDetails.contact,
            consentVersion: config.consentVersion,
            consent: true,
          },
          managementKey: newManagementKey(),
          retryAt: Date.now(),
        };
        writePendingMutation(candidate, storageKey(PENDING_CREATE_KEY, locationId));
        pending = candidate;
        setPendingMode();
      }
      const managementDigest = await digestHex(pending.managementKey);
      const response = await api(scopedPath("/api/reservations", locationId), {
        method: "POST",
        body: JSON.stringify({
          commandId: pending.commandId,
          settingsVersion: pending.request.settingsVersion,
          serviceIds: pending.request.serviceIds,
          resourceId: pending.request.resourceId,
          date: pending.request.date,
          startTime: pending.request.startTime,
          customerName: pending.request.customerName,
          contact: pending.request.contact,
          consentVersion: pending.request.consentVersion,
          managementDigest,
          turnstileToken: retrying ? "" : turnstileToken,
          replayOnly: retrying,
        }),
      });
      const reservation = response.reservation;
      resultRecord = {
        reservationId: reservation.reservationId,
        date: reservation.date,
        managementKey: pending.managementKey,
        savedAt: Date.now(),
      };
      resultLocationId = locationId;
      resultId.textContent = reservation.reservationId;
      resultKey.textContent = pending.managementKey;
      $("[data-result-location-row]").hidden = locations.length === 1;
      $("[data-result-location]").textContent = config.locationName;
      resultStatus.textContent = response.replayed
        ? "同じ申請の受付結果を確認しました。現在は運営者の確認待ちです。"
        : "申請を受け付けました。現在は運営者の確認待ちです。";
      clearPendingMutation(storageKey(PENDING_CREATE_KEY, locationId));
      clearDraft(locationId);
      pending = null;
      duplicateAcknowledged = false;
      remember.checked = false;
      form.hidden = true;
      result.hidden = false;
      setStatus(status, "予約の申請を受け付けました。", "success");
      focusWithoutScroll(result);
    } catch (error) {
      await handleSubmitError(error, retrying);
    } finally {
      busy = false;
      form.removeAttribute("aria-busy");
      turnstileToken = "";
      if (window.turnstile && widgetId !== undefined) window.turnstile.reset(widgetId);
      setPendingMode();
    }
  });

  duplicateDialog.addEventListener("close", () => {
    if (duplicateDialog.returnValue !== "confirm") return;
    duplicateAcknowledged = true;
    form.requestSubmit();
  });

  remember.addEventListener("change", () => {
    if (!resultRecord) return;
    try {
      const records = remember.checked
        ? saveOwnedBookingRecord(readOwnedRecords(resultLocationId), resultRecord, true)
        : removeOwnedBookingRecord(readOwnedRecords(resultLocationId), resultRecord.reservationId);
      writeOwnedRecords(records, resultLocationId);
      setStatus(
        keyStatus,
        remember.checked
          ? "このブラウザに予約を保存しました。"
          : "このブラウザへの保存を解除しました。",
        "success",
      );
    } catch {
      remember.checked = false;
      setStatus(keyStatus, "このブラウザには保存できませんでした。管理キーを控えてください。", "error");
    }
  });
  $("#copy-key").addEventListener("click", () => copyText(resultKey.textContent, keyStatus));
  $("#forget-key").addEventListener("click", () => {
    if (!resultRecord || !window.confirm("この端末から管理キーを削除します。元に戻せません。続けますか？")) return;
    try {
      writeOwnedRecords(
        removeOwnedBookingRecord(readOwnedRecords(resultLocationId), resultRecord.reservationId),
        resultLocationId,
      );
    } catch {
      setStatus(keyStatus, "保存情報を削除できませんでした。ブラウザの設定を確認してください。", "error");
      return;
    }
    resultRecord = null;
    resultKey.textContent = "この端末から削除しました";
    remember.checked = false;
    remember.disabled = true;
    setStatus(keyStatus, "この端末には管理キーを残していません。", "success");
  });
};

const startBookings = async () => {
  const pageStatus = $("[data-bookings-status]");
  const list = $("[data-bookings-list]");
  const empty = $("[data-bookings-empty]");
  const template = $("[data-booking-card-template]");
  const dialog = $("[data-booking-cancel-dialog]");
  const dialogForm = $("[data-booking-cancel-confirm]");
  const dialogSummary = $("[data-booking-cancel-summary]");
  const dialogStatus = $("[data-booking-cancel-status]");
  const pages = $("[data-booking-pages]");
  const previousPage = $("[data-booking-previous]");
  const nextPage = $("[data-booking-next]");
  const pageCount = $("[data-booking-page-count]");
  const cancelCommands = new Map();
  let locations;
  try {
    locations = await readLocationDirectory();
  } catch (error) {
    setStatus(pageStatus, error.message, "error");
    list.hidden = true;
    empty.hidden = true;
    return;
  }
  let selectedLocationId;
  try {
    const explicit = explicitLocation(window.location.search);
    selectedLocationId = choosePublicLocation(locations, explicit, false);
    if (selectedLocationId === null) throw new Error("場所を確認できません。リンクを確認してください。");
    if (explicit === null && (selectedLocationId !== "default" || locations.length > 1)) {
      setPageLocation(selectedLocationId, locations.length > 1);
    }
    applyLocationLinks(selectedLocationId);
  } catch (error) {
    setStatus(pageStatus, error.message, "error");
    list.hidden = true;
    empty.hidden = true;
    return;
  }
  let proofs = aggregateOwnedProofs(locations, readOwnedRecords);
  let currentPage = 0;
  let pageEpoch = 0;
  let cancelTarget = null;

  const persist = (proof, records) => {
    try {
      writeOwnedRecords(records, proof.locationId);
      return true;
    } catch {
      setStatus(pageStatus, "ブラウザの保存情報を更新できませんでした。", "error");
      return false;
    }
  };

  const updateEmpty = () => {
    const hasCards = list.children.length > 0;
    list.hidden = !hasCards;
    empty.hidden = hasCards;
  };

  const removeRecord = (proof) => {
    const records = removeOwnedBookingRecord(
      readOwnedRecords(proof.locationId),
      proof.record.reservationId,
    );
    if (!persist(proof, records)) return false;
    proofs = aggregateOwnedProofs(locations, readOwnedRecords);
    if (currentPage > 0 && currentPage * 16 >= proofs.length) currentPage -= 1;
    void renderPage().then(() => {
      setStatus(pageStatus, "この端末から保存情報を削除しました。", "success");
    });
    return true;
  };

  const openCancel = (proof, booking, card) => {
    cancelTarget = { proof, booking, card };
    const locationText = locations.length === 1 ? "" : `${proof.label}、`;
    dialogSummary.textContent = `${locationText}${formatDateTime(booking.date, booking.startTime)}、${booking.services.map(({ label }) => label).join("、")}の予約を取り消します。`;
    setStatus(dialogStatus, "");
    dialog.showModal();
  };

  // Set once the optional LINE module has loaded. Every card goes through it,
  // including the ones the cancel flow rebuilds, so the row survives a re-render.
  let enhanceLineCard = null;

  const renderCard = (proof, booking, replaceTarget = null) => {
    const { record, locationId, label } = proof;
    const fragment = template.content.cloneNode(true);
    const card = $("[data-booking-card]", fragment);
    card.dataset.reservationId = record.reservationId;
    card.dataset.locationId = locationId;
    card.dataset.bookingState = booking.status;
    $("[data-booking-location-row]", card).hidden = locations.length === 1;
    $("[data-booking-location]", card).textContent = label;
    $("[data-booking-reference]", card).textContent = booking.reservationId;
    $("[data-booking-services]", card).textContent = booking.services
      .map(({ label }) => label)
      .join("、");
    const badge = $("[data-booking-status]", card);
    badge.textContent = STATUS_LABELS[booking.status] ?? "状態を確認できません";
    if (Object.hasOwn(STATUS_LABELS, booking.status)) badge.classList.add(`badge-${booking.status}`);
    $("[data-booking-time]", card).textContent = formatDateTime(booking.date, booking.startTime);
    $("[data-booking-resource]", card).textContent = booking.resourceLabel;
    const statusLabel = STATUS_LABELS[booking.status] ?? "状態を確認できません";
    $("[data-booking-status-description]", card).textContent = bookingStatusDescription(
      booking,
      statusLabel,
    );
    $("[data-booking-allowed-actions]", card).textContent = booking.allowedActions.includes("cancel")
      ? "このページから取り消せます"
      : "現在利用できる操作はありません";
    const cancel = $("[data-booking-cancel]", card);
    cancel.hidden = !booking.allowedActions.includes("cancel");
    if (locations.length > 1) {
      cancel.setAttribute("aria-label", `${label}の予約 ${record.reservationId}を取り消す`);
      $("[data-booking-remove]", card).setAttribute(
        "aria-label", `${label}の予約 ${record.reservationId}をこの端末から削除`,
      );
    }
    cancel.addEventListener("click", () => openCancel(proof, booking, card));
    $("[data-booking-remove]", card).addEventListener("click", () => {
      if (!window.confirm("この端末から予約番号と管理キーを削除します。続けますか？")) return;
      removeRecord(proof);
    });
    if (replaceTarget) replaceTarget.replaceWith(fragment);
    else list.append(fragment);
    void enhanceLineCard?.(proof, card);
    return card;
  };

  try {
    applyPublicConfig(await api(scopedPath("/api/config", selectedLocationId)), selectedLocationId);
  } catch {
    // Each remembered proof is verified separately, even if public config is unavailable.
  }

  const renderProof = async (proof, epoch, replaceTarget = null) => {
    const { record, locationId, label } = proof;
    try {
      const booking = await api(
        scopedPath("/api/reservations/" + encodeURIComponent(record.reservationId) + "/status", locationId),
        {
          method: "POST",
          body: JSON.stringify({ date: record.date, managementKey: record.managementKey }),
        },
      );
      if (epoch !== pageEpoch) return;
      renderCard(proof, booking, replaceTarget);
    } catch (error) {
      if (epoch !== pageEpoch) return;
      const card = createElement("article", "booking-card");
      card.dataset.bookingCard = "";
      card.dataset.reservationId = record.reservationId;
      card.dataset.locationId = locationId;
      card.append(
        createElement("p", "section-label", locations.length === 1 ? "" : label),
        createElement("h2", "", "予約情報を確認できませんでした"),
        createElement("p", "status",
          error.status === 429
            ? "照会が集中しています。少し待ってから、この予約をもう一度確認してください。"
            : "予約情報または管理キーを確認できませんでした。もう一度確認するか、この端末から削除してください。"),
      );
      const retry = createElement("button", "secondary-button", "もう一度確認");
      retry.type = "button";
      if (locations.length > 1) {
        retry.setAttribute("aria-label", `${label}の予約 ${record.reservationId}をもう一度確認`);
      }
      retry.addEventListener("click", () => {
        retry.disabled = true;
        void renderProof(proof, pageEpoch, card);
      });
      if (error.status === 429 && error.retryAfter) {
        const seconds = Number(error.retryAfter);
        const at = Number.isFinite(seconds) ? Date.now() + seconds * 1_000 : Date.parse(error.retryAfter);
        const delay = at - Date.now();
        if (Number.isFinite(delay) && delay > 0) {
          retry.disabled = true;
          setTimeout(() => { if (retry.isConnected) retry.disabled = false; }, delay);
        }
      }
      const remove = createElement("button", "text-button", "この端末から削除");
      remove.type = "button";
      if (locations.length > 1) {
        remove.setAttribute("aria-label", `${label}の予約 ${record.reservationId}をこの端末から削除`);
      }
      remove.addEventListener("click", () => {
        if (!window.confirm("この端末から予約番号と管理キーを削除します。続けますか？")) return;
        removeRecord(proof);
      });
      const actions = createElement("div", "button-row");
      actions.append(retry, remove);
      card.append(actions);
      if (replaceTarget) replaceTarget.replaceWith(card);
      else list.append(card);
    }
  };

  const renderPage = async () => {
    const epoch = ++pageEpoch;
    const pageTotal = Math.max(1, Math.ceil(proofs.length / 16));
    currentPage = Math.min(currentPage, pageTotal - 1);
    pages.hidden = proofs.length <= 16;
    pageCount.textContent = currentPage + 1 + " / " + pageTotal + "ページ";
    previousPage.disabled = currentPage === 0;
    nextPage.disabled = currentPage + 1 >= pageTotal;
    list.replaceChildren();
    if (proofs.length === 0) {
      updateEmpty();
      setStatus(pageStatus, "このブラウザに保存した予約はありません。");
      return;
    }
    empty.hidden = true;
    list.hidden = false;
    setStatus(pageStatus, "保存した予約を確認しています。");
    for (const proof of proofs.slice(currentPage * 16, (currentPage + 1) * 16)) {
      if (epoch !== pageEpoch) return;
      await renderProof(proof, epoch);
    }
    if (epoch !== pageEpoch) return;
    setStatus(pageStatus, proofs.length + "件の保存情報を確認しました。", "success");
  };

  previousPage.addEventListener("click", () => {
    currentPage -= 1;
    void renderPage();
  });
  nextPage.addEventListener("click", () => {
    currentPage += 1;
    void renderPage();
  });
  await renderPage();

  dialogForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value !== "confirm") {
      dialog.close();
      return;
    }
    if (!cancelTarget) return;
    const { proof, booking, card } = cancelTarget;
    const { record, locationId } = proof;
    const key = locationId + ':' + record.reservationId;
    const button = $("[data-booking-cancel-confirm-button]", dialog);
    let command = cancelCommands.get(key);
    if (!command) {
      command = {
        commandId: crypto.randomUUID(),
        date: record.date,
        managementKey: record.managementKey,
      };
      cancelCommands.set(key, command);
    }
    button.disabled = true;
    setStatus(dialogStatus, "予約を取り消しています。");
    try {
      const response = await api(scopedPath(`/api/reservations/${encodeURIComponent(record.reservationId)}/cancel`, locationId), {
        method: "POST",
        body: JSON.stringify(command),
      });
      cancelCommands.delete(key);
      renderCard(proof, response.reservation, card);
      dialog.close();
      setStatus(
        pageStatus,
        `${formatDateTime(booking.date, booking.startTime)}の予約を取り消しました。保存情報は、この端末から削除するまで残ります。`,
        "success",
      );
      focusWithoutScroll(pageStatus);
    } catch (error) {
      if ([400, 404, 409, 413].includes(error.status)) cancelCommands.delete(key);
      setStatus(
        dialogStatus,
        `${error.message}${cancelCommands.has(key) ? " 同じ操作で結果を再確認できます。" : ""}`,
        "error",
      );
    } finally {
      button.disabled = false;
    }
  });
  dialog.addEventListener("close", () => {
    cancelTarget = null;
    setStatus(dialogStatus, "");
  });

  // A saved proof selects its own optional LINE capability, independent of the
  // booking page's current location. The module stays unloaded when none apply.
  const lineModes = new Map();
  for (const id of new Set(proofs.map(({ locationId }) => locationId))) {
    try {
      const config = await api(scopedPath("/api/config", id));
      if (typeof config.lineAdapter?.liffId === "string") lineModes.set(id, "capability");
      else if (config.lineAdapter?.cleanup === true) lineModes.set(id, "cleanup");
    } catch {
      // Proof status and cancellation remain usable without optional LINE.
    }
  }
  if (lineModes.size > 0) {
    const assetLocation = lineModes.keys().next().value;
    const modulePath = assetLocation === "default"
      ? "./line-link.mjs"
      : scopedPath("/line-link.mjs", assetLocation);
    import(modulePath).then((module) => {
      const renderers = new Map();
      for (const [id, mode] of lineModes) {
        renderers.set(id, module.enhanceBookingCards({
          locationId: id,
          mode,
          list,
          records: proofs.filter(({ locationId }) => locationId === id).map(({ record }) => record),
          api: (path, options) => api(scopedPath(path, id), options),
        }));
      }
      enhanceLineCard = (proof, card) => renderers.get(proof.locationId)?.(proof.record, card);
    }).catch(() => {
      // A failed optional module cannot block proof status or cancellation.
    });
  }
};

const startAdmin = async () => {
  const authForm = $("[data-owner-auth-form]");
  const authStatus = $("[data-owner-auth-status]");
  const tokenInput = $("#owner-token");
  const logoutButton = $("#logout-button");
  const locationAnchor = $("[data-operator-location-anchor]");
  const dateInput = $("[data-schedule-date]");
  const scheduleLive = $("[data-schedule-live]");
  const scheduleStatus = $("[data-schedule-status]");
  const reservationList = $("[data-reservation-list]");
  const closureList = $("[data-closure-list]");
  const weekList = $("[data-week-summary-list]");
  const attentionList = $("[data-attention-list]");
  const attentionCount = $("[data-attention-count]");
  const detail = $("[data-reservation-detail]");
  const detailStatus = $("[data-reservation-action-status]");
  const ownerCreateForm = $("[data-owner-create-form]");
  const ownerServiceList = $("[data-owner-service-list]");
  const ownerResource = $("#owner-resource");
  const ownerTime = $("#owner-time");
  const ownerName = $("#owner-customer-name");
  const ownerContact = $("#owner-contact");
  const ownerCreateButton = $("button[type='submit']", ownerCreateForm);
  const ownerCreateStatus = $("#owner-create-status");
  const ownerCreateResult = $("#owner-create-result");
  const ownerManagementKey = $("#owner-management-key");
  const closureForm = $("[data-closure-form]");
  const closureFields = $("#closure-fields");
  const closureDate = $("[data-closure-date]");
  const closureResource = $("[data-closure-resource]");
  const closureStart = $("[data-closure-start]");
  const closureEnd = $("[data-closure-end]");
  const closureLabel = $("[data-closure-label]");
  const closureSubmit = $("[data-closure-submit]");
  const closureStatus = $("[data-closure-status]");
  const statusFilter = createElement("select");
  let config;
  let ownerToken = "";
  let permittedLocations = [];
  let publicLocationCount = 1;
  let locationId = null;
  let locationSelect = null;
  let locationEpoch = 0;
  let scheduleSequence = 0;
  let schedule = null;
  let viewDays = 1;
  let selectedReservation = null;
  let ownerAvailability = null;
  let ownerAvailabilitySequence = 0;
  let ownerCreateInFlight = false;
  let ownerCreatePending = null;
  let closurePending = null;
  const commands = new Map();

  const filterField = createElement("div", "compact-field");
  const filterLabel = createElement("label", "", "状態で絞り込む");
  filterLabel.htmlFor = "schedule-status-filter";
  statusFilter.id = "schedule-status-filter";
  statusFilter.disabled = true;
  for (const [value, label] of [
    ["", "すべて"],
    ["pending", "確認待ち"],
    ["approved", "予約確定"],
    ["rejected", "受付見送り"],
    ["cancelled", "取消済み"],
    ["completed", "来店済み"],
    ["expired", "期限切れ"],
    ["no_show", "無断不来"],
  ]) statusFilter.append(new Option(label, value));
  filterField.append(filterLabel, statusFilter);
  $("[data-operator-toolbar]").insertBefore(filterField, scheduleLive);

  const ownerApi = createOwnerApi(() => ownerToken);
  const scopeSnapshot = () => ({ token: ownerToken, locationId, epoch: locationEpoch });
  const scopeCurrent = ({ token, locationId: id, epoch }) =>
    Boolean(token && id && token === ownerToken && id === locationId && epoch === locationEpoch);

  const selectedOwnerServiceIds = () =>
    $$("input[name='ownerServiceIds']:checked", ownerServiceList).map(({ value }) => value);

  const clearOwnerCreatePending = () => {
    clearPendingMutation(storageKey(OWNER_PENDING_CREATE_KEY, locationId ?? "default"));
    ownerCreatePending = null;
  };

  const clearScopeViews = () => {
    ++locationEpoch;
    ++scheduleSequence;
    ++ownerAvailabilitySequence;
    closurePending = null;
    commands.clear();
    selectedReservation = null;
    schedule = null;
    dateInput.disabled = true;
    statusFilter.disabled = true;
    $$("[data-schedule-view]").forEach((button) => {
      button.disabled = true;
    });
    closureFields.disabled = true;
    closureSubmit.disabled = true;
    detail.hidden = true;
    $("[data-reservation-detail-title]").textContent = "予約の詳細";
    for (const selector of ["[data-detail-status]", "[data-detail-time]", "[data-detail-services]", "[data-detail-customer]"]) {
      $(selector).textContent = "—";
    }
    reservationList.replaceChildren(createElement("p", "empty-note", "認証すると予約を表示します。"));
    closureList.replaceChildren(createElement("p", "empty-note", "認証すると休業時間を表示します。"));
    weekList.replaceChildren(createElement("p", "empty-note", "認証すると7日間の予定を表示します。"));
    attentionList.replaceChildren(createElement("p", "empty-note", "認証すると対応が必要な項目を表示します。"));
    attentionCount.textContent = "0件";
    ownerCreateForm.reset();
    ownerServiceList.replaceChildren(createElement("p", "empty-note", "認証するとサービスを表示します。"));
    ownerResource.replaceChildren(new Option("認証すると候補を表示します", ""));
    ownerTime.replaceChildren(new Option("認証すると時間を表示します", ""));
    closureResource.replaceChildren(new Option("認証すると対象を表示します", ""));
    ownerCreateResult.hidden = true;
    ownerManagementKey.textContent = "";
    ownerName.value = "";
    ownerContact.value = "";
    closureForm.reset();
    closureLabel.value = "";
    $("[data-day-board-summary]").textContent = "認証すると、この日の予定を読み込みます。";
    setStatus(scheduleLive, "");
    setStatus(scheduleStatus, "");
    setStatus(detailStatus, "");
    setStatus(closureStatus, "");
    setStatus(ownerCreateStatus, "");
  };

  const showLoggedOut = (message = "", clearOwnerCreate = false) => {
    if (clearOwnerCreate && locationId) clearOwnerCreatePending();
    ownerToken = "";
    ownerCreateInFlight = false;
    ownerCreatePending = null;
    locationId = null;
    permittedLocations = [];
    locationSelect = null;
    locationAnchor.replaceChildren();
    logoutButton.hidden = true;
    logoutButton.disabled = false;
    clearScopeViews();
    if (message) setStatus(authStatus, message, "error");
    updateOwnerCreateControls();
  };

  // The closing sentence every owner mutation failure appends. Only a conflict
  // is worth re-reading the schedule for, and the sentence may claim the
  // schedule was updated only when that read actually succeeded.
  // Answers null when the reload ended in a 401: the reload has already put the
  // logged-out screen up, and the failure line belongs to a screen that is gone.
  // `settled` is read after the reload, not before, because the controls that
  // start these mutations stay live through it and a second attempt made during
  // the reload is what decides whether the sentence is still true.
  const mutationFailureHint = async (error, { settled, retryHint, reload }) => {
    let refreshed = false;
    if (error.status === 409) {
      try {
        refreshed = (await reload()) === true;
      } catch (reloadError) {
        if (reloadError?.status === 401) return null;
      }
    }
    if (!settled()) return retryHint;
    return refreshed ? " 予定表を更新しました。" : "";
  };

  const handleOwnerError = (error) => {
    if (error.status === 401) {
      showLoggedOut("認証の有効性を確認できませんでした。もう一度認証してください。");
      return true;
    }
    return false;
  };

  const allowedAdminActions = (status) => {
    if (status === "pending") return ["approve", "reject", "cancel", "reschedule"];
    if (status === "approved") return ["cancel", "reschedule", "complete", "no_show"];
    return [];
  };

  const reservationSummary = (reservation) => {
    const services = reservation.services.map(({ label }) => label).join("、");
    const duration = reservation.serviceMinutes + reservation.cleanupMinutes;
    return `${services} / ${duration}分 / ${formatPrice(reservation.priceYen)}`;
  };

  const renderDetail = (reservation, focus = false) => {
    selectedReservation = reservation;
    detail.hidden = false;
    $("[data-reservation-detail-title]").textContent = `予約番号 ${reservation.reservationId}`;
    $("[data-detail-status]").textContent = reservation.expiresAt
      ? `${STATUS_LABELS[reservation.status] ?? reservation.status}（${formatDeadline(reservation.expiresAt)}で期限切れ）`
      : STATUS_LABELS[reservation.status] ?? reservation.status;
    $("[data-detail-time]").textContent = formatDateTime(reservation.date, reservation.startTime);
    $("[data-detail-services]").textContent = reservationSummary(reservation);
    $("[data-detail-customer]").textContent = `${reservation.customerName} / ${reservation.contact}`;
    const allowed = allowedAdminActions(reservation.status);
    const pendingAction = [...commands.keys()]
      .find((key) => key.startsWith(`reservation:${locationId}:${reservation.reservationId}:`))
      ?.split(":").at(-1);
    $$("[data-reservation-action]", detail).forEach((button) => {
      const action = button.dataset.reservationAction;
      button.disabled = !allowed.includes(action) || Boolean(pendingAction && action !== pendingAction);
    });
    setStatus(detailStatus, "");
    if (focus) focusWithoutScroll(detail);
  };

  const renderReservationList = (board) => {
    const snapshot = scopeSnapshot();
    reservationList.replaceChildren();
    const reservations = (board?.reservations ?? []).filter(
      ({ status }) => !statusFilter.value || status === statusFilter.value,
    );
    if (reservations.length === 0) {
      reservationList.append(createElement("p", "empty-note", statusFilter.value ? "この状態の予約はありません。" : "この日の予約はありません。"));
    }
    for (const reservation of reservations) {
      const article = createElement("article", "reservation-item");
      const heading = createElement("h3", "", `${reservation.startTime} / ${reservation.resourceLabel}`);
      const summary = createElement("p", "", reservationSummary(reservation));
      const customer = createElement("p", "", `${reservation.customerName} / ${reservation.contact}`);
      const badge = createElement("span", `badge badge-${reservation.status}`, STATUS_LABELS[reservation.status] ?? reservation.status);
      const open = createElement("button", "text-button", "詳細を開く");
      open.type = "button";
      open.addEventListener("click", () => {
        if (scopeCurrent(snapshot)) renderDetail(reservation, true);
      });
      article.append(heading, summary, customer, badge, open);
      reservationList.append(article);
    }
    $("[data-day-board-summary]").textContent = `${board?.date ?? dateInput.value} / 予約 ${reservations.length}件 / 休業 ${(board?.closures ?? []).filter(({ active }) => active).length}件`;
  };

  const refreshOwnerViews = async (focusReservationId = null) => {
    const snapshot = scopeSnapshot();
    try {
      const [refreshed] = await Promise.all([
        loadSchedule(focusReservationId), loadOwnerAvailability(),
      ]);
      return scopeCurrent(snapshot) && refreshed === true;
    } catch {
      return false;
    }
  };

  const removeClosure = async (closure, boardDate, button) => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot)) return;
    if (!window.confirm(`${closure.label}を予定表から解除しますか？`)) return;
    const key = `closure-remove:${snapshot.locationId}:${closure.closureId}`;
    let command = commands.get(key);
    if (!command) {
      command = { commandId: crypto.randomUUID(), date: boardDate };
      commands.set(key, command);
    }
    button.disabled = true;
    setStatus(closureStatus, "休業時間を解除しています。");
    try {
      await ownerApi(scopedPath(`/api/admin/closures/${encodeURIComponent(closure.closureId)}/remove`, snapshot.locationId), {
        method: "POST",
        body: JSON.stringify(command),
      });
      if (!scopeCurrent(snapshot)) return;
      commands.delete(key);
      const refreshed = await refreshOwnerViews();
      if (!scopeCurrent(snapshot)) return;
      setStatus(
        closureStatus,
        refreshed
          ? "休業時間を解除しました。"
          : "休業時間は解除しましたが、予定表を更新できませんでした。再読み込みしてください。",
        refreshed ? "success" : "error",
      );
      focusWithoutScroll(closureStatus);
    } catch (error) {
      if (!scopeCurrent(snapshot)) return;
      if (handleOwnerError(error)) return;
      if ([400, 404, 409, 413].includes(error.status)) commands.delete(key);
      const hint = await mutationFailureHint(error, {
        settled: () => !commands.has(key),
        retryHint: " 同じ操作で結果を再確認できます。",
        reload: loadSchedule,
      });
      if (hint === null || !scopeCurrent(snapshot)) return;
      setStatus(closureStatus, `${error.message}${hint}`, "error");
      focusWithoutScroll(closureStatus);
    } finally {
      if (scopeCurrent(snapshot)) button.disabled = false;
    }
  };

  const renderClosures = (board) => {
    const snapshot = scopeSnapshot();
    closureList.replaceChildren();
    const closures = (board?.closures ?? []).filter(({ active }) => active);
    if (closures.length === 0) {
      closureList.append(createElement("p", "empty-note", "この日の休業時間はありません。"));
      return;
    }
    for (const closure of closures) {
      const article = createElement("article", "closure-item");
      const heading = createElement("h3", "", closure.label);
      const resource = closure.resourceId
        ? config.resources.find(({ id }) => id === closure.resourceId)?.label ?? closure.resourceId
        : "全体";
      const summary = createElement("p", "", `${resource} / ${closure.startTime}〜${closure.endTime}`);
      const remove = createElement("button", "text-button", "解除する");
      remove.type = "button";
      remove.addEventListener("click", () => {
        if (scopeCurrent(snapshot)) void removeClosure(closure, board.date, remove);
      });
      article.append(heading, summary, remove);
      closureList.append(article);
    }
  };

  const renderAttention = () => {
    const snapshot = scopeSnapshot();
    attentionList.replaceChildren();
    const reservations = (schedule?.boards ?? []).flatMap(({ reservations }) => reservations);
    const pendingReservations = reservations.filter(({ status }) => status === "pending");
    for (const reservation of pendingReservations) {
      const article = createElement("article", "attention-item");
      article.append(
        createElement("h3", "", `${reservation.date} ${reservation.startTime}`),
        createElement("p", "", `${reservation.customerName} / ${reservationSummary(reservation)}`),
      );
      const open = createElement("button", "text-button", "申請を確認する");
      open.type = "button";
      open.addEventListener("click", async () => {
        if (!scopeCurrent(snapshot)) return;
        if (reservation.date !== dateInput.value || viewDays !== 1) {
          dateInput.value = reservation.date;
          viewDays = 1;
          await loadSchedule(reservation.reservationId);
        } else renderDetail(reservation, true);
      });
      article.append(open);
      attentionList.append(article);
    }
    const otherCount = Math.max(0, (schedule?.attentionCount ?? 0) - pendingReservations.length);
    if (otherCount) {
      const article = createElement("article", "attention-item");
      article.append(
        createElement("h3", "", "公開設定の確認"),
        createElement("p", "", `${otherCount}件の設定または日別バージョンを確認してください。`),
      );
      const link = createElement("a", "tertiary-link", "設定を確認する");
      link.href = navigationPath("/setup.html", locationId);
      article.append(link);
      attentionList.append(article);
    }
    if (!attentionList.children.length) {
      attentionList.append(createElement("p", "empty-note", "現在、確認待ちの項目はありません。"));
    }
    attentionCount.textContent = `${schedule?.attentionCount ?? 0}件`;
  };

  const renderWeek = () => {
    const snapshot = scopeSnapshot();
    weekList.replaceChildren();
    for (const board of schedule?.boards ?? []) {
      const item = createElement("button", "week-summary-item");
      item.type = "button";
      item.append(
        createElement("strong", "", board.date),
        createElement("span", "", `予約 ${board.reservations.length}件 / 休業 ${(board.closures ?? []).filter(({ active }) => active).length}件`),
      );
      item.addEventListener("click", async () => {
        if (!scopeCurrent(snapshot)) return;
        dateInput.value = board.date;
        viewDays = 1;
        await loadSchedule();
        if (scopeCurrent(snapshot)) focusWithoutScroll($("[data-schedule-board='day'] h2"));
      });
      weekList.append(item);
    }
    if (!weekList.children.length) weekList.append(createElement("p", "empty-note", "予定を確認できませんでした。"));
  };

  const updateView = () => {
    $$("[data-schedule-view]").forEach((button) => {
      const active = (button.dataset.scheduleView === "day") === (viewDays === 1);
      button.setAttribute("aria-pressed", String(active));
    });
    $("[data-schedule-board='day']").hidden = viewDays !== 1;
    $("[data-schedule-board='week']").hidden = viewDays !== 7;
  };

  // Answers whether it actually read. A caller that reports a refresh has to be
  // able to tell a read from the early return that happens with no token or date.
  const loadSchedule = async (focusReservationId = null, requestedDate = dateInput.value) => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || !requestedDate) return false;
    const sequence = ++scheduleSequence;
    const days = viewDays;
    setStatus(scheduleLive, days === 1 ? "1日の予定を読み込んでいます。" : "7日間の予定を読み込んでいます。");
    try {
      const loaded = await ownerApi(scopedPath(
        `/api/admin/schedule?startDate=${encodeURIComponent(requestedDate)}&days=${days}`,
        snapshot.locationId,
      ));
      if (!scopeCurrent(snapshot) || sequence !== scheduleSequence) return false;
      schedule = loaded;
      dateInput.value = requestedDate;
      updateView();
      renderAttention();
      renderWeek();
      const board = schedule.boards[0];
      renderReservationList(board);
      renderClosures(board);
      if (board?.opensAt && board?.closesAt) {
        closureStart.value = board.opensAt;
        closureEnd.value = board.closesAt;
      }
      const selectedId = focusReservationId ?? selectedReservation?.reservationId;
      const current = schedule.boards.flatMap(({ reservations }) => reservations)
        .find(({ reservationId }) => reservationId === selectedId);
      if (current) renderDetail(current, Boolean(focusReservationId));
      else if (selectedId) detail.hidden = true;
      setStatus(scheduleLive, `${schedule.startDate}から${schedule.days}日分を更新しました。`, "success");
      return true;
    } catch (error) {
      if (!scopeCurrent(snapshot) || sequence !== scheduleSequence) return false;
      if (handleOwnerError(error)) throw error;
      setStatus(scheduleLive, error.message, "error");
      throw error;
    }
  };

  const updateOwnerCreateControls = () => {
    const active = Boolean(ownerCreatePending);
    const authenticated = Boolean(ownerToken && locationId && config);
    dateInput.disabled = !authenticated || active;
    $$("input[name='ownerServiceIds']", ownerServiceList).forEach((input) => {
      input.disabled = !authenticated || active;
    });
    ownerResource.disabled = !authenticated || active || !ownerAvailability;
    ownerTime.disabled = !authenticated || active || ownerTime.options.length === 0;
    ownerName.disabled = !authenticated || active;
    ownerContact.disabled = !authenticated || active;
    ownerCreateButton.disabled = !authenticated || (!active && (
      config?.mode !== "live" ||
      selectedOwnerServiceIds().length === 0 || !ownerResource.value || !ownerTime.value
    ));
    ownerCreateButton.textContent = active ? "未確認の代理予約結果を再確認する" : "代理予約を登録する";
  };

  const renderOwnerTimes = (preferred = "") => {
    const resource = ownerAvailability?.resources?.find(({ id }) => id === ownerResource.value);
    ownerTime.replaceChildren(new Option("開始時間を選んでください", ""));
    for (const time of resource?.startTimes ?? []) ownerTime.append(new Option(time, time));
    if ([...ownerTime.options].some(({ value }) => value === preferred)) ownerTime.value = preferred;
    updateOwnerCreateControls();
  };

  const loadOwnerAvailability = async () => {
    const snapshot = scopeSnapshot();
    const serviceIds = ownerCreatePending?.request.serviceIds ?? selectedOwnerServiceIds();
    const date = ownerCreatePending?.request.date ?? dateInput.value;
    if (!scopeCurrent(snapshot) || !config || !date || serviceIds.length === 0) {
      ownerAvailability = null;
      ownerResource.replaceChildren(new Option("サービスを選んでください", ""));
      ownerTime.replaceChildren(new Option("開始時間を選んでください", ""));
      updateOwnerCreateControls();
      return;
    }
    const sequence = ++ownerAvailabilitySequence;
    const previousResource = ownerCreatePending?.request.resourceId ?? ownerResource.value;
    const previousTime = ownerCreatePending?.request.startTime ?? ownerTime.value;
    setStatus(ownerCreateStatus, "代理予約の空き時間を確認しています。");
    try {
      const loaded = await api(scopedPath(availabilityPath(date, serviceIds), snapshot.locationId));
      if (!scopeCurrent(snapshot) || sequence !== ownerAvailabilitySequence) return;
      ownerAvailability = loaded;
      ownerResource.replaceChildren(new Option("担当・設備を選んでください", ""));
      for (const resource of loaded.resources) ownerResource.append(new Option(resource.label, resource.id));
      if (loaded.resources.some(({ id }) => id === previousResource)) ownerResource.value = previousResource;
      else if (loaded.resources.length === 1) ownerResource.value = loaded.resources[0].id;
      renderOwnerTimes(previousTime);
      if (loaded.capacityReached) {
        // Distinguishes the exhausted acceptance budget from a genuinely full
        // day: the operator otherwise sees an empty dropdown over free chairs.
        setStatus(
          ownerCreateStatus,
          "この日に受付できる予約数の上限に達しているため、空き時間があっても新しい予約は登録できません。",
          "error",
        );
      } else {
        setStatus(ownerCreateStatus, "空き時間を更新しました。", "success");
      }
    } catch (error) {
      if (!scopeCurrent(snapshot) || sequence !== ownerAvailabilitySequence) return;
      ownerAvailability = null;
      setStatus(ownerCreateStatus, error.message, "error");
      updateOwnerCreateControls();
    }
  };

  const renderOwnerServices = () => {
    ownerServiceList.replaceChildren();
    for (const service of config.services) {
      ownerServiceList.append(
        serviceOption(service, "ownerServiceIds", false, (input) => {
          if (selectedOwnerServiceIds().length > 4) {
            input.checked = false;
            input.closest("[data-service-option]").dataset.selected = "false";
            setStatus(ownerCreateStatus, "サービスは4件まで選べます。", "error");
            return;
          }
          void loadOwnerAvailability();
        }),
      );
    }
    updateOwnerCreateControls();
  };

  const restoreOwnerCreatePending = () => {
    if (!ownerCreatePending) return;
    const { request } = ownerCreatePending;
    dateInput.value = request.date;
    ownerName.value = request.customerName;
    ownerContact.value = request.contact;
    $$('input[name="ownerServiceIds"]', ownerServiceList).forEach((input) => {
      input.checked = request.serviceIds.includes(input.value);
      input.closest("[data-service-option]").dataset.selected = String(input.checked);
    });
    const services = request.serviceIds
      .map((id) => config.services.find((service) => service.id === id)?.label ?? id)
      .join("、");
    const resource = config.resources.find(({ id }) => id === request.resourceId)?.label
      ?? request.resourceId;
    setStatus(
      ownerCreateStatus,
      `未確認の代理予約があります。${formatDateTime(request.date, request.startTime)} / ${services} / ${resource} / ${request.customerName} / ${request.contact}。表示内容を確認して受付結果を再確認してください。`,
      "error",
    );
    updateOwnerCreateControls();
  };

  const renderOperatorChoice = (manual = false) => {
    locationAnchor.replaceChildren();
    locationSelect = null;
    if (permittedLocations.length === 0) {
      locationAnchor.append(createElement("p", "empty-note", "担当できる場所がありません。"));
      return;
    }
    if (permittedLocations.length === 1 && permittedLocations[0].id === "default" && !manual) return;
    const row = createElement("div", "compact-field");
    if (permittedLocations.length === 1 && !manual) {
      const value = createElement("strong", "", permittedLocations[0].label);
      row.append(createElement("span", "helper", "表示中の場所"), value);
    } else {
      const label = createElement("label", "", "表示中の場所");
      label.htmlFor = "operator-location";
      const select = createElement("select");
      select.id = "operator-location";
      select.dataset.operatorLocation = "";
      if (manual) select.append(new Option("場所を選んでください", ""));
      for (const item of permittedLocations) select.append(new Option(item.label, item.id));
      if (locationId && permittedLocations.some(({ id }) => id === locationId)) select.value = locationId;
      else select.value = "";
      select.addEventListener("change", () => {
        if (select.value) void switchOperatorLocation(select.value, { history: "push" });
      });
      row.append(label, select);
      locationSelect = select;
    }
    locationAnchor.append(row);
  };

  const restoreOperatorUrl = () => {
    if (locationId) setPageLocation(locationId, publicLocationCount > 1, "replaceState", { locationId });
  };

  const switchOperatorLocation = async (nextId, { history = "replace", force = false } = {}) => {
    const target = permittedLocations.find(({ id }) => id === nextId);
    if (!target) {
      setStatus(authStatus, "この場所を表示できません。許可された場所を選んでください。", "error");
      return;
    }
    if (ownerCreateInFlight || ownerCreatePending || closurePending || commands.size > 0) {
      if (locationSelect) locationSelect.value = locationId ?? "";
      if (history === false) restoreOperatorUrl();
      setStatus(authStatus, "未確認の操作結果を先に再確認してください。", "error");
      return;
    }
    if (
      !force && locationId &&
      (ownerName.value.trim() || ownerContact.value.trim() || closureLabel.value.trim() ||
        selectedOwnerServiceIds().length > 0) &&
      !window.confirm("入力中の代理予約・休業時間を破棄して、場所を切り替えますか？")
    ) {
      if (locationSelect) locationSelect.value = locationId;
      if (history === false) restoreOperatorUrl();
      return;
    }
    clearScopeViews();
    locationId = nextId;
    config = null;
    ownerServiceList.replaceChildren(createElement("p", "empty-note", "場所の設定を確認しています。"));
    const stored = readPendingMutation(storageKey(OWNER_PENDING_CREATE_KEY, nextId));
    ownerCreatePending = stored?.operation === "owner-create" ? stored : null;
    if (stored && !ownerCreatePending) clearOwnerCreatePending();
    if (history) {
      setPageLocation(nextId, publicLocationCount > 1,
        history === "push" ? "pushState" : "replaceState", { locationId: nextId });
    }
    applyLocationLinks(nextId);
    renderOperatorChoice();
    const snapshot = scopeSnapshot();
    setStatus(authStatus, `${target.label}の予定を確認しています。`);
    try {
      const loaded = await api(scopedPath("/api/config", nextId));
      if (!scopeCurrent(snapshot)) return;
      config = loaded;
      applyPublicConfig(config, nextId);
      dateInput.value = ownerCreatePending?.request.date ?? jstToday();
      closureDate.value = dateInput.value;
      closureDate.min = jstToday();
      closureDate.max = addDays(jstToday(), config.schedule.horizonDays - 1);
      renderOwnerServices();
      closureResource.replaceChildren(
        new Option("全体または担当・設備を選択", ""),
        new Option("全体（受付時間すべて）", "__all__"),
      );
      for (const resource of config.resources) closureResource.append(new Option(resource.label, resource.id));
      closureStart.value = config.schedule.opensAt;
      closureEnd.value = config.schedule.closesAt;
      await loadSchedule();
      if (!scopeCurrent(snapshot)) return;
      logoutButton.hidden = false;
      statusFilter.disabled = false;
      $$("[data-schedule-view]").forEach((button) => { button.disabled = false; });
      closureFields.disabled = false;
      closureSubmit.disabled = false;
      restoreOwnerCreatePending();
      updateOwnerCreateControls();
      await loadOwnerAvailability();
      if (!scopeCurrent(snapshot)) return;
      restoreOwnerCreatePending();
      setStatus(authStatus, "認証しました。表示中の場所を確認してください。", "success");
    } catch (error) {
      if (!scopeCurrent(snapshot)) return;
      if (!handleOwnerError(error)) setStatus(authStatus, error.message, "error");
    }
  };

  const handleTransitionFailure = async (error, key, reservation, snapshot) => {
    if (!scopeCurrent(snapshot)) return;
    if (handleOwnerError(error)) return;
    if ([400, 404, 409, 413].includes(error.status)) commands.delete(key);
    const hint = await mutationFailureHint(error, {
      settled: () => !commands.has(key),
      retryHint: " 同じ操作で結果を再確認できます。",
      reload: () => loadSchedule(reservation.reservationId),
    });
    if (hint === null || !scopeCurrent(snapshot)) return;
    if (selectedReservation) renderDetail(selectedReservation, false);
    setStatus(detailStatus, `${error.message}${hint}`, "error");
    focusWithoutScroll(detail);
  };

  const transitionReservation = async (action) => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || !selectedReservation) return;
    const reservation = selectedReservation;
    const key = `reservation:${snapshot.locationId}:${reservation.reservationId}:${action}`;
    let command = commands.get(key);
    if (!command) {
      command = await collectTransitionCommand(
        action, reservation,
        (path, options) => ownerApi(scopedPath(path, snapshot.locationId), options),
        detailStatus, () => scopeCurrent(snapshot),
      );
      if (!scopeCurrent(snapshot) || command === null) return;
      commands.set(key, command);
    }

    $$("[data-reservation-action]", detail).forEach((button) => {
      button.disabled = true;
    });
    setStatus(detailStatus, `${ACTION_LABELS[action]}を処理しています。`);
    try {
      const response = await ownerApi(
        scopedPath(`/api/admin/reservations/${encodeURIComponent(reservation.reservationId)}/transition`, snapshot.locationId),
        { method: "POST", body: JSON.stringify(command) },
      );
      if (!scopeCurrent(snapshot)) return;
      commands.delete(key);
      const refreshed = await refreshOwnerViews(response.reservation?.reservationId);
      if (!scopeCurrent(snapshot)) return;
      setStatus(
        detailStatus,
        refreshed
          ? `${ACTION_LABELS[action]}を反映しました。`
          : `${ACTION_LABELS[action]}は反映しましたが、予定表を更新できませんでした。再読み込みしてください。`,
        refreshed ? "success" : "error",
      );
    } catch (error) {
      if (scopeCurrent(snapshot)) await handleTransitionFailure(error, key, reservation, snapshot);
    }
  };

  try {
    const initialId = explicitLocation(window.location.search) ?? "default";
    applyLocationLinks(initialId);
    config = await api(scopedPath("/api/config", initialId));
    applyPublicConfig(config, initialId);
    const today = jstToday();
    dateInput.value = today;
    closureDate.value = today;
    closureDate.min = today;
    closureDate.max = addDays(today, config.schedule.horizonDays - 1);
    showLoggedOut();
  } catch (error) {
    showLoggedOut();
    setStatus(authStatus, error.message, "error");
    dateInput.value = jstToday();
  }

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!authForm.reportValidity()) return;
    const nextToken = tokenInput.value;
    tokenInput.value = "";
    if (ownerCreateInFlight || ownerCreatePending || closurePending || commands.size > 0) {
      setStatus(authStatus, "未確認の操作結果を再確認してから認証し直してください。", "error");
      return;
    }
    if (ownerManagementKey.textContent &&
      !window.confirm("表示中の管理キーは再表示できません。控えてから認証し直しますか？")) return;
    ownerToken = "";
    clearScopeViews();
    locationId = null;
    permittedLocations = [];
    locationSelect = null;
    locationAnchor.replaceChildren();
    config = null;
    logoutButton.hidden = true;
    updateOwnerCreateControls();
    ownerToken = nextToken;
    const token = ownerToken;
    const authEpoch = locationEpoch;
    setStatus(authStatus, "認証しています。");
    try {
      const explicit = explicitLocation(window.location.search);
      const [directory, publicDirectory] = await Promise.all([
        ownerApi("/api/admin/locations"), readLocationDirectory(),
      ]);
      if (ownerToken !== token || locationEpoch !== authEpoch) return;
      if (!validLocationDirectory(directory.locations, false)) {
        throw new Error("担当できる場所を確認できませんでした。");
      }
      permittedLocations = directory.locations;
      publicLocationCount = publicDirectory.length;
      logoutButton.hidden = false;
      viewDays = 7;
      const selected = chooseOperatorLocation(permittedLocations, explicit);
      if (selected === null) {
        clearScopeViews();
        renderOperatorChoice(true);
        setStatus(
          authStatus,
          permittedLocations.length === 0
            ? "担当できる場所がありません。運営者に確認してください。"
            : "この場所を表示できません。許可された場所を選んでください。",
          "error",
        );
        return;
      }
      await switchOperatorLocation(selected, { history: explicit === null ? "replace" : false, force: true });
    } catch (error) {
      if (ownerToken === token && locationEpoch === authEpoch) showLoggedOut(error.message);
    }
  });

  window.addEventListener("popstate", () => {
    if (!ownerToken) return;
    if (ownerCreatePending || ownerCreateInFlight || closurePending || commands.size > 0) {
      restoreOperatorUrl();
      setStatus(authStatus, "未確認の操作結果を先に再確認してください。", "error");
      return;
    }
    let selected;
    try {
      selected = chooseOperatorLocation(
        permittedLocations,
        explicitLocation(window.location.search),
      );
    } catch {
      selected = null;
    }
    if (selected === null) {
      clearScopeViews();
      locationId = null;
      config = null;
      renderOperatorChoice(true);
      updateOwnerCreateControls();
      setStatus(authStatus, "この場所を表示できません。許可された場所を選んでください。", "error");
    } else if (selected !== locationId) {
      void switchOperatorLocation(selected, { history: false });
    }
  });

  logoutButton.addEventListener("click", () => {
    if (ownerCreateInFlight || ownerCreatePending || closurePending || commands.size > 0) {
      setStatus(authStatus, "未確認の操作結果を再確認してからログアウトしてください。", "error");
      return;
    }
    showLoggedOut("", true);
    setStatus(authStatus, "ログアウトしました。", "success");
  });
  dateInput.addEventListener("change", async () => {
    closureDate.value = dateInput.value;
    await Promise.all([loadSchedule().catch(() => {}), loadOwnerAvailability()]);
  });
  statusFilter.addEventListener("change", () => renderReservationList(schedule?.boards[0]));
  $$("[data-schedule-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      viewDays = button.dataset.scheduleView === "week" ? 7 : 1;
      await loadSchedule().catch(() => {});
    });
  });
  $$("[data-reservation-action]").forEach((button) => {
    button.addEventListener("click", () => void transitionReservation(button.dataset.reservationAction));
  });

  ownerResource.addEventListener("change", () => renderOwnerTimes());
  ownerName.addEventListener("input", updateOwnerCreateControls);
  ownerContact.addEventListener("input", updateOwnerCreateControls);
  const ownerCreateValidationError = () => {
    if (!ownerToken || !locationId) return "先に運営者認証と場所の選択を行ってください。";
    if (ownerCreatePending) return null;
    if (config?.mode !== "live") return "この場所では新しい予約を受け付けていません。";
    if (!ownerCreateForm.reportValidity() || selectedOwnerServiceIds().length === 0) {
      return "サービス、担当・設備、開始時間、お客様情報を確認してください。";
    }
    // Code points, not UTF-16 units: the limits the server enforces count
    // characters, so an emoji in a name must not read as two.
    const nameLength = [...ownerName.value.trim()].length;
    const contactLength = [...ownerContact.value.trim()].length;
    if (nameLength < 1 || nameLength > 80 || contactLength < 3 || contactLength > 200) {
      return "お名前は80文字以内、ご連絡先は3〜200文字で入力してください。";
    }
    return null;
  };

  const handleOwnerCreateError = async (error, snapshot) => {
    if (!scopeCurrent(snapshot)) return;
    if (handleOwnerError(error)) return;
    if ([400, 404, 409, 413].includes(error.status)) clearOwnerCreatePending();
    if (error.code === "CONFIGURATION_CONFLICT") {
      try {
        const loaded = await api(scopedPath("/api/config", snapshot.locationId));
        if (!scopeCurrent(snapshot)) return;
        config = loaded;
        applyPublicConfig(config, snapshot.locationId);
        renderOwnerServices();
      } catch {
        if (!scopeCurrent(snapshot)) return;
        setStatus(ownerCreateStatus, "最新の公開設定を読み込めませんでした。再読み込みしてお試しください。", "error");
        return;
      }
    }
    if (error.status === 409) await Promise.all([loadSchedule().catch(() => {}), loadOwnerAvailability()]);
    if (!scopeCurrent(snapshot)) return;
    setStatus(
      ownerCreateStatus,
      `${error.message}${ownerCreatePending ? " 同じ内容と管理キーで結果を再確認できます。" : ""}`,
      "error",
    );
  };

  ownerCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot)) return;
    const validationError = ownerCreateValidationError();
    if (validationError !== null) {
      setStatus(ownerCreateStatus, validationError, "error");
      return;
    }
    ownerCreateInFlight = true;
    logoutButton.disabled = true;
    ownerCreateButton.disabled = true;
    try {
      if (!ownerCreatePending) {
        const candidate = {
          operation: "owner-create",
          commandId: crypto.randomUUID(),
          request: {
            settingsVersion: ownerAvailability?.settingsVersion ?? config.settingsVersion,
            serviceIds: selectedOwnerServiceIds(),
            resourceId: ownerResource.value,
            date: dateInput.value,
            startTime: ownerTime.value,
            customerName: ownerName.value.trim(),
            contact: ownerContact.value.trim(),
            consentVersion: config.consentVersion,
          },
          managementKey: newManagementKey(),
          retryAt: Date.now(),
        };
        writePendingMutation(candidate, storageKey(OWNER_PENDING_CREATE_KEY, snapshot.locationId));
        ownerCreatePending = candidate;
        updateOwnerCreateControls();
      }
      setStatus(ownerCreateStatus, ownerCreatePending ? "代理予約の受付結果を確認しています。" : "代理予約を登録しています。");
      const managementDigest = await digestHex(ownerCreatePending.managementKey);
      if (!scopeCurrent(snapshot)) return;
      await ownerApi(scopedPath("/api/admin/reservations", snapshot.locationId), {
        method: "POST",
        body: JSON.stringify({
          commandId: ownerCreatePending.commandId,
          ...ownerCreatePending.request,
          managementDigest,
        }),
      });
      if (!scopeCurrent(snapshot)) return;
      ownerManagementKey.textContent = ownerCreatePending.managementKey;
      ownerCreateResult.hidden = false;
      clearOwnerCreatePending();
      ownerCreateForm.reset();
      ownerAvailability = null;
      const refreshed = await refreshOwnerViews();
      if (!scopeCurrent(snapshot)) return;
      setStatus(
        ownerCreateStatus,
        refreshed
          ? "代理予約を登録しました。管理キーをお客様へ安全にお渡しください。"
          : "代理予約は登録しました。管理キーを安全に渡し、予定表は再読み込みしてください。",
        refreshed ? "success" : "error",
      );
    } catch (error) {
      if (scopeCurrent(snapshot)) await handleOwnerCreateError(error, snapshot);
    } finally {
      if (scopeCurrent(snapshot)) {
        ownerCreateInFlight = false;
        logoutButton.disabled = false;
        updateOwnerCreateControls();
      }
    }
  });
  $("#owner-copy-key").addEventListener("click", () => copyText(ownerManagementKey.textContent, ownerCreateStatus));

  const setClosureFullDayHours = () => {
    const board = schedule?.boards?.[0];
    closureStart.value = board?.opensAt ?? config.schedule.opensAt;
    closureEnd.value = board?.closesAt ?? config.schedule.closesAt;
  };
  closureResource.addEventListener("change", () => {
    const wholeDay = closureResource.value === "__all__";
    if (wholeDay) setClosureFullDayHours();
    closureStart.disabled = wholeDay;
    closureEnd.disabled = wholeDay;
  });
  const handleClosureError = async (error, snapshot) => {
    if (!scopeCurrent(snapshot)) return;
    if (handleOwnerError(error)) return;
    if ([400, 404, 409, 413].includes(error.status)) closurePending = null;
    const hint = await mutationFailureHint(error, {
      settled: () => closurePending === null,
      retryHint: " 同じ内容で結果を再確認できます。",
      reload: loadSchedule,
    });
    if (hint === null || !scopeCurrent(snapshot)) return;
    setStatus(closureStatus, `${error.message}${hint}`, "error");
    focusWithoutScroll(closureStatus);
  };

  closureForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || (!closurePending && !closureForm.reportValidity())) return;
    if (
      !closurePending &&
      (Array.from(closureLabel.value.trim()).length < 1 ||
        Array.from(closureLabel.value.trim()).length > 80)
    ) {
      setStatus(closureStatus, "休業理由は1〜80文字で入力してください。", "error");
      return;
    }
    if (!closurePending) {
      closurePending = {
        commandId: crypto.randomUUID(),
        date: closureDate.value,
        resourceId: closureResource.value === "__all__" ? null : closureResource.value,
        startTime: closureStart.value,
        endTime: closureEnd.value,
        label: closureLabel.value.trim(),
      };
    }
    closureFields.disabled = true;
    closureSubmit.disabled = false;
    closureSubmit.textContent = "未確認の登録結果を再確認する";
    setStatus(closureStatus, "休業時間を登録しています。");
    try {
      await ownerApi(scopedPath("/api/admin/closures", snapshot.locationId), {
        method: "POST",
        body: JSON.stringify(closurePending),
      });
      if (!scopeCurrent(snapshot)) return;
      closurePending = null;
      closureForm.reset();
      closureDate.value = dateInput.value;
      setClosureFullDayHours();
      const refreshed = await refreshOwnerViews();
      if (!scopeCurrent(snapshot)) return;
      setStatus(
        closureStatus,
        refreshed
          ? "休業時間を登録しました。"
          : "休業時間は登録しましたが、予定表を更新できませんでした。再読み込みしてください。",
        refreshed ? "success" : "error",
      );
    } catch (error) {
      if (scopeCurrent(snapshot)) await handleClosureError(error, snapshot);
    } finally {
      if (scopeCurrent(snapshot)) {
        closureFields.disabled = Boolean(closurePending);
        closureSubmit.disabled = false;
        closureSubmit.textContent = closurePending ? "未確認の登録結果を再確認する" : "休業時間を登録する";
      }
    }
  });
  tokenInput.disabled = false;
  authForm.querySelector('button[type="submit"]').disabled = false;
};

const startSetup = async () => {
  const authForm = $("[data-setup-auth-form]");
  const tokenInput = $("#setup-owner-token");
  const authStatus = $("[data-setup-auth-status]");
  const logoutButton = $("#setup-logout");
  const form = $("[data-setup-form]");
  const fields = $("#setup-fields");
  const saveButton = $("[data-setup-save]");
  const liveButton = $("[data-setup-enable-live]");
  const setupStatus = $("[data-setup-status]");
  const setupHelp = $("[data-setup-help]");
  const modeNotice = $("[data-setup-mode-notice]");
  const locationPanel = $("[data-setup-locations-panel]");
  const locationList = $("[data-setup-location-list]");
  const locationCount = $("[data-setup-location-count]");
  const locationForm = $("[data-location-create-form]");
  const locationFields = $("[data-location-create-fields]");
  const newLocationId = $("[data-new-location-id]");
  const newLocationName = $("[data-new-location-name]");
  const locationCreateSubmit = $("[data-location-create-submit]");
  const locationStatus = $("[data-location-status]");
  const servicesRoot = $("[data-setup-services]");
  const resourcesRoot = $("[data-setup-resources]");
  const weekdayInputs = $$('input[name="openWeekdays"]', form);
  const readinessSummary = $("[data-readiness-summary]");
  const receiptRoot = $("[data-installation-receipt]");
  const receiptEmpty = $("[data-installation-receipt-empty]");
  const receiptCopy = $("[data-receipt-copy]");
  const receiptStatus = $("[data-receipt-status]");
  const receiptGuidance = $("[data-receipt-guidance]");
  const receiptGuidanceEmpty = $("[data-receipt-guidance-empty]");
  const staffList = $("[data-staff-list]");
  const staffCount = $("[data-staff-count]");
  const staffForm = $("[data-staff-form]");
  const staffFields = $("#staff-fields");
  const staffSubmit = $("[data-staff-submit]");
  const staffDisplayName = $("[data-staff-display-name]");
  const staffRole = $("[data-staff-role]");
  const staffCredential = $("[data-staff-credential]");
  const staffCredentialValue = $("[data-staff-credential-value]");
  const staffStatus = $("[data-staff-status]");
  const staffCreateScope = $("[data-staff-create-scope]");
  const staffCreateScopeOptions = $("[data-staff-create-scope-options]");
  const calendarPanel = $("[data-calendar-panel]");
  const calendarVersion = $("[data-calendar-version]");
  const calendarForm = $("[data-calendar-settings-form]");
  const calendarFields = $("[data-calendar-settings-fields]");
  const calendarIdInput = $("[data-calendar-target-id]");
  const calendarGoogle = $("[data-calendar-google-enabled]");
  const calendarFeed = $("[data-calendar-feed-enabled]");
  const calendarIssue = $("[data-calendar-issue]");
  const calendarTokenBox = $("[data-calendar-token-box]");
  const calendarToken = $("[data-calendar-token]");
  const calendarStatus = $("[data-calendar-status]");
  const receiptDownload = createElement("button", "secondary-button", "JSONをダウンロード");
  let ownerToken = "";
  let locations = [];
  let locationId = "default";
  let locationEpoch = 0;
  let pendingLocationCreate = null;
  let settingsDirty = false;
  let staffScopes = new Map();
  let staffBusy = false;
  let staffWritePending = false;
  let calendarSettings = null;
  let calendarBusy = false;
  let setupState = null;
  let editingSettings = null;
  let receipt = null;
  let pendingUpdate = null;
  let pendingLive = null;
  let editorId = 0;

  receiptDownload.type = "button";
  receiptDownload.disabled = true;
  receiptCopy.after(receiptDownload);

  const ownerApi = createOwnerApi(() => ownerToken);
  const scopeSnapshot = () => ({ token: ownerToken, locationId, epoch: locationEpoch });
  const scopeCurrent = ({ token, locationId: id, epoch }) =>
    Boolean(token && id && id === locationId && token === ownerToken && epoch === locationEpoch);

  const labeledControl = (labelText, control) => {
    const row = createElement("div", "field-row");
    const label = createElement("label", "", labelText);
    control.id = `setup-editor-${++editorId}`;
    label.htmlFor = control.id;
    row.append(label, control);
    return row;
  };

  const textInput = (value, { maxLength, required = true, pattern = "" } = {}) => {
    const input = createElement("input");
    input.value = value ?? "";
    input.required = required;
    if (maxLength) input.maxLength = maxLength;
    if (pattern) input.pattern = pattern;
    return input;
  };

  const numberInput = (value, min, max, nullable = false) => {
    const input = createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.required = !nullable;
    input.value = value ?? "";
    return input;
  };

  const activeSelect = (active) => {
    const select = createElement("select");
    select.append(new Option("有効", "true"), new Option("停止", "false"));
    select.value = String(active);
    return select;
  };

  const renderServiceEditors = () => {
    servicesRoot.replaceChildren();
    editingSettings.services.forEach((service, index) => {
      const panel = createElement("section", "editor-panel");
      panel.append(createElement("h3", "", `サービス ${index + 1}`));
      const grid = createElement("div", "field-grid");
      const id = textInput(service.id, {
        maxLength: 64,
        pattern: String.raw`[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}`,
      });
      const label = textInput(service.label, { maxLength: 160 });
      const category = textInput(service.category ?? "", { maxLength: 120, required: false });
      const duration = numberInput(service.durationMinutes, 15, 480);
      const cleanup = numberInput(service.cleanupMinutes, 0, 120);
      const price = numberInput(service.priceYen, 0, 10_000_000, true);
      const active = activeSelect(service.active);
      const eligible = createElement("select");
      eligible.multiple = true;
      eligible.required = true;
      eligible.size = Math.min(5, Math.max(2, editingSettings.resources.length));
      for (const resource of editingSettings.resources) {
        const option = new Option(resource.label, resource.id);
        option.selected = service.eligibleResourceIds.includes(resource.id);
        eligible.append(option);
      }
      id.addEventListener("change", () => {
        service.id = id.value.trim();
      });
      label.addEventListener("input", () => {
        service.label = label.value;
      });
      category.addEventListener("input", () => {
        service.category = category.value || null;
      });
      duration.addEventListener("input", () => {
        service.durationMinutes = Number(duration.value);
      });
      cleanup.addEventListener("input", () => {
        service.cleanupMinutes = Number(cleanup.value);
      });
      price.addEventListener("input", () => {
        service.priceYen = price.value === "" ? null : Number(price.value);
      });
      active.addEventListener("change", () => {
        service.active = active.value === "true";
      });
      eligible.addEventListener("change", () => {
        service.eligibleResourceIds = [...eligible.selectedOptions].map(({ value }) => value);
      });
      grid.append(
        labeledControl("識別子", id),
        labeledControl("表示名", label),
        labeledControl("分類（任意）", category),
        labeledControl("提供時間（分）", duration),
        labeledControl("準備時間（分）", cleanup),
        labeledControl("表示料金（円・任意）", price),
        labeledControl("公開状態", active),
        labeledControl("対応できる担当・設備（複数選択可）", eligible),
      );
      panel.append(grid);
      if (editingSettings.services.length > 1) {
        const remove = createElement("button", "text-button", "このサービスを削除");
        remove.type = "button";
        remove.addEventListener("click", () => {
          settingsDirty = true;
          editingSettings.services.splice(index, 1);
          renderServiceEditors();
        });
        panel.append(remove);
      }
      servicesRoot.append(panel);
    });
  };

  const renderResourceEditors = () => {
    resourcesRoot.replaceChildren();
    editingSettings.resources.forEach((resource, index) => {
      const panel = createElement("section", "editor-panel");
      panel.append(createElement("h3", "", `担当・設備 ${index + 1}`));
      const grid = createElement("div", "field-grid");
      const id = textInput(resource.id, {
        maxLength: 64,
        pattern: String.raw`[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}`,
      });
      const label = textInput(resource.label, { maxLength: 160 });
      const active = activeSelect(resource.active);
      id.addEventListener("change", () => {
        const previous = resource.id;
        resource.id = id.value.trim();
        for (const service of editingSettings.services) {
          service.eligibleResourceIds = service.eligibleResourceIds.map((value) =>
            value === previous ? resource.id : value,
          );
        }
        renderServiceEditors();
      });
      label.addEventListener("input", () => {
        resource.label = label.value;
      });
      active.addEventListener("change", () => {
        resource.active = active.value === "true";
      });
      grid.append(
        labeledControl("識別子", id),
        labeledControl("表示名", label),
        labeledControl("公開状態", active),
      );
      panel.append(grid);
      if (editingSettings.resources.length > 1) {
        const remove = createElement("button", "text-button", "この担当・設備を削除");
        remove.type = "button";
        remove.addEventListener("click", () => {
          settingsDirty = true;
          const removedId = resource.id;
          editingSettings.resources.splice(index, 1);
          for (const service of editingSettings.services) {
            service.eligibleResourceIds = service.eligibleResourceIds.filter((idValue) => idValue !== removedId);
            if (!service.eligibleResourceIds.length && editingSettings.resources[0]) {
              service.eligibleResourceIds = [editingSettings.resources[0].id];
            }
          }
          renderResourceEditors();
          renderServiceEditors();
        });
        panel.append(remove);
      }
      resourcesRoot.append(panel);
    });
  };

  const uniqueId = (prefix, values) => {
    let number = values.length + 1;
    while (values.some(({ id }) => id === `${prefix}-${number}`)) number += 1;
    return `${prefix}-${number}`;
  };

  const setSetupStep = (step) => {
    $$("[data-setup-progress-step]").forEach((item) => {
      if (item.dataset.setupProgressStep === step) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
    $("[data-setup-live]").textContent = {
      identity: "手順1、運営情報と公開文書を確認します。",
      schedule: "手順2、サービス、担当・設備、受付時間を確認します。",
      protection: "手順3、自動送信防止とホスト名を確認します。",
      review: "手順4、準備状況を確認します。",
    }[step] ?? "";
    if (!locationId) return;
    try {
      localStorage.setItem(storageKey(SETUP_STEP_KEY, locationId), step);
    } catch {
      // This stores only a step name; server-saved settings remain resumable without it.
    }
  };

  const updateReadiness = (readiness = {}) => {
    const keys = ["owner", "protection", "identity", "capacity"];
    const completed = keys.filter((key) => readiness[key] === true).length;
    readinessSummary.textContent = `${completed} / 4`;
    for (const key of keys) {
      const ready = readiness[key] === true;
      const state = $(`[data-readiness-state='${key}']`);
      state.textContent = ready ? "完了" : "要確認";
      state.dataset.state = ready ? "ready" : "blocked";
    }
  };

  const updateSetupControls = () => {
    const authenticated = Boolean(ownerToken && locationId && setupState);
    const pending = Boolean(pendingUpdate || pendingLive);
    const accepting = setupState?.mode === "live" && setupState?.readiness?.ready === true;
    fields.disabled = !authenticated || pending;
    saveButton.disabled = !authenticated || pendingLive;
    const canSwitchLive = setupState?.mode === "live" || setupState?.readiness?.ready === true;
    liveButton.disabled = !authenticated || Boolean(pendingUpdate) || !canSwitchLive;
    saveButton.textContent = pendingUpdate ? "未確認の保存結果を再確認する" : "設定を保存する";
    liveButton.textContent = liveButtonLabel(pendingLive, setupState?.mode);
    setupHelp.textContent = setupHelpText(authenticated, pending, accepting, setupState);
  };

  // The notice a visitor would see is the one that stays true after signing out,
  // so a session that ends mid-save restores it rather than leaving the
  // authenticated banner addressed to someone who is now logged out. It follows
  // whether the installation is accepting, because that is what a visitor can
  // tell: a live installation that is not ready is served the demo notice, and
  // the repair instruction the operator sees is not addressed to a visitor.
  // Takes whether the installation is accepting, not the mode alone: a live
  // installation whose readiness is incomplete is not accepting, and telling a
  // visitor otherwise is the one thing this notice must never do.
  const loggedOutNoticeFor = (accepting) =>
    accepting
      ? "現在は公開予約を受け付けています。運営者として認証すると設定を確認できます。"
      : setupModeNoticeText(false, "demo");
  // The served page carries the demo notice as its own text, which is the right
  // thing to keep showing when the config read that would replace it fails. It
  // seeds the value so signing out never blanks the banner.
  let loggedOutNotice = modeNotice.textContent.trim();

  const renderSetupState = (state) => {
    setupState = state;
    editingSettings = structuredClone(state.settings);
    settingsDirty = false;
    applyPublicConfig({ ...state.settings, mode: state.mode }, locationId);
    $("[data-setup-location-name]").value = state.settings.locationName;
    $("[data-setup-operator-name]").value = state.settings.operatorDisplayName;
    $("[data-setup-operator-contact]").value = state.settings.operatorContact;
    $("[data-setup-source-url]").value = state.settings.sourceUrl;
    $("[data-setup-privacy-notice]").value = state.settings.privacyNotice;
    $("[data-setup-terms-notice]").value = state.settings.termsNotice;
    $("[data-setup-cancellation-policy]").value = state.settings.cancellationPolicy;
    $("[data-setup-consent-version]").value = state.settings.consentVersion;
    $("[data-setup-opens-at]").value = state.settings.opensAt;
    $("[data-setup-closes-at]").value = state.settings.closesAt;
    $("[data-setup-interval]").value = state.settings.startIntervalMinutes;
    $("[data-setup-horizon]").value = state.settings.horizonDays;
    $("[data-setup-retention]").value = state.settings.retentionDays;
    // The setup projection resolves the effective value, so this is only a
    // guard against an older server that does not send it at all.
    $("[data-setup-pending-expiry]").value = state.settings.pendingExpiryMinutes ?? 1440;
    $("[data-setup-availability-notice]").value = state.settings.availabilityNotice ?? "";
    $("[data-setup-expose-resource-choice]").checked = state.settings.exposeResourceChoice ?? true;
    for (const input of weekdayInputs) {
      input.checked = state.settings.openWeekdays.includes(Number(input.value));
    }
    $("[data-setup-theme]").value = state.settings.themeId;
    $("[data-setup-turnstile-site-key]").value = state.settings.turnstileSiteKey;
    $("[data-setup-allowed-hostname]").value = state.settings.allowedHostname;
    renderResourceEditors();
    renderServiceEditors();
    updateReadiness(state.readiness);
    const accepting = state.mode === "live" && state.readiness.ready;
    loggedOutNotice = loggedOutNoticeFor(accepting);
    modeNotice.textContent = setupModeNoticeText(accepting, state.mode);
    modeNotice.dataset.tone = accepting ? "success" : "";
    updateSetupControls();
  };

  const completeSettings = () => ({
    locationName: $("[data-setup-location-name]").value.trim(),
    timeZone: editingSettings.timeZone,
    services: editingSettings.services.map((service) => ({
      id: service.id.trim(),
      label: service.label.trim(),
      category: service.category?.trim() || null,
      durationMinutes: Number(service.durationMinutes),
      cleanupMinutes: Number(service.cleanupMinutes),
      priceYen: service.priceYen === null ? null : Number(service.priceYen),
      eligibleResourceIds: [...service.eligibleResourceIds],
      active: service.active,
    })),
    resources: editingSettings.resources.map((resource) => ({
      id: resource.id.trim(),
      label: resource.label.trim(),
      active: resource.active,
    })),
    opensAt: $("[data-setup-opens-at]").value,
    closesAt: $("[data-setup-closes-at]").value,
    startIntervalMinutes: Number($("[data-setup-interval]").value),
    openWeekdays: weekdayInputs.filter(({ checked }) => checked).map(({ value }) => Number(value)),
    horizonDays: Number($("[data-setup-horizon]").value),
    retentionDays: Number($("[data-setup-retention]").value),
    pendingExpiryMinutes: Number($("[data-setup-pending-expiry]").value),
    // An empty notice omits the key entirely: absence is the stored form of
    // "no notice", and the server refuses an empty string.
    ...($("[data-setup-availability-notice]").value.trim() === ""
      ? {}
      : { availabilityNotice: $("[data-setup-availability-notice]").value.trim() }),
    exposeResourceChoice: $("[data-setup-expose-resource-choice]").checked,
    consentVersion: $("[data-setup-consent-version]").value.trim(),
    operatorDisplayName: $("[data-setup-operator-name]").value.trim(),
    operatorContact: $("[data-setup-operator-contact]").value.trim(),
    privacyNotice: $("[data-setup-privacy-notice]").value.trim(),
    termsNotice: $("[data-setup-terms-notice]").value.trim(),
    cancellationPolicy: $("[data-setup-cancellation-policy]").value.trim(),
    sourceUrl: $("[data-setup-source-url]").value.trim(),
    turnstileSiteKey: $("[data-setup-turnstile-site-key]").value.trim(),
    allowedHostname: $("[data-setup-allowed-hostname]").value.trim(),
    themeId: $("[data-setup-theme]").value,
  });

  const renderReceipt = (value) => {
    receipt = value;
    receiptEmpty.hidden = true;
    receiptRoot.hidden = false;
    $("[data-receipt-version]").textContent = value.applicationVersion;
    $("[data-receipt-settings-version]").textContent = String(value.settingsVersion);
    $("[data-receipt-settings-effective]").textContent = new Date(value.settingsEffectiveAt).toLocaleString("ja-JP");
    $("[data-receipt-day-policy]").textContent = value.dayPartitionPolicy === "pinned_until_purge"
      ? "未固定の日付から適用。既存の日付は保存期限まで固定"
      : value.dayPartitionPolicy;
    $("[data-receipt-consent-policy]").textContent = value.consentPolicy === "current_at_acceptance"
      ? "予約受付時点の現行文書版"
      : value.consentPolicy;
    $("[data-receipt-digest]").textContent = value.settingsDigest;
    $("[data-receipt-mode]").textContent = value.mode === "live" ? "公開予約を受付中" : "デモ・設定中";
    $("[data-receipt-resources]").textContent = value.resourceKinds.join("、");
    $("[data-receipt-created-at]").textContent = new Date(value.createdAt).toLocaleString("ja-JP");
    for (const key of ["rollback", "recovery", "export", "deletion"]) {
      const link = $(`[data-receipt-guidance-link='${key}']`);
      const href = value.guidance?.[key];
      if (typeof href === "string") {
        link.href = href.startsWith("/") && !href.startsWith("//")
          ? navigationPath(href, locationId)
          : href;
      }
    }
    receiptGuidance.hidden = false;
    receiptGuidanceEmpty.hidden = true;
    receiptCopy.disabled = false;
    receiptDownload.disabled = false;
  };

  const clearReceipt = () => {
    receipt = null;
    receiptRoot.hidden = true;
    receiptEmpty.hidden = false;
    receiptGuidance.hidden = true;
    receiptGuidanceEmpty.hidden = false;
    receiptCopy.disabled = true;
    receiptDownload.disabled = true;
    setStatus(receiptStatus, "");
  };

  const loadReceipt = async () => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot)) return false;
    try {
      const value = await ownerApi(scopedPath("/api/admin/installation-receipt", snapshot.locationId));
      if (!scopeCurrent(snapshot)) return false;
      renderReceipt(value);
      setStatus(receiptStatus, "秘密情報を含まない設置受領書を更新しました。", "success");
      return true;
    } catch (error) {
      if (!scopeCurrent(snapshot)) return false;
      if (!handleOwnerError(error)) setStatus(receiptStatus, error.message, "error");
      return false;
    }
  };

  const loadSetup = async () => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot)) return null;
    const state = await ownerApi(scopedPath("/api/admin/setup", snapshot.locationId));
    if (!scopeCurrent(snapshot)) return null;
    renderSetupState(state);
    return state;
  };

  // One function owns whether a credential is on screen and what it says.
  // Hiding the box and forgetting the string are the same act: a credential the
  // page still holds in a hidden node is a second copy of something the product
  // promises to show exactly once. An empty value therefore hides rather than
  // showing an empty box — the deactivate path returns no credential.
  const setCredential = (credential) => {
    staffCredentialValue.textContent = credential || "";
    staffCredential.hidden = !credential;
  };

  const renderStaffCreateScope = () => {
    const hadOptions = staffCreateScopeOptions.children.length > 0;
    const checked = new Set($$("input:checked", staffCreateScopeOptions).map(({ value }) => value));
    staffCreateScopeOptions.replaceChildren();
    staffCreateScope.hidden = locations.length === 1 || staffRole.value === "owner";
    for (const item of locations) {
      const label = createElement("label", "staff-scope-option");
      const input = createElement("input");
      input.type = "checkbox";
      input.value = item.id;
      input.checked = hadOptions ? checked.has(item.id) : item.id === "default";
      label.append(input, createElement("span", "", item.label));
      staffCreateScopeOptions.append(label);
    }
  };

  // Deliberately does not touch the credential box. This runs when the session
  // ends, and a session can end *because* the refresh after a successful
  // issuance was refused — clearing here would destroy the one copy of a
  // credential the server had already minted. It is cleared when a session
  // begins instead, so the next person to authenticate never sees it.
  const clearRoster = (note) => {
    renderRoster([], note);
    staffFields.disabled = true;
    staffSubmit.disabled = true;
    staffForm.reset();
    staffCreateScope.hidden = true;
    staffCreateScopeOptions.replaceChildren();
  };

  // The list is a second request, and it can fail on its own. Refreshing it is
  // not part of whether the command succeeded, so it is reported separately: a
  // stale list is a stale list, and telling an owner their change failed when
  // it did not is how the same person gets added twice.
  const refreshRoster = async () => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot)) return false;
    try {
      return await loadRoster();
    } catch (error) {
      if (!scopeCurrent(snapshot)) return false;
      if (!handleOwnerError(error)) {
        setStatus(staffStatus, `${error.message} 一覧は最新ではありません。`, "error");
      }
      return false;
    }
  };

  const rosterCommand = async (path, outcome, confirmation, button) => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || staffBusy) return;
    if (confirmation && !window.confirm(confirmation)) return;
    staffBusy = true;
    staffWritePending = true;
    button.disabled = true;
    setCredential("");
    try {
      const result = await ownerApi(path, { method: "POST", body: "{}" });
      if (!scopeCurrent(snapshot)) return;
      staffWritePending = false;
      // Keep the one-time credential even when the later roster refresh fails.
      setCredential(result.credential);
      setStatus(staffStatus, outcome, "success");
      await refreshRoster();
    } catch (error) {
      if (!scopeCurrent(snapshot)) return;
      if (!handleOwnerError(error)) setStatus(staffStatus, error.message, "error");
      return;
    } finally {
      if (scopeCurrent(snapshot)) {
        staffBusy = false;
        staffWritePending = false;
        if (button.isConnected) button.disabled = false;
      }
    }
  };

  const renderRoster = (
    members,
    emptyNote = "まだ誰も登録されていません。運営者トークンだけがこの設置を操作できます。",
  ) => {
    staffList.replaceChildren();
    // "有効", not a bare number: a stopped member is still listed below, and a
    // chip reading "0人" beside a visible card reads as "nobody is registered".
    staffCount.textContent = `有効 ${members.filter(({ active }) => active).length}人`;
    if (members.length === 0) {
      staffList.append(createElement("p", "empty-note", emptyNote));
      return;
    }
    for (const member of members) {
      const article = createElement("article", "staff-item");
      article.append(createElement("h3", "", member.displayName));
      const state = createElement(
        "span",
        member.active ? "badge" : "badge badge-cancelled",
        member.active ? "有効" : "停止中",
      );
      const summary = createElement(
        "p",
        "",
        member.role === "owner" ? "運営者 / 設定と外部連携も変更できる" : "スタッフ / 日々の予約対応",
      );
      let scopeForm = null;
      if (member.role === "staff" && locations.length > 1) {
        const scope = staffScopes.get(member.id) ?? {
          scopeVersion: 0, locationIds: ["default"],
        };
        const granted = scope.locationIds ?? [];
        const names = granted.map((id) => locations.find((item) => item.id === id)?.label ?? id);
        summary.textContent += ` / 担当: ${names.join("、") || "なし"}`;
        scopeForm = createElement("form", "staff-scope-form");
        const group = createElement("fieldset", "staff-scope-fields");
        group.append(createElement("legend", "", "担当する場所"));
        for (const item of locations) {
          const label = createElement("label", "staff-scope-option");
          const input = createElement("input");
          input.type = "checkbox";
          input.value = item.id;
          input.checked = granted.includes(item.id);
          label.append(input, createElement("span", "", item.label));
          group.append(label);
        }
        const save = createElement("button", "secondary-button", "担当場所を保存する");
        save.type = "submit";
        scopeForm.append(group, save);
        scopeForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          const snapshot = scopeSnapshot();
          if (!scopeCurrent(snapshot) || staffBusy) return;
          const locationIds = $$("input:checked", group).map(({ value }) => value);
          staffBusy = true;
          staffWritePending = true;
          save.disabled = true;
          setStatus(staffStatus, "担当場所の変更結果を確認しています。");
          try {
            const result = await ownerApi(
              `/api/admin/staff/${encodeURIComponent(member.id)}/locations`,
              { method: "PUT", body: JSON.stringify({ expectedScopeVersion: scope.scopeVersion, locationIds }) },
            );
            if (!scopeCurrent(snapshot)) return;
            staffWritePending = false;
            staffScopes.set(member.id, result);
            await refreshRoster();
            if (scopeCurrent(snapshot)) setStatus(staffStatus, "担当場所を更新しました。", "success");
          } catch (error) {
            if (!scopeCurrent(snapshot)) return;
            staffWritePending = false;
            if (handleOwnerError(error)) return;
            if (error.status === 409) await refreshRoster();
            if (scopeCurrent(snapshot)) setStatus(staffStatus, error.status === 409
              ? "担当場所が別の画面で更新されました。最新の内容を確認してください。"
              : error.message, "error");
          } finally {
            if (scopeCurrent(snapshot)) {
              staffBusy = false;
              staffWritePending = false;
              if (save.isConnected) save.disabled = false;
            }
          }
        });
      }
      const actions = createElement("div", "detail-actions");
      const action = (label, path, outcome, confirmation = "") => {
        const button = createElement("button", "text-button", label);
        button.type = "button";
        button.addEventListener(
          "click",
          () => void rosterCommand(path, outcome, confirmation, button),
        );
        actions.append(button);
      };
      const base = `/api/admin/staff/${encodeURIComponent(member.id)}`;
      if (member.active) {
        action(
          "認証情報を再発行する",
          `${base}/rotate`,
          "新しい認証情報を発行しました。前の認証情報は次の操作から使えません。",
        );
        action(
          "停止する",
          `${base}/deactivate`,
          "停止しました。次の操作から認証できません。",
          `${member.displayName} を停止します。今の認証情報は使えなくなり、再開しても元には戻りません。続けますか？`,
        );
      } else {
        // Not "the previous credential stopped working": deactivation destroyed
        // it, so there is no previous credential for this to be true of.
        action(
          "再開して認証情報を発行する",
          `${base}/reactivate`,
          "再開しました。新しい認証情報を発行しています。以前の認証情報は使えません。",
        );
      }
      article.append(state, summary);
      if (scopeForm) article.append(scopeForm);
      article.append(actions);
      staffList.append(article);
    }
  };

  const loadRoster = async () => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot)) return false;
    const [{ members }, { members: scopes }] = await Promise.all([
      ownerApi("/api/admin/staff"),
      ownerApi("/api/admin/staff/locations"),
    ]);
    if (!scopeCurrent(snapshot)) return false;
    staffScopes = new Map(scopes.map((entry) => [entry.staffId, entry]));
    renderRoster(members);
    staffFields.disabled = false;
    staffSubmit.disabled = false;
    return true;
  };

  const showLoggedOut = (message = "") => {
    ++locationEpoch;
    ownerToken = "";
    locations = [];
    pendingLocationCreate = null;
    staffBusy = false;
    staffWritePending = false;
    staffScopes = new Map();
    settingsDirty = false;
    calendarBusy = false;
    calendarSettings = null;
    calendarToken.textContent = "";
    calendarTokenBox.hidden = true;
    calendarPanel.hidden = true;
    locationPanel.hidden = true;
    locationList.replaceChildren();
    locationForm.reset();
    locationFields.disabled = true;
    setupState = null;
    editingSettings = null;
    pendingUpdate = null;
    pendingLive = null;
    logoutButton.hidden = true;
    fields.disabled = true;
    saveButton.disabled = true;
    liveButton.disabled = true;
    form.reset();
    servicesRoot.replaceChildren(createElement("p", "empty-note", "認証すると、初期の架空データを確認・編集できます。"));
    resourcesRoot.replaceChildren(createElement("p", "empty-note", "認証すると、初期の架空データを確認・編集できます。"));
    updateReadiness();
    clearReceipt();
    clearRoster("認証すると、登録済みのスタッフを表示します。");
    // A save or toggle that ended in a 401 left its in-progress line behind.
    setStatus(setupStatus, "");
    setStatus(staffStatus, "");
    setStatus(locationStatus, "");
    setStatus(calendarStatus, "");
    modeNotice.textContent = loggedOutNotice;
    modeNotice.dataset.tone = "";
    if (message) setStatus(authStatus, message, "error");
  };

  const renderLocations = (manual = false) => {
    locationPanel.hidden = !ownerToken;
    locationList.replaceChildren();
    locationCount.textContent = `${locations.length} / 4`;
    for (const item of locations) {
      const button = createElement("button", "secondary-button", item.label);
      button.type = "button";
      button.dataset.setupLocation = item.id;
      button.setAttribute("aria-pressed", String(!manual && item.id === locationId));
      button.append(createElement("span", "badge", item.bookable ? "受付中" : "受付不可"));
      button.addEventListener("click", () => void switchSetupLocation(item.id, { history: "push" }));
      locationList.append(button);
    }
    locationFields.disabled = !ownerToken || !locationId || locations.length >= 4 || Boolean(pendingLocationCreate);
    locationCreateSubmit.disabled = !ownerToken || !locationId ||
      (locations.length >= 4 && !pendingLocationCreate);
    locationCreateSubmit.textContent = pendingLocationCreate
      ? "未確認の追加結果を再確認する"
      : "場所を追加する";
  };

  const restoreSetupUrl = () => {
    if (locationId) setPageLocation(locationId, locations.length > 1, "replaceState", { locationId });
  };

  const switchSetupLocation = async (nextId, { history = "replace", force = false } = {}) => {
    const target = locations.find(({ id }) => id === nextId);
    if (!target) {
      setStatus(locationStatus, "この場所を確認できません。選び直してください。", "error");
      return;
    }
    if (pendingUpdate || pendingLive || pendingLocationCreate || calendarBusy || staffBusy) {
      if (history === false) restoreSetupUrl();
      setStatus(locationStatus, "未確認の変更結果を先に再確認してください。", "error");
      return;
    }
    if (!force && settingsDirty &&
      !window.confirm("保存していない設定を破棄して、場所を切り替えますか？")) {
      renderLocations();
      if (history === false) restoreSetupUrl();
      return;
    }
    ++locationEpoch;
    locationId = nextId;
    setupState = null;
    editingSettings = null;
    settingsDirty = false;
    fields.disabled = true;
    saveButton.disabled = true;
    liveButton.disabled = true;
    form.reset();
    servicesRoot.replaceChildren(createElement("p", "empty-note", "場所の設定を確認しています。"));
    resourcesRoot.replaceChildren(createElement("p", "empty-note", "場所の設定を確認しています。"));
    clearReceipt();
    calendarSettings = null;
    calendarToken.textContent = "";
    calendarTokenBox.hidden = true;
    calendarPanel.hidden = true;
    setStatus(calendarStatus, "");
    if (history) {
      setPageLocation(nextId, locations.length > 1,
        history === "push" ? "pushState" : "replaceState", { locationId: nextId });
    }
    applyLocationLinks(nextId);
    renderLocations();
    const snapshot = scopeSnapshot();
    setStatus(locationStatus, `${target.label}の設定を確認しています。`);
    try {
      await loadSetup();
      if (!scopeCurrent(snapshot)) return;
      await loadReceipt();
      if (!scopeCurrent(snapshot)) return;
      try {
        const savedStep = localStorage.getItem(storageKey(SETUP_STEP_KEY, nextId));
        setSetupStep(["identity", "schedule", "protection", "review"].includes(savedStep) ? savedStep : "identity");
      } catch {
        setSetupStep("identity");
      }
      if (nextId !== "default") await loadCalendarSettings();
      if (!scopeCurrent(snapshot)) return;
      setStatus(locationStatus, `${target.label}の設定を表示しました。`, "success");
    } catch (error) {
      if (!scopeCurrent(snapshot)) return;
      if (!handleOwnerError(error)) setStatus(locationStatus, error.message, "error");
    }
  };

  const renderCalendarSettings = (settings) => {
    calendarSettings = settings;
    calendarPanel.hidden = !ownerToken || locationId === "default";
    calendarVersion.textContent = `設定 v${settings.version}`;
    calendarIdInput.value = settings.calendarId ?? "";
    calendarIdInput.readOnly = settings.calendarId !== null;
    calendarGoogle.checked = settings.googleEnabled;
    calendarFeed.checked = settings.feedEnabled;
    calendarFields.disabled = calendarBusy;
    calendarFeed.disabled = calendarBusy || !settings.feedTokenPresent;
    calendarIssue.disabled = calendarBusy;
    calendarIssue.textContent = settings.feedTokenPresent
      ? "購読トークンを再発行する"
      : "購読トークンを発行する";
  };

  const loadCalendarSettings = async () => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || snapshot.locationId === "default") return false;
    calendarPanel.hidden = false;
    calendarFields.disabled = true;
    calendarIssue.disabled = true;
    setStatus(calendarStatus, "カレンダー設定を確認しています。");
    try {
      const response = await ownerApi(scopedPath("/api/admin/calendar/status", snapshot.locationId));
      if (!scopeCurrent(snapshot)) return false;
      renderCalendarSettings(response.settings);
      setStatus(calendarStatus, "");
      return true;
    } catch (error) {
      if (!scopeCurrent(snapshot)) return false;
      if (!handleOwnerError(error)) setStatus(calendarStatus, error.message, "error");
      return false;
    }
  };

  // The same check the operator screen keeps under this name. The two screens
  // are separate closures with their own showLoggedOut, so the shape is shared
  // rather than the function.
  const handleOwnerError = (error) => {
    if (error.status !== 401) return false;
    showLoggedOut("認証の有効性を確認できませんでした。もう一度認証してください。");
    return true;
  };

  try {
    const explicit = explicitLocation(window.location.search);
    const directory = await readLocationDirectory();
    locationId = explicit ?? "default";
    if (!directory.some(({ id }) => id === locationId)) {
      throw new Error("場所を確認できません。リンクを確認してください。");
    }
    applyLocationLinks(locationId);
    const config = await api(scopedPath("/api/config", locationId));
    applyPublicConfig(config, locationId);
    // The public config already reports demo for a live installation that is not
    // ready, so its live is the accepting one.
    loggedOutNotice = loggedOutNoticeFor(config.mode === "live");
    modeNotice.textContent = loggedOutNotice;
  } catch (error) {
    setStatus(authStatus, `公開設定を読み込めませんでした。 ${error.message}`, "error");
  }
  showLoggedOut();
  try {
    const savedStep = localStorage.getItem(storageKey(SETUP_STEP_KEY, locationId));
    setSetupStep(["identity", "schedule", "protection", "review"].includes(savedStep) ? savedStep : "identity");
  } catch {
    setSetupStep("identity");
  }

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!authForm.reportValidity()) return;
    const nextToken = tokenInput.value;
    tokenInput.value = "";
    if (pendingUpdate || pendingLive || pendingLocationCreate || calendarBusy || staffWritePending) {
      setStatus(authStatus, "未確認の変更結果を再確認してから認証し直してください。", "error");
      return;
    }
    if ((staffCredentialValue.textContent || calendarToken.textContent) &&
      !window.confirm("一度だけ表示する認証情報があります。安全に控えてから認証し直しますか？")) return;
    if (settingsDirty && !window.confirm("保存していない設定を破棄して認証し直しますか？")) return;
    // A new session starts with no credential on screen, whoever the last one
    // belonged to.
    setCredential("");
    showLoggedOut();
    ownerToken = nextToken;
    const token = ownerToken;
    const authEpoch = locationEpoch;
    setStatus(authStatus, "認証して設定を読み込んでいます。");
    try {
      const explicit = explicitLocation(window.location.search);
      const directory = await ownerApi("/api/admin/locations");
      if (ownerToken !== token || locationEpoch !== authEpoch) return;
      if (directory.role !== "owner" || !validLocationDirectory(directory.locations)) {
        throw new Error("設定を開くには運営者権限が必要です。");
      }
      locations = directory.locations;
      renderStaffCreateScope();
      logoutButton.hidden = false;
      const selected = explicit ?? "default";
      if (!locations.some(({ id }) => id === selected)) {
        locationId = null;
        renderLocations(true);
        setStatus(authStatus, "この場所を確認できません。編集する場所を選んでください。", "error");
        return;
      }
      await switchSetupLocation(selected, { history: explicit === null ? "replace" : false, force: true });
      if (!ownerToken || locationId !== selected || !setupState) return;
      await refreshRoster();
      if (!ownerToken || locationId !== selected) return;
      setStatus(authStatus, "認証しました。トークンはこのページを閉じると消えます。", "success");
    } catch (error) {
      if (ownerToken === token && locationEpoch === authEpoch) showLoggedOut(error.message);
    }
  });
  locationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot)) return;
    if (!pendingLocationCreate) {
      if (!locationForm.reportValidity()) return;
      const id = newLocationId.value.trim();
      const name = newLocationName.value.trim();
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || id.endsWith("-") ||
        [...name].length < 1 || [...name].length > 80) {
        setStatus(locationStatus, "識別子と表示名を確認してください。", "error");
        return;
      }
      if (settingsDirty && !window.confirm("保存していない設定を破棄して、新しい場所を開きますか？")) return;
      pendingLocationCreate = { commandId: crypto.randomUUID(), locationId: id, locationName: name };
    }
    renderLocations();
    setStatus(locationStatus, "場所の追加結果を確認しています。");
    let created = false;
    try {
      const result = await ownerApi("/api/admin/locations", {
        method: "POST",
        body: JSON.stringify(pendingLocationCreate),
      });
      if (!scopeCurrent(snapshot)) return;
      created = true;
      pendingLocationCreate = null;
      locationForm.reset();
      const directory = await ownerApi("/api/admin/locations");
      if (!scopeCurrent(snapshot)) return;
      if (!validLocationDirectory(directory.locations)) {
        throw new Error("場所の一覧を更新できませんでした。");
      }
      locations = directory.locations;
      renderStaffCreateScope();
      renderLocations();
      await switchSetupLocation(result.location.id, { history: "push", force: true });
      if (ownerToken && locationId === result.location.id) {
        setStatus(locationStatus, "場所を追加しました。公開予約は設定完了まで無効です。", "success");
      }
    } catch (error) {
      if (!scopeCurrent(snapshot)) return;
      if ([400, 409, 413].includes(error.status)) pendingLocationCreate = null;
      if (error.status === 409) {
        try {
          const directory = await ownerApi("/api/admin/locations");
          if (!scopeCurrent(snapshot)) return;
          if (validLocationDirectory(directory.locations)) {
            locations = directory.locations;
            renderStaffCreateScope();
          }
        } catch {
          // Keep the mutation error; a later reload can refresh the list.
        }
      }
      if (!handleOwnerError(error)) {
        setStatus(locationStatus, created
          ? "場所は追加されましたが、一覧を更新できませんでした。再読み込みしてください。"
          : `${error.message}${pendingLocationCreate ? " 同じ内容で結果を再確認できます。" : ""}`, "error");
      }
    } finally {
      if (scopeCurrent(snapshot)) renderLocations();
    }
  });
  calendarForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || snapshot.locationId === "default" || !calendarSettings || calendarBusy) return;
    const targetId = (calendarSettings.calendarId ?? calendarIdInput.value.trim()) || null;
    if (targetId === "primary" || (calendarGoogle.checked && !targetId)) {
      setStatus(calendarStatus, "Google 同期には実際のカレンダー ID を指定してください。", "error");
      return;
    }
    const command = {
      expectedVersion: calendarSettings.version,
      googleEnabled: calendarGoogle.checked,
      calendarId: targetId,
      feedEnabled: calendarFeed.checked,
    };
    calendarBusy = true;
    calendarFields.disabled = true;
    calendarIssue.disabled = true;
    setStatus(calendarStatus, "設定の保存結果を確認しています。");
    try {
      const result = await ownerApi(scopedPath("/api/admin/calendar/settings", snapshot.locationId), {
        method: "PUT",
        body: JSON.stringify(command),
      });
      if (!scopeCurrent(snapshot)) return;
      renderCalendarSettings(result.settings);
      setStatus(calendarStatus, "カレンダー設定を保存しました。", "success");
    } catch (error) {
      if (!scopeCurrent(snapshot)) return;
      if (handleOwnerError(error)) return;
      if (error.status === 409 || error.status === undefined) {
        calendarToken.textContent = "";
        calendarTokenBox.hidden = true;
        await loadCalendarSettings();
      }
      if (!scopeCurrent(snapshot)) return;
      setStatus(calendarStatus, error.status === 409
        ? "設定が更新されました。最新の内容を確認してください。"
        : `${error.message} 結果が不明な場合は最新の状態を確認してから操作してください。`, "error");
    } finally {
      if (scopeCurrent(snapshot)) {
        calendarBusy = false;
        if (calendarSettings) renderCalendarSettings(calendarSettings);
      }
    }
  });
  calendarIssue.addEventListener("click", async () => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || snapshot.locationId === "default" || !calendarSettings || calendarBusy) return;
    if (calendarSettings.feedTokenPresent &&
      !window.confirm("購読トークンを再発行すると、前のトークンは使えなくなります。続けますか？")) return;
    const expectedVersion = calendarSettings.version;
    calendarBusy = true;
    calendarFields.disabled = true;
    calendarIssue.disabled = true;
    calendarToken.textContent = "";
    calendarTokenBox.hidden = true;
    setStatus(calendarStatus, "トークンの発行結果を確認しています。");
    try {
      const result = await ownerApi(scopedPath("/api/admin/calendar/feed-token", snapshot.locationId), {
        method: "POST",
        body: JSON.stringify({ expectedVersion }),
      });
      if (!scopeCurrent(snapshot)) return;
      if (!Number.isSafeInteger(result.version) ||
        typeof result.token !== "string" || result.token.length < 20) {
        throw new Error("トークンの発行結果を確認できませんでした。");
      }
      calendarSettings = { ...calendarSettings, version: result.version, feedTokenPresent: true };
      calendarToken.textContent = result.token;
      calendarTokenBox.hidden = false;
      setStatus(calendarStatus, "発行しました。この画面を閉じる前に安全に控えてください。", "success");
    } catch (error) {
      if (!scopeCurrent(snapshot)) return;
      if (handleOwnerError(error)) return;
      await loadCalendarSettings();
      if (!scopeCurrent(snapshot)) return;
      setStatus(calendarStatus,
        `${error.message} 発行結果は再表示できません。状態を確認し、必要なら明示的に再発行してください。`,
        "error",
      );
    } finally {
      if (scopeCurrent(snapshot)) {
        calendarBusy = false;
        if (calendarSettings) renderCalendarSettings(calendarSettings);
      }
    }
  });
  $("[data-calendar-token-copy]").addEventListener("click", () => {
    if (calendarToken.textContent) void copyText(calendarToken.textContent, calendarStatus);
  });
  window.addEventListener("popstate", () => {
    if (!ownerToken) return;
    if (pendingUpdate || pendingLive || pendingLocationCreate || calendarBusy || staffBusy || settingsDirty) {
      restoreSetupUrl();
      setStatus(locationStatus, "未保存または未確認の変更を先に確認してください。", "error");
      return;
    }
    let selected;
    try {
      selected = explicitLocation(window.location.search) ?? "default";
    } catch {
      selected = null;
    }
    if (!locations.some(({ id }) => id === selected)) {
      ++locationEpoch;
      locationId = null;
      setupState = null;
      editingSettings = null;
      fields.disabled = true;
      form.reset();
      servicesRoot.replaceChildren();
      resourcesRoot.replaceChildren();
      clearReceipt();
      calendarToken.textContent = "";
      calendarTokenBox.hidden = true;
      calendarPanel.hidden = true;
      renderLocations(true);
      setStatus(locationStatus, "この場所を確認できません。編集する場所を選んでください。", "error");
    } else if (selected !== locationId) {
      void switchSetupLocation(selected, { history: false });
    }
  });
  logoutButton.addEventListener("click", () => {
    if (pendingUpdate || pendingLive || pendingLocationCreate || calendarBusy || staffWritePending) {
      setStatus(authStatus, "未確認の変更結果を再確認してからログアウトしてください。", "error");
      return;
    }
    // Here and not in `showLoggedOut`, because the two ways a session ends are
    // not the same. A refused refresh ends it against the owner's wishes, and
    // clearing there would destroy a credential the server had already minted.
    // Pressing this button is the owner saying they are finished, which
    // includes being finished with what is on screen.
    setCredential("");
    showLoggedOut();
    setStatus(authStatus, "ログアウトしました。", "success");
  });

  staffForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || staffBusy) return;
    if (!staffForm.reportValidity()) return;
    const displayName = staffDisplayName.value.trim();
    if (displayName === "") {
      setStatus(staffStatus, "画面に表示する名前を入力してください。", "error");
      return;
    }
    staffBusy = true;
    staffWritePending = true;
    staffSubmit.disabled = true;
    setCredential("");
    setStatus(staffStatus, "スタッフを登録しています。");
    try {
      const locationIds = $$("input:checked", staffCreateScopeOptions).map(({ value }) => value);
      const result = await ownerApi("/api/admin/staff", {
        method: "POST",
        body: JSON.stringify({
          displayName,
          role: staffRole.value,
          ...(staffRole.value === "staff" && locations.length > 1 ? { locationIds } : {}),
        }),
      });
      if (!scopeCurrent(snapshot)) return;
      staffWritePending = false;
      staffForm.reset();
      renderStaffCreateScope();
      // Committed before the refresh, for the same reason as in `rosterCommand`.
      setCredential(result.credential);
      setStatus(staffStatus, "登録しました。認証情報は下に一度だけ表示します。", "success");
      await refreshRoster();
    } catch (error) {
      if (!scopeCurrent(snapshot)) return;
      if (!handleOwnerError(error)) setStatus(staffStatus, error.message, "error");
    } finally {
      if (scopeCurrent(snapshot)) {
        staffBusy = false;
        staffWritePending = false;
        staffSubmit.disabled = false;
      }
    }
  });
  staffRole.addEventListener("change", renderStaffCreateScope);
  $("[data-staff-copy]").addEventListener("click", () =>
    copyText(staffCredentialValue.textContent, staffStatus),
  );

  form.addEventListener("focusin", (event) => {
    const stage = event.target.closest("[data-setup-step]");
    if (stage) setSetupStep(stage.dataset.setupStep);
  });
  form.addEventListener("input", () => { if (setupState) settingsDirty = true; });
  form.addEventListener("change", () => { if (setupState) settingsDirty = true; });
  $("[data-setup-add-service]").addEventListener("click", () => {
    if (editingSettings.services.length >= 16) {
      setStatus(setupStatus, "サービスは16件まで登録できます。", "error");
      return;
    }
    editingSettings.services.push({
      id: uniqueId("service", editingSettings.services),
      label: "新しいサービス",
      category: null,
      durationMinutes: 60,
      cleanupMinutes: 0,
      priceYen: null,
      eligibleResourceIds: editingSettings.resources[0] ? [editingSettings.resources[0].id] : [],
      active: true,
    });
    settingsDirty = true;
    renderServiceEditors();
  });
  $("[data-setup-add-resource]").addEventListener("click", () => {
    if (editingSettings.resources.length >= 8) {
      setStatus(setupStatus, "担当・設備は8件まで登録できます。", "error");
      return;
    }
    const resource = {
      id: uniqueId("resource", editingSettings.resources),
      label: "新しい担当・設備",
      active: true,
    };
    editingSettings.resources.push(resource);
    settingsDirty = true;
    renderResourceEditors();
    renderServiceEditors();
  });

  const handleSetupSaveError = async (error, snapshot) => {
    if (!scopeCurrent(snapshot)) return;
    if ([400, 401, 409, 413].includes(error.status)) pendingUpdate = null;
    if (handleOwnerError(error)) return;
    if (error.code === "CONFIGURATION_CONFLICT") {
      await loadSetup().catch(() => {});
      if (!scopeCurrent(snapshot)) return;
      setStatus(setupStatus, "ほかの画面で設定が更新されました。最新の内容を読み込みました。もう一度確認してください。", "error");
      focusWithoutScroll(setupStatus);
      return;
    }
    setStatus(setupStatus, `${error.message}${pendingUpdate ? " 同じ設定で結果を再確認できます。" : ""}`, "error");
  };

  const handleLiveToggleError = async (error, snapshot) => {
    if (!scopeCurrent(snapshot)) return;
    if ([400, 401, 409, 413].includes(error.status)) pendingLive = null;
    if (handleOwnerError(error)) return;
    if (error.code === "CONFIGURATION_CONFLICT") await loadSetup().catch(() => {});
    if (!scopeCurrent(snapshot)) return;
    setStatus(setupStatus, `${error.message}${pendingLive ? " 同じ操作で結果を再確認できます。" : ""}`, "error");
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || !setupState) return;
    if (!pendingUpdate && !form.reportValidity()) {
      setStatus(setupStatus, "入力内容を確認してください。", "error");
      return;
    }
    if (!pendingUpdate && !weekdayInputs.some(({ checked }) => checked)) {
      setStatus(setupStatus, "受付する曜日を1つ以上選んでください。", "error");
      return;
    }
    if (!pendingUpdate) {
      const settings = completeSettings();
      const boundedTexts = [
        [settings.locationName, 1, 80],
        [settings.operatorDisplayName, 1, 120],
        [settings.operatorContact, 3, 200],
        [settings.privacyNotice, 1, 500],
        [settings.termsNotice, 1, 500],
        [settings.cancellationPolicy, 1, 500],
        ...settings.services.flatMap(({ label, category }) => [[label, 1, 80], [category ?? "", 0, 60]]),
        ...settings.resources.map(({ label }) => [label, 1, 80]),
      ];
      if (boundedTexts.some(([value, minimum, maximum]) => {
        const length = Array.from(value).length;
        return length < minimum || length > maximum;
      })) {
        setStatus(setupStatus, "文字数が許容範囲外の項目があります。入力内容を確認してください。", "error");
        return;
      }
      pendingUpdate = {
        commandId: crypto.randomUUID(),
        expectedSettingsVersion: setupState.settingsVersion,
        settings,
      };
    }
    updateSetupControls();
    setStatus(setupStatus, "設定の保存結果を確認しています。");
    try {
      const state = await ownerApi(scopedPath("/api/admin/setup", snapshot.locationId), {
        method: "PUT",
        body: JSON.stringify(pendingUpdate),
      });
      if (!scopeCurrent(snapshot)) return;
      pendingUpdate = null;
      renderSetupState(state);
      await loadReceipt();
      if (!scopeCurrent(snapshot)) return;
      const item = locations.find(({ id }) => id === snapshot.locationId);
      if (item) {
        item.label = state.settings.locationName;
        item.bookable = state.mode === "live" && state.readiness.ready;
        renderLocations();
      }
      setStatus(
        setupStatus,
        state.replayed ? "同じ設定の保存結果を確認しました。" : `設定バージョン ${state.settingsVersion} として保存しました。`,
        "success",
      );
    } catch (error) {
      if (scopeCurrent(snapshot)) await handleSetupSaveError(error, snapshot);
    } finally {
      if (scopeCurrent(snapshot)) updateSetupControls();
    }
  });

  liveButton.addEventListener("click", async () => {
    const snapshot = scopeSnapshot();
    if (!scopeCurrent(snapshot) || !setupState) return;
    const makeLive = setupState.mode !== "live";
    if (!pendingLive) {
      const confirmation = makeLive
        ? "4つの準備項目を確認し、公開予約を有効にしますか？"
        : "公開予約の受付を停止し、デモ・設定中へ戻しますか？";
      if (!window.confirm(confirmation)) return;
      pendingLive = {
        commandId: crypto.randomUUID(),
        expectedSettingsVersion: setupState.settingsVersion,
        live: makeLive,
      };
    }
    updateSetupControls();
    setStatus(setupStatus, "公開状態の切替結果を確認しています。");
    try {
      const state = await ownerApi(scopedPath("/api/admin/setup/live", snapshot.locationId), {
        method: "POST",
        body: JSON.stringify(pendingLive),
      });
      if (!scopeCurrent(snapshot)) return;
      pendingLive = null;
      renderSetupState(state);
      await loadReceipt();
      if (!scopeCurrent(snapshot)) return;
      const item = locations.find(({ id }) => id === snapshot.locationId);
      if (item) {
        item.bookable = state.mode === "live" && state.readiness.ready;
        renderLocations();
      }
      setStatus(setupStatus, state.mode === "live" ? "公開予約を有効にしました。" : "公開予約を停止し、デモへ戻しました。", "success");
    } catch (error) {
      if (scopeCurrent(snapshot)) await handleLiveToggleError(error, snapshot);
    } finally {
      if (scopeCurrent(snapshot)) updateSetupControls();
    }
  });

  receiptCopy.addEventListener("click", () => {
    if (receipt) void copyText(JSON.stringify(receipt, null, 2), receiptStatus);
  });
  receiptDownload.addEventListener("click", () => {
    if (!receipt) return;
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: "application/json" }));
    const link = createElement("a");
    link.href = url;
    link.download = locationId === "default"
      ? `salon-reservation-installation-receipt-v${receipt.settingsVersion}.json`
      : `salon-reservation-${locationId}-installation-receipt-v${receipt.settingsVersion}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(receiptStatus, "設置受領書をダウンロードしました。", "success");
  });
  tokenInput.disabled = false;
  authForm.querySelector('button[type="submit"]').disabled = false;
};

const startLegal = async () => {
  const modeNotice = $("[data-legal-mode-notice]");
  try {
    const explicit = explicitLocation(window.location.search);
    const defaultPending = explicit === null ? readPendingMutation() : null;
    const locations = await readLocationDirectory();
    const locationId = choosePublicLocation(locations, explicit, Boolean(defaultPending));
    if (locationId === null) throw new Error("場所を確認できません。リンクを確認してください。");
    if (explicit === null && (locationId !== "default" || locations.length > 1)) {
      setPageLocation(locationId, locations.length > 1);
    }
    applyLocationLinks(locationId);
    const config = await api(scopedPath("/api/config", locationId));
    applyPublicConfig(config, locationId);
    const page = document.body.dataset.legalPage;
    const target = {
      privacy: $("[data-legal-privacy]"),
      terms: $("[data-legal-terms]"),
      cancellation: $("[data-legal-cancellation]"),
    }[page];
    const notice = {
      privacy: config.privacyNotice,
      terms: config.termsNotice,
      cancellation: config.cancellationPolicy,
    }[page];
    if (target && typeof notice === "string") target.textContent = notice;
    const contact = $("[data-legal-contact]");
    if (contact) contact.textContent = `${config.operatorDisplayName} / ${config.operatorContact}`;
    modeNotice.hidden = config.mode === "live";
  } catch (error) {
    modeNotice.hidden = false;
    modeNotice.textContent = `${error.message} 予約を送信せず、時間を置いて再確認してください。`;
  }
};

const starters = {
  customer: startCustomer,
  bookings: startBookings,
  admin: startAdmin,
  setup: startSetup,
  privacy: startLegal,
  terms: startLegal,
  cancellation: startLegal,
};

const starter = starters[document.body.dataset.page];
if (starter) {
  try {
    await starter();
  } catch {
    const status = $("output");
    setStatus(status, "画面を準備できませんでした。再読み込みしてお試しください。", "error");
  }
}
