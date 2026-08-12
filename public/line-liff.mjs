// LINE 連携ページの手続き。/line.html と一緒に、アダプタが有効なときだけ
// Worker から配信されます。連携トークンは予約管理ページが sessionStorage に
// 置いた一時的な値だけを使い、URL からは何も受け取りません。
// (?liff.state= は LINE ログインが付ける値ですが、このページは一切利用しない
// ことで外部誘導の余地をなくしています。)

const INTENT_STORAGE_KEY = "salon-reservation:line-link-intent:v1";

const statusElement = document.querySelector("[data-line-status]");
const backLink = document.querySelector("[data-line-back]");

const show = (message, done = false) => {
  statusElement.textContent = message;
  if (done) backLink.hidden = false;
};

const readIntent = () => {
  let raw = null;
  try {
    raw = sessionStorage.getItem(INTENT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw.length > 512) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.nonce !== "string" ||
      !/^[0-9a-f]{32}$/.test(parsed.nonce) ||
      !Number.isSafeInteger(parsed.expiresAt)
    ) {
      return null;
    }
    if (parsed.expiresAt < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
};

const api = async (path, body) => {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    // A non-JSON reply is treated as a transient failure below.
  }
  return { ok: response.ok, status: response.status, body: parsed };
};

const run = async () => {
  const intent = readIntent();
  if (intent === null) {
    show(
      "連携の有効期限が切れたか、手続きの情報が見つかりませんでした。予約管理ページからもう一度お進みください。",
      true,
    );
    return;
  }

  const configResponse = await fetch("/api/config", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!configResponse.ok) {
    show("設定を確認できませんでした。しばらく待ってからお試しください。", true);
    return;
  }
  const config = await configResponse.json();
  if (typeof config?.locationName === "string" && config.locationName.length > 0) {
    for (const element of document.querySelectorAll("[data-location-name]")) {
      element.textContent = config.locationName;
    }
  }
  const liffId = config?.lineAdapter?.liffId;
  if (typeof liffId !== "string") {
    show("現在 LINE 連携はご利用いただけません。", true);
    return;
  }

  if (typeof globalThis.liff === "undefined") {
    show("LINE の読み込みに失敗しました。通信環境を確認して再読み込みしてください。", true);
    return;
  }

  try {
    await globalThis.liff.init({ liffId });
  } catch {
    show("LINE との接続を開始できませんでした。しばらく待ってからお試しください。", true);
    return;
  }

  if (!globalThis.liff.isLoggedIn()) {
    show("LINE のログイン画面へ移動します。");
    // 固定の同一オリジン URL のみ。クエリは引き継ぎません。
    globalThis.liff.login({ redirectUri: `${window.location.origin}/line.html` });
    return;
  }

  const idToken = globalThis.liff.getIDToken();
  if (typeof idToken !== "string" || idToken.length === 0) {
    show("LINE のログイン情報を確認できませんでした。もう一度お試しください。", true);
    return;
  }

  show("連携を確認しています。");
  const result = await api("/api/adapters/line/link", {
    nonce: intent.nonce,
    idToken,
  });
  try {
    sessionStorage.removeItem(INTENT_STORAGE_KEY);
  } catch {
    // 消せなくても期限切れで無効になります。
  }
  if (result.ok) {
    show("連携が完了しました。予約の状態が変わると LINE でお知らせします。", true);
    return;
  }
  if (result.status === 409) {
    show(
      result.body?.error?.message ??
        "この予約には別の LINE アカウントが連携されています。予約管理ページで連携を解除してからやり直してください。",
      true,
    );
    return;
  }
  if (result.status === 404) {
    show("連携の有効期限が切れました。予約管理ページからもう一度お進みください。", true);
    return;
  }
  show("現在連携を完了できません。しばらく待ってから、予約管理ページよりお試しください。", true);
};

void run();
