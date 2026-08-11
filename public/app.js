import {
  decodeJourneyDraft,
  decodePendingMutationRecord,
  encodeJourneyDraft,
  encodePendingMutationRecord,
  getJourneyStep,
  readOwnedBookingRecords,
  removeOwnedBookingRecord,
  restoreJourneyDraft,
  saveOwnedBookingRecord,
} from "./journey.js";

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
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
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
    throw error;
  }
  return body;
};

const staleOwnerSessionError = () => {
  const error = new Error("認証状態が変わりました。もう一度認証してください。");
  error.status = 401;
  return error;
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
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
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

const sourceUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

const applyPublicConfig = (config) => {
  $$("[data-location-name]").forEach((element) => {
    element.textContent = config.locationName;
  });
  const title = document.title.split("|")[0].trim();
  document.title = `${title} | ${config.locationName}`;
  const publicSource = sourceUrl(config.sourceUrl);
  if (publicSource) {
    $$("[data-source-link]").forEach((element) => {
      element.href = publicSource;
    });
  }
  $$('[data-consent-version]').forEach((element) => {
    element.textContent = config.consentVersion;
  });
  document.documentElement.dataset.theme = config.themeId;
  document.body.dataset.installationMode = config.mode;
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

const readOwnedRecords = () => {
  try {
    const encoded = localStorage.getItem(OWNED_BOOKINGS_KEY);
    if (!encoded || encoded.length > 16 * 1_024) return [];
    return readOwnedBookingRecords(JSON.parse(encoded), Date.now());
  } catch {
    return [];
  }
};

const writeOwnedRecords = (records) => {
  if (records.length === 0) localStorage.removeItem(OWNED_BOOKINGS_KEY);
  else localStorage.setItem(OWNED_BOOKINGS_KEY, JSON.stringify(records));
};

const readDraft = () => {
  try {
    const encoded = localStorage.getItem(DRAFT_KEY);
    const draft = decodeJourneyDraft(encoded, Date.now());
    if (!draft && encoded) localStorage.removeItem(DRAFT_KEY);
    return draft;
  } catch {
    return null;
  }
};

const clearDraft = () => {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Draft persistence is optional and never authoritative.
  }
};

const availabilityPath = (
  date,
  serviceIds,
  path = "/api/availability",
  reservationId,
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
  let config;
  let availability = null;
  let journeyStep = "selection";
  let availabilitySequence = 0;
  let pending = readPendingMutation();
  let turnstileToken = "";
  let widgetId;
  let resultRecord = null;
  let busy = false;

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
        DRAFT_KEY,
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
    $("[data-journey-help='review']").textContent = pending
      ? "前回の受付結果だけを再確認できます。新しい予約は作成しません。"
      : config?.mode !== "live"
        ? "デモ・設定中のため送信できません。実在する方の情報は入力しないでください。"
        : turnstileToken
          ? "送信時に空き状況をもう一度確認します。"
          : "内容を確認し、自動送信防止の確認を完了すると送信できます。";
  };

  const setPendingMode = () => {
    const active = Boolean(pending);
    $$("input[name='serviceIds']", serviceList).forEach((input) => {
      input.disabled = active;
    });
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

  const renderReview = () => {
    const current = selection();
    const selectedServices = availability?.services ?? current.serviceIds
      .map((id) => config.services.find((service) => service.id === id))
      .filter(Boolean);
    const resource =
      availability?.resources?.find(({ id }) => id === current.resourceId) ??
      config.resources.find(({ id }) => id === current.resourceId);
    $("[data-review-services]").textContent =
      selectedServices.map(({ label }) => label).join("、") || "未選択";
    $("[data-review-resource]").textContent = resource?.label ?? "未選択";
    $("[data-review-time]").textContent =
      current.date && current.startTime
        ? formatDateTime(current.date, current.startTime)
        : "未選択";
    $("[data-review-duration]").textContent = availability
      ? `${availability.serviceMinutes}分 + 準備 ${availability.cleanupMinutes}分（計 ${availability.occupiedMinutes}分）`
      : "送信時に再確認します";
    $("[data-review-price]").textContent = availability
      ? formatPrice(availability.priceYen)
      : "送信時に再確認します";
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
      window.history.pushState({ journeyStep: nextStep }, "");
    } else if (history === "replace") {
      window.history.replaceState({ journeyStep: nextStep }, "");
    }
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

  const resetAvailability = () => {
    availability = null;
    resourceSelect.replaceChildren(new Option("サービスと日付を選ぶと表示されます", ""));
    resourceSelect.disabled = true;
    slotList.replaceChildren(
      createElement("p", "empty-note", "サービス、日付、担当・設備を選んでください。"),
    );
    slotField.disabled = true;
    updateActions();
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
      const loaded = await api(availabilityPath(date, serviceIds));
      if (sequence !== availabilitySequence) return;
      availability = loaded;
      resourceSelect.replaceChildren(new Option("担当・設備を選んでください", ""));
      for (const resource of loaded.resources) {
        resourceSelect.append(new Option(resource.label, resource.id));
      }
      const requestedResource = pending?.request.resourceId ?? previousResource;
      if (loaded.resources.some(({ id }) => id === requestedResource)) {
        resourceSelect.value = requestedResource;
      } else if (loaded.resources.length === 1 && !pending) {
        resourceSelect.value = loaded.resources[0].id;
      }
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
      if (sequence === availabilitySequence) root.removeAttribute("aria-busy");
      setPendingMode();
    }
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
          void loadAvailability();
          saveDraft();
        }),
      );
    }
  };

  try {
    config = await api("/api/config");
    applyPublicConfig(config);
    modeNotice.hidden = config.mode === "live";
    const today = jstToday();
    dateInput.min = today;
    dateInput.max = addDays(today, config.schedule.horizonDays - 1);
    dateInput.value = today;
    const draft = readDraft();
    const selected = pending?.request.serviceIds ?? draft?.serviceIds ?? [];
    renderServices(selected);
    if (pending) {
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
    } else if (draft) {
      dateInput.value = draft.date ?? today;
      if (draft.serviceIds.length && draft.date) {
        await loadAvailability({
          quiet: true,
          preferredResource: draft.resourceId,
          preferredTime: draft.startTime,
        });
      }
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
      if (restored) {
        if (restored.serviceIds.join() !== selected.join()) renderServices(restored.serviceIds);
        dateInput.value = restored.date ?? today;
        if (availability) {
          resourceSelect.value = restored.resourceId ?? "";
          renderSlots(restored.startTime);
        }
        setStep(restored.step, { history: "replace", focus: false });
        if (restored.step === "selection" && draft.step !== "selection") {
          setStatus(status, "保存した選択内容が変わっていたため、最初の手順から確認してください。", "error");
        }
      }
    } else {
      setStep("selection", { history: "replace", focus: false });
    }
    if (config.mode !== "live") {
      setStatus(status, "現在はデモ・設定中です。実在する方の情報は入力しないでください。", "error");
    }
  } catch (error) {
    setStatus(status, error.message, "error");
    form.querySelectorAll("input, select, button").forEach((control) => {
      control.disabled = true;
    });
    return;
  }

  dateInput.addEventListener("change", () => {
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
  $$("[data-journey-back]").forEach((button) => {
    button.addEventListener("click", () => setStep(button.dataset.journeyBack));
  });
  window.addEventListener("popstate", (event) => {
    setStep(event.state?.journeyStep ?? "selection", { history: false });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending && Date.now() - pending.retryAt >= DAY_MS) {
      clearPendingMutation();
      pending = null;
      setPendingMode();
      setStep("selection", { history: "replace" });
      setStatus(status, "未確認の送信内容は24時間を過ぎたため削除しました。最新の空き時間から選び直してください。", "error");
      return;
    }
    const retrying = Boolean(pending);
    if (!retrying && config.mode !== "live") {
      setStatus(status, "公開予約はまだ有効ではありません。設定完了後にお試しください。", "error");
      return;
    }
    if (!retrying && getJourneyStep({ requestedStep: "review", selection: selection(), details: details() }) !== "review") {
      setStep("review");
      return;
    }
    if (!retrying && !turnstileToken) {
      setStatus(status, "自動送信防止の確認を完了してください。", "error");
      return;
    }
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
        writePendingMutation(candidate);
        pending = candidate;
        setPendingMode();
      }
      const managementDigest = await digestHex(pending.managementKey);
      const response = await api("/api/reservations", {
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
      resultId.textContent = reservation.reservationId;
      resultKey.textContent = pending.managementKey;
      resultStatus.textContent = response.replayed
        ? "同じ申請の受付結果を確認しました。現在は運営者の確認待ちです。"
        : "申請を受け付けました。現在は運営者の確認待ちです。";
      clearPendingMutation();
      clearDraft();
      pending = null;
      remember.checked = false;
      form.hidden = true;
      result.hidden = false;
      setStatus(status, "予約の申請を受け付けました。", "success");
      focusWithoutScroll(result);
    } catch (error) {
      if (
        [400, 404, 409, 413].includes(error.status)
        || (!retrying && [403, 429].includes(error.status))
      ) {
        clearPendingMutation();
        pending = null;
      }
      if (error.code === "UNAVAILABLE" || error.code === "CONFIGURATION_CONFLICT") {
        if (error.code === "CONFIGURATION_CONFLICT") {
          try {
            const selected = selectedServiceIds();
            config = await api("/api/config");
            applyPublicConfig(config);
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
      } else {
        setStatus(
          status,
          `${error.message}${pending ? " 同じ内容と管理キーで結果を再確認できます。" : ""}`,
          "error",
        );
      }
    } finally {
      busy = false;
      form.removeAttribute("aria-busy");
      turnstileToken = "";
      if (window.turnstile && widgetId !== undefined) window.turnstile.reset(widgetId);
      setPendingMode();
    }
  });

  remember.addEventListener("change", () => {
    if (!resultRecord) return;
    try {
      const records = remember.checked
        ? saveOwnedBookingRecord(readOwnedRecords(), resultRecord, true)
        : removeOwnedBookingRecord(readOwnedRecords(), resultRecord.reservationId);
      writeOwnedRecords(records);
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
      writeOwnedRecords(removeOwnedBookingRecord(readOwnedRecords(), resultRecord.reservationId));
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
  const cancelCommands = new Map();
  let records = readOwnedRecords();
  let cancelTarget = null;

  const persist = () => {
    try {
      writeOwnedRecords(records);
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

  const removeRecord = (reservationId) => {
    const previous = records;
    records = removeOwnedBookingRecord(records, reservationId);
    if (!persist()) {
      records = previous;
      return false;
    }
    $(`[data-booking-card][data-reservation-id='${CSS.escape(reservationId)}']`, list)?.remove();
    updateEmpty();
    return true;
  };

  const openCancel = (record, booking, card) => {
    cancelTarget = { record, booking, card };
    dialogSummary.textContent = `${formatDateTime(booking.date, booking.startTime)}、${booking.services.map(({ label }) => label).join("、")}の予約を取り消します。`;
    setStatus(dialogStatus, "");
    dialog.showModal();
  };

  const renderCard = (record, booking) => {
    const fragment = template.content.cloneNode(true);
    const card = $("[data-booking-card]", fragment);
    card.dataset.reservationId = record.reservationId;
    card.dataset.bookingState = booking.status;
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
    $("[data-booking-status-description]", card).textContent = booking.rejectionReason
      ? `${STATUS_LABELS[booking.status] ?? booking.status}（${booking.rejectionReason}）`
      : booking.expiresAt
        ? `${statusLabel}（${formatDeadline(booking.expiresAt)}までに確認されないと期限切れになります）`
        : statusLabel;
    $("[data-booking-allowed-actions]", card).textContent = booking.allowedActions.includes("cancel")
      ? "このページから取り消せます"
      : "現在利用できる操作はありません";
    const cancel = $("[data-booking-cancel]", card);
    cancel.hidden = !booking.allowedActions.includes("cancel");
    cancel.addEventListener("click", () => openCancel(record, booking, card));
    $("[data-booking-remove]", card).addEventListener("click", () => {
      if (!window.confirm("この端末から予約番号と管理キーを削除します。続けますか？")) return;
      if (removeRecord(record.reservationId)) {
        setStatus(pageStatus, "この端末から保存情報を削除しました。", "success");
      }
    });
    list.append(fragment);
  };

  try {
    const config = await api("/api/config");
    applyPublicConfig(config);
  } catch {
    // The owned records can still show a uniform per-record error below.
  }

  persist();
  list.replaceChildren();
  for (const record of records) {
    try {
      const booking = await api(
        `/api/reservations/${encodeURIComponent(record.reservationId)}/status`,
        {
          method: "POST",
          body: JSON.stringify({ date: record.date, managementKey: record.managementKey }),
        },
      );
      renderCard(record, booking);
    } catch {
      const card = createElement("article", "booking-card");
      card.dataset.bookingCard = "";
      card.dataset.reservationId = record.reservationId;
      const heading = createElement("h2", "", "予約情報を確認できませんでした");
      const message = createElement(
        "p",
        "status",
        "予約情報または管理キーを確認できませんでした。時間を置いて再読み込みするか、この端末から削除してください。",
      );
      const remove = createElement("button", "text-button", "この端末から削除");
      remove.type = "button";
      remove.addEventListener("click", () => removeRecord(record.reservationId));
      card.append(heading, message, remove);
      list.append(card);
    }
  }
  updateEmpty();
  setStatus(
    pageStatus,
    records.length ? `${records.length}件の保存情報を確認しました。` : "このブラウザに保存した予約はありません。",
    records.length ? "success" : "",
  );

  dialogForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value !== "confirm") {
      dialog.close();
      return;
    }
    if (!cancelTarget) return;
    const { record, booking, card } = cancelTarget;
    const button = $("[data-booking-cancel-confirm-button]", dialog);
    let command = cancelCommands.get(record.reservationId);
    if (!command) {
      command = {
        commandId: crypto.randomUUID(),
        date: record.date,
        managementKey: record.managementKey,
      };
      cancelCommands.set(record.reservationId, command);
    }
    button.disabled = true;
    setStatus(dialogStatus, "予約を取り消しています。");
    try {
      const response = await api(`/api/reservations/${encodeURIComponent(record.reservationId)}/cancel`, {
        method: "POST",
        body: JSON.stringify(command),
      });
      cancelCommands.delete(record.reservationId);
      card.remove();
      renderCard(record, response.reservation);
      dialog.close();
      setStatus(
        pageStatus,
        `${formatDateTime(booking.date, booking.startTime)}の予約を取り消しました。保存情報は、この端末から削除するまで残ります。`,
        "success",
      );
      focusWithoutScroll(pageStatus);
    } catch (error) {
      if ([400, 404, 409, 413].includes(error.status)) cancelCommands.delete(record.reservationId);
      setStatus(
        dialogStatus,
        `${error.message}${cancelCommands.has(record.reservationId) ? " 同じ操作で結果を再確認できます。" : ""}`,
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
};

const startAdmin = async () => {
  const authForm = $("[data-owner-auth-form]");
  const authStatus = $("[data-owner-auth-status]");
  const tokenInput = $("#owner-token");
  const logoutButton = $("#logout-button");
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
  let schedule = null;
  let viewDays = 1;
  let selectedReservation = null;
  let ownerAvailability = null;
  let ownerAvailabilitySequence = 0;
  let ownerCreateInFlight = false;
  let ownerCreatePending = readPendingMutation(OWNER_PENDING_CREATE_KEY);
  if (ownerCreatePending?.operation !== "owner-create") {
    clearPendingMutation(OWNER_PENDING_CREATE_KEY);
    ownerCreatePending = null;
  }
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

  const ownerApi = async (path, options = {}) => {
    const token = ownerToken;
    if (!token) throw staleOwnerSessionError();
    const response = await api(path, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...options.headers },
    });
    if (ownerToken !== token) throw staleOwnerSessionError();
    return response;
  };

  const selectedOwnerServiceIds = () =>
    $$("input[name='ownerServiceIds']:checked", ownerServiceList).map(({ value }) => value);

  const clearOwnerCreatePending = () => {
    clearPendingMutation(OWNER_PENDING_CREATE_KEY);
    ownerCreatePending = null;
  };

  const showLoggedOut = (message = "", clearOwnerCreate = false) => {
    ownerToken = "";
    if (clearOwnerCreate) clearOwnerCreatePending();
    closurePending = null;
    commands.clear();
    selectedReservation = null;
    schedule = null;
    logoutButton.hidden = true;
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
    ownerCreateResult.hidden = true;
    ownerManagementKey.textContent = "";
    ownerName.value = "";
    ownerContact.value = "";
    setStatus(scheduleStatus, "");
    setStatus(detailStatus, "");
    setStatus(closureStatus, "");
    setStatus(ownerCreateStatus, "");
    if (message) setStatus(authStatus, message, "error");
    updateOwnerCreateControls();
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
      .find((key) => key.startsWith(`reservation:${reservation.reservationId}:`))
      ?.split(":").at(-1);
    $$("[data-reservation-action]", detail).forEach((button) => {
      const action = button.dataset.reservationAction;
      button.disabled = !allowed.includes(action) || Boolean(pendingAction && action !== pendingAction);
    });
    setStatus(detailStatus, "");
    if (focus) focusWithoutScroll(detail);
  };

  const renderReservationList = (board) => {
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
      open.addEventListener("click", () => renderDetail(reservation, true));
      article.append(heading, summary, customer, badge, open);
      reservationList.append(article);
    }
    $("[data-day-board-summary]").textContent = `${board?.date ?? dateInput.value} / 予約 ${reservations.length}件 / 休業 ${(board?.closures ?? []).filter(({ active }) => active).length}件`;
  };

  const refreshOwnerViews = async (focusReservationId = null) => {
    try {
      await Promise.all([loadSchedule(focusReservationId), loadOwnerAvailability()]);
      return true;
    } catch {
      return false;
    }
  };

  const removeClosure = async (closure, boardDate, button) => {
    if (!window.confirm(`${closure.label}を予定表から解除しますか？`)) return;
    const key = `closure-remove:${closure.closureId}`;
    let command = commands.get(key);
    if (!command) {
      command = { commandId: crypto.randomUUID(), date: boardDate };
      commands.set(key, command);
    }
    button.disabled = true;
    setStatus(closureStatus, "休業時間を解除しています。");
    try {
      await ownerApi(`/api/admin/closures/${encodeURIComponent(closure.closureId)}/remove`, {
        method: "POST",
        body: JSON.stringify(command),
      });
      commands.delete(key);
      const refreshed = await refreshOwnerViews();
      setStatus(
        closureStatus,
        refreshed
          ? "休業時間を解除しました。"
          : "休業時間は解除しましたが、予定表を更新できませんでした。再読み込みしてください。",
        refreshed ? "success" : "error",
      );
      focusWithoutScroll(closureStatus);
    } catch (error) {
      if (handleOwnerError(error)) return;
      if ([400, 404, 409, 413].includes(error.status)) commands.delete(key);
      if (error.status === 409) await loadSchedule();
      setStatus(closureStatus, `${error.message}${commands.has(key) ? " 同じ操作で結果を再確認できます。" : " 予定表を更新しました。"}`, "error");
      focusWithoutScroll(closureStatus);
    } finally {
      button.disabled = false;
    }
  };

  const renderClosures = (board) => {
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
      remove.addEventListener("click", () => void removeClosure(closure, board.date, remove));
      article.append(heading, summary, remove);
      closureList.append(article);
    }
  };

  const renderAttention = () => {
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
      link.href = "/setup.html";
      article.append(link);
      attentionList.append(article);
    }
    if (!attentionList.children.length) {
      attentionList.append(createElement("p", "empty-note", "現在、確認待ちの項目はありません。"));
    }
    attentionCount.textContent = `${schedule?.attentionCount ?? 0}件`;
  };

  const renderWeek = () => {
    weekList.replaceChildren();
    for (const board of schedule?.boards ?? []) {
      const item = createElement("button", "week-summary-item");
      item.type = "button";
      item.append(
        createElement("strong", "", board.date),
        createElement("span", "", `予約 ${board.reservations.length}件 / 休業 ${(board.closures ?? []).filter(({ active }) => active).length}件`),
      );
      item.addEventListener("click", async () => {
        dateInput.value = board.date;
        viewDays = 1;
        await loadSchedule();
        focusWithoutScroll($("[data-schedule-board='day'] h2"));
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

  const loadSchedule = async (focusReservationId = null, requestedDate = dateInput.value) => {
    if (!ownerToken || !requestedDate) return;
    setStatus(scheduleLive, viewDays === 1 ? "1日の予定を読み込んでいます。" : "7日間の予定を読み込んでいます。");
    try {
      schedule = await ownerApi(
        `/api/admin/schedule?startDate=${encodeURIComponent(requestedDate)}&days=${viewDays}`,
      );
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
    } catch (error) {
      if (handleOwnerError(error)) throw error;
      setStatus(scheduleLive, error.message, "error");
      throw error;
    }
  };

  const updateOwnerCreateControls = () => {
    const active = Boolean(ownerCreatePending);
    const authenticated = Boolean(ownerToken);
    dateInput.disabled = !authenticated || active;
    $$("input[name='ownerServiceIds']", ownerServiceList).forEach((input) => {
      input.disabled = !authenticated || active;
    });
    ownerResource.disabled = !authenticated || active || !ownerAvailability;
    ownerTime.disabled = !authenticated || active || ownerTime.options.length === 0;
    ownerName.disabled = !authenticated || active;
    ownerContact.disabled = !authenticated || active;
    ownerCreateButton.disabled = !authenticated || (!active && (
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
    const serviceIds = ownerCreatePending?.request.serviceIds ?? selectedOwnerServiceIds();
    const date = ownerCreatePending?.request.date ?? dateInput.value;
    if (!config || !date || serviceIds.length === 0) {
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
      const loaded = await api(availabilityPath(date, serviceIds));
      if (sequence !== ownerAvailabilitySequence) return;
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
      if (sequence !== ownerAvailabilitySequence) return;
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

  const transitionReservation = async (action) => {
    if (!ownerToken || !selectedReservation) return;
    const reservation = selectedReservation;
    const key = `reservation:${reservation.reservationId}:${action}`;
    let command = commands.get(key);
    if (!command) {
      command = { commandId: crypto.randomUUID(), date: reservation.date, action };
      if (action === "reject") {
        const reason = window.prompt("お客様にも表示する見送り理由を200文字以内で入力してください。");
        if (reason === null) return;
        if (!reason.trim() || Array.from(reason.trim()).length > 200) {
          setStatus(detailStatus, "見送り理由を1〜200文字で入力してください。", "error");
          return;
        }
        command.reason = reason.trim();
      } else if (action === "reschedule") {
        setStatus(detailStatus, "同じ日の空き時間を確認しています。");
        let available;
        try {
          available = await ownerApi(
            availabilityPath(
              reservation.date,
              reservation.services.map(({ id }) => id),
              "/api/admin/availability",
              reservation.reservationId,
            ),
          );
        } catch (error) {
          setStatus(detailStatus, error.message, "error");
          return;
        }
        const resources = available.resources.filter(({ startTimes }) => startTimes.length);
        if (!resources.length) {
          setStatus(detailStatus, "同じ日に移動できる空き時間がありません。", "error");
          return;
        }
        const resourceId = window.prompt(
          `移動先の識別子を入力してください。\n${resources.map(({ id, label }) => `${id}: ${label}`).join("\n")}`,
          resources[0].id,
        );
        if (resourceId === null) return;
        const resource = resources.find(({ id }) => id === resourceId.trim());
        if (!resource) {
          setStatus(detailStatus, "一覧にある担当・設備を選んでください。", "error");
          return;
        }
        const startTime = window.prompt(
          `開始時間を入力してください。\n${resource.startTimes.join(" / ")}`,
          resource.startTimes[0],
        );
        if (startTime === null) return;
        if (!resource.startTimes.includes(startTime.trim())) {
          setStatus(detailStatus, "一覧にある開始時間を選んでください。", "error");
          return;
        }
        command.resourceId = resource.id;
        command.startTime = startTime.trim();
      } else if (["cancel", "no_show"].includes(action)) {
        const message = action === "cancel"
          ? "この予約を取り消します。元に戻せません。続けますか？"
          : "この予約を無断不来として記録しますか？";
        if (!window.confirm(message)) return;
      }
      commands.set(key, command);
    }

    $$("[data-reservation-action]", detail).forEach((button) => {
      button.disabled = true;
    });
    setStatus(detailStatus, `${ACTION_LABELS[action]}を処理しています。`);
    try {
      const response = await ownerApi(
        `/api/admin/reservations/${encodeURIComponent(reservation.reservationId)}/transition`,
        { method: "POST", body: JSON.stringify(command) },
      );
      commands.delete(key);
      const refreshed = await refreshOwnerViews(response.reservation?.reservationId);
      setStatus(
        detailStatus,
        refreshed
          ? `${ACTION_LABELS[action]}を反映しました。`
          : `${ACTION_LABELS[action]}は反映しましたが、予定表を更新できませんでした。再読み込みしてください。`,
        refreshed ? "success" : "error",
      );
    } catch (error) {
      if (handleOwnerError(error)) return;
      if ([400, 404, 409, 413].includes(error.status)) commands.delete(key);
      if (error.status === 409) await loadSchedule(reservation.reservationId).catch(() => {});
      if (selectedReservation) renderDetail(selectedReservation, false);
      setStatus(
        detailStatus,
        `${error.message}${commands.has(key) ? " 同じ操作で結果を再確認できます。" : " 予定表を更新しました。"}`,
        "error",
      );
      focusWithoutScroll(detail);
    }
  };

  try {
    config = await api("/api/config");
    applyPublicConfig(config);
    const today = jstToday();
    dateInput.value = today;
    closureDate.value = today;
    closureDate.min = today;
    closureDate.max = addDays(today, config.schedule.horizonDays - 1);
    renderOwnerServices();
    closureResource.replaceChildren(
      new Option("全体または担当・設備を選択", ""),
      new Option("全体（受付時間すべて）", "__all__"),
    );
    for (const resource of config.resources) closureResource.append(new Option(resource.label, resource.id));
    closureStart.value = config.schedule.opensAt;
    closureEnd.value = config.schedule.closesAt;
    await loadOwnerAvailability();
    showLoggedOut();
  } catch (error) {
    showLoggedOut();
    setStatus(authStatus, error.message, "error");
    return;
  }

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!authForm.reportValidity()) return;
    ownerToken = tokenInput.value;
    tokenInput.value = "";
    setStatus(authStatus, "認証しています。");
    try {
      viewDays = 7;
      await loadSchedule(null, ownerCreatePending?.request.date ?? dateInput.value);
      restoreOwnerCreatePending();
      logoutButton.hidden = false;
      dateInput.disabled = false;
      statusFilter.disabled = false;
      $$("[data-schedule-view]").forEach((button) => {
        button.disabled = false;
      });
      closureFields.disabled = false;
      closureSubmit.disabled = false;
      updateOwnerCreateControls();
      await loadOwnerAvailability();
      restoreOwnerCreatePending();
      setStatus(authStatus, "認証しました。トークンはこのページを閉じると消えます。", "success");
    } catch (error) {
      if (ownerToken) showLoggedOut(error.message);
    }
  });

  logoutButton.addEventListener("click", () => {
    if (ownerCreateInFlight) {
      setStatus(authStatus, "代理予約の結果を確認中です。完了してからログアウトしてください。", "error");
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
  ownerCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ownerToken) {
      setStatus(ownerCreateStatus, "先に運営者認証を行ってください。", "error");
      return;
    }
    if (!ownerCreatePending && (!ownerCreateForm.reportValidity() || selectedOwnerServiceIds().length === 0)) {
      setStatus(ownerCreateStatus, "サービス、担当・設備、開始時間、お客様情報を確認してください。", "error");
      return;
    }
    if (
      !ownerCreatePending &&
      (Array.from(ownerName.value.trim()).length < 1 ||
        Array.from(ownerName.value.trim()).length > 80 ||
        Array.from(ownerContact.value.trim()).length < 3 ||
        Array.from(ownerContact.value.trim()).length > 200)
    ) {
      setStatus(ownerCreateStatus, "お名前は80文字以内、ご連絡先は3〜200文字で入力してください。", "error");
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
        writePendingMutation(candidate, OWNER_PENDING_CREATE_KEY);
        ownerCreatePending = candidate;
        updateOwnerCreateControls();
      }
      setStatus(ownerCreateStatus, ownerCreatePending ? "代理予約の受付結果を確認しています。" : "代理予約を登録しています。");
      await ownerApi("/api/admin/reservations", {
        method: "POST",
        body: JSON.stringify({
          commandId: ownerCreatePending.commandId,
          ...ownerCreatePending.request,
          managementDigest: await digestHex(ownerCreatePending.managementKey),
        }),
      });
      ownerManagementKey.textContent = ownerCreatePending.managementKey;
      ownerCreateResult.hidden = false;
      clearOwnerCreatePending();
      ownerCreateForm.reset();
      ownerAvailability = null;
      const refreshed = await refreshOwnerViews();
      setStatus(
        ownerCreateStatus,
        refreshed
          ? "代理予約を登録しました。管理キーをお客様へ安全にお渡しください。"
          : "代理予約は登録しました。管理キーを安全に渡し、予定表は再読み込みしてください。",
        refreshed ? "success" : "error",
      );
    } catch (error) {
      if (handleOwnerError(error)) return;
      if ([400, 404, 409, 413].includes(error.status)) clearOwnerCreatePending();
      if (error.code === "CONFIGURATION_CONFLICT") {
        try {
          config = await api("/api/config");
          applyPublicConfig(config);
          renderOwnerServices();
        } catch {
          setStatus(ownerCreateStatus, "最新の公開設定を読み込めませんでした。再読み込みしてお試しください。", "error");
          return;
        }
      }
      if (error.status === 409) await Promise.all([loadSchedule().catch(() => {}), loadOwnerAvailability()]);
      setStatus(
        ownerCreateStatus,
        `${error.message}${ownerCreatePending ? " 同じ内容と管理キーで結果を再確認できます。" : ""}`,
        "error",
      );
    } finally {
      ownerCreateInFlight = false;
      logoutButton.disabled = false;
      updateOwnerCreateControls();
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
  closureForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ownerToken || (!closurePending && !closureForm.reportValidity())) return;
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
      await ownerApi("/api/admin/closures", {
        method: "POST",
        body: JSON.stringify(closurePending),
      });
      closurePending = null;
      closureForm.reset();
      closureDate.value = dateInput.value;
      setClosureFullDayHours();
      const refreshed = await refreshOwnerViews();
      setStatus(
        closureStatus,
        refreshed
          ? "休業時間を登録しました。"
          : "休業時間は登録しましたが、予定表を更新できませんでした。再読み込みしてください。",
        refreshed ? "success" : "error",
      );
    } catch (error) {
      if (handleOwnerError(error)) return;
      if ([400, 404, 409, 413].includes(error.status)) closurePending = null;
      if (error.status === 409) await loadSchedule().catch(() => {});
      setStatus(
        closureStatus,
        `${error.message}${closurePending ? " 同じ内容で結果を再確認できます。" : " 予定表を更新しました。"}`,
        "error",
      );
      focusWithoutScroll(closureStatus);
    } finally {
      closureFields.disabled = !ownerToken || Boolean(closurePending);
      closureSubmit.disabled = !ownerToken;
      closureSubmit.textContent = closurePending ? "未確認の登録結果を再確認する" : "休業時間を登録する";
    }
  });
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
  const receiptDownload = createElement("button", "secondary-button", "JSONをダウンロード");
  let ownerToken = "";
  let setupState = null;
  let editingSettings = null;
  let receipt = null;
  let pendingUpdate = null;
  let pendingLive = null;
  let editorId = 0;

  receiptDownload.type = "button";
  receiptDownload.disabled = true;
  receiptCopy.after(receiptDownload);

  const ownerApi = async (path, options = {}) => {
    const token = ownerToken;
    if (!token) throw staleOwnerSessionError();
    const response = await api(path, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...options.headers },
    });
    if (ownerToken !== token) throw staleOwnerSessionError();
    return response;
  };

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
        pattern: "[A-Za-z0-9][A-Za-z0-9._:\\-]{0,63}",
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
        pattern: "[A-Za-z0-9][A-Za-z0-9._:\\-]{0,63}",
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
    try {
      localStorage.setItem(SETUP_STEP_KEY, step);
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
    const authenticated = Boolean(ownerToken && setupState);
    const pending = Boolean(pendingUpdate || pendingLive);
    const accepting = setupState?.mode === "live" && setupState?.readiness?.ready === true;
    fields.disabled = !authenticated || pending;
    saveButton.disabled = !authenticated || pendingLive;
    const canSwitchLive = setupState?.mode === "live" || setupState?.readiness?.ready === true;
    liveButton.disabled = !authenticated || Boolean(pendingUpdate) || !canSwitchLive;
    saveButton.textContent = pendingUpdate ? "未確認の保存結果を再確認する" : "設定を保存する";
    liveButton.textContent = pendingLive
      ? "未確認の切替結果を再確認する"
      : setupState?.mode === "live"
        ? "公開予約を停止してデモに戻す"
        : "公開予約を有効にする";
    setupHelp.textContent = !authenticated
      ? "認証すると、各項目の編集と保存ができるようになります。"
      : pending
        ? "前回の結果が未確認です。同じ操作を再送して確認できます。"
        : accepting
          ? "現在は公開予約を受け付けています。設定変更は新しい版として保存されます。"
          : setupState.mode === "live"
            ? "公開設定は有効ですが、保護設定が不足しているため受付は停止中です。要確認の項目を復旧してください。"
          : setupState.readiness.ready
            ? "4つの準備が完了しました。内容を確認して公開予約を有効にできます。"
            : "要確認の項目を修正して設定を保存してください。";
  };

  const renderSetupState = (state) => {
    setupState = state;
    editingSettings = structuredClone(state.settings);
    applyPublicConfig({ ...state.settings, mode: state.mode });
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
    modeNotice.textContent = accepting
      ? "現在は公開予約を受け付けています。設定変更後も、保存済みの予約内容は書き換わりません。"
      : state.mode === "live"
        ? "公開設定は有効のままですが、保護設定が不足しているため予約受付は停止中です。要確認の項目を復旧してください。"
      : "現在はデモ・設定中です。公開予約は、4つの準備項目がすべて完了するまで有効になりません。";
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
      if (typeof href === "string") link.href = href;
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
    if (!ownerToken) return;
    try {
      renderReceipt(await ownerApi("/api/admin/installation-receipt"));
      setStatus(receiptStatus, "秘密情報を含まない設置受領書を更新しました。", "success");
    } catch (error) {
      if (error.status === 401) showLoggedOut("認証の有効性を確認できませんでした。もう一度認証してください。");
      else setStatus(receiptStatus, error.message, "error");
    }
  };

  const loadSetup = async () => {
    const state = await ownerApi("/api/admin/setup");
    renderSetupState(state);
    return state;
  };

  const showLoggedOut = (message = "") => {
    ownerToken = "";
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
    if (message) setStatus(authStatus, message, "error");
  };

  try {
    const config = await api("/api/config");
    applyPublicConfig(config);
    modeNotice.textContent = config.mode === "live"
      ? "現在は公開予約を受け付けています。運営者として認証すると設定を確認できます。"
      : "現在はデモ・設定中です。公開予約は、4つの準備項目がすべて完了するまで有効になりません。";
  } catch {
    setStatus(authStatus, "公開設定を読み込めませんでした。接続を確認してください。", "error");
  }
  showLoggedOut();
  try {
    const savedStep = localStorage.getItem(SETUP_STEP_KEY);
    setSetupStep(["identity", "schedule", "protection", "review"].includes(savedStep) ? savedStep : "identity");
  } catch {
    setSetupStep("identity");
  }

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!authForm.reportValidity()) return;
    ownerToken = tokenInput.value;
    tokenInput.value = "";
    setStatus(authStatus, "認証して設定を読み込んでいます。");
    try {
      await loadSetup();
      logoutButton.hidden = false;
      await loadReceipt();
      if (!ownerToken) return;
      setStatus(authStatus, "認証しました。トークンはこのページを閉じると消えます。", "success");
    } catch (error) {
      showLoggedOut(error.message);
    }
  });
  logoutButton.addEventListener("click", () => {
    showLoggedOut();
    setStatus(authStatus, "ログアウトしました。", "success");
  });

  form.addEventListener("focusin", (event) => {
    const stage = event.target.closest("[data-setup-step]");
    if (stage) setSetupStep(stage.dataset.setupStep);
  });
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
    renderResourceEditors();
    renderServiceEditors();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ownerToken || !setupState) return;
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
      const state = await ownerApi("/api/admin/setup", {
        method: "PUT",
        body: JSON.stringify(pendingUpdate),
      });
      pendingUpdate = null;
      renderSetupState(state);
      await loadReceipt();
      setStatus(
        setupStatus,
        state.replayed ? "同じ設定の保存結果を確認しました。" : `設定バージョン ${state.settingsVersion} として保存しました。`,
        "success",
      );
    } catch (error) {
      if ([400, 401, 409, 413].includes(error.status)) pendingUpdate = null;
      if (error.status === 401) {
        showLoggedOut("認証の有効性を確認できませんでした。もう一度認証してください。");
        return;
      }
      if (error.code === "CONFIGURATION_CONFLICT") {
        await loadSetup().catch(() => {});
        setStatus(setupStatus, "ほかの画面で設定が更新されました。最新の内容を読み込みました。もう一度確認してください。", "error");
        focusWithoutScroll(setupStatus);
      } else {
        setStatus(setupStatus, `${error.message}${pendingUpdate ? " 同じ設定で結果を再確認できます。" : ""}`, "error");
      }
    } finally {
      updateSetupControls();
    }
  });

  liveButton.addEventListener("click", async () => {
    if (!ownerToken || !setupState) return;
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
      const state = await ownerApi("/api/admin/setup/live", {
        method: "POST",
        body: JSON.stringify(pendingLive),
      });
      pendingLive = null;
      renderSetupState(state);
      await loadReceipt();
      setStatus(setupStatus, state.mode === "live" ? "公開予約を有効にしました。" : "公開予約を停止し、デモへ戻しました。", "success");
    } catch (error) {
      if ([400, 401, 409, 413].includes(error.status)) pendingLive = null;
      if (error.status === 401) {
        showLoggedOut("認証の有効性を確認できませんでした。もう一度認証してください。");
        return;
      }
      if (error.code === "CONFIGURATION_CONFLICT") await loadSetup().catch(() => {});
      setStatus(setupStatus, `${error.message}${pendingLive ? " 同じ操作で結果を再確認できます。" : ""}`, "error");
    } finally {
      updateSetupControls();
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
    link.download = `salon-reservation-installation-receipt-v${receipt.settingsVersion}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(receiptStatus, "設置受領書をダウンロードしました。", "success");
  });
};

const startLegal = async () => {
  const modeNotice = $("[data-legal-mode-notice]");
  try {
    const config = await api("/api/config");
    applyPublicConfig(config);
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
  } catch {
    modeNotice.hidden = false;
    modeNotice.textContent = "現在、運営者が設定した案内を取得できません。予約を送信せず、時間を置いて再確認してください。";
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
  starter().catch(() => {
    const status = $("[role='status']");
    setStatus(status, "画面を準備できませんでした。再読み込みしてお試しください。", "error");
  });
}
