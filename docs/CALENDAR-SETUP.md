<a id="optional-calendar-setup"></a>
# カレンダーへの予約表示を設定する

カレンダー連携は任意で、新しい場所では無効です。まず [Cloudflare の導入](CLOUDFLARE.md)を完了してください。
予定を見るだけなら、最初に iCalendar の購読フィードを使います。
Google Calendar へ予定を直接書き込みたい場合だけ、後半の OAuth 設定を追加します。
どちらも空き枠の判定には使わず、顧客画面に追加の操作は出しません。

次の 2 つは独立して有効にできます。

- iCalendar の認証付き購読。`default` は `CALENDAR_FEED_TOKEN`、名前付きの場所は運営者が発行した購読トークンを使います。
- Google Calendar への一方向同期。`GOOGLE_CALENDAR_CREDENTIALS` は共通で、名前付きの場所はそれぞれ別の変更できない送信先 ID を使います。

以下の外部操作は、自分の導入先で実施する手順です。開発や CI に Cloudflare・Google アカウントは不要です。
Durable Objects、iCalendar、OAuth、再試行、ブラウザーの検証は、架空の fixture と固定 endpoint の mock でローカル実行します。
テストのためだけに外部アカウントを作らないでください。

<a id="default-location-icalendar-subscription"></a>
## default の予約を iCalendar で購読する

1. `OWNER_TOKEN` とは別に、32 バイトの乱数から base64url の購読トークンを生成します。
   出力を記録・共有しない自分の端末なら、次の例を使えます。

   ```sh
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
   ```

   結果はちょうど 43 文字です。パスワードマネージャーに保存してください。
2. 自分の Worker のダッシュボードの Secret 欄に `CALENDAR_FEED_TOKEN` として入力します。
   CLI を使う場合は、自分の公開ソースのディレクトリで、`my-salon-reservations` を実際の Worker 名に置き換えて対話入力します。

   ```sh
   npx wrangler secret put CALENDAR_FEED_TOKEN --name my-salon-reservations
   ```

3. 許可された自分の導入先へ Secret が反映されたら、カレンダーアプリの URL 購読に次の値を登録します。

   ```text
   https://<自分のホスト名>/api/adapters/calendar/feed.ics?token=<43文字の購読トークン>
   ```

`location` のない URL は `default` 専用です。トークンを知る人は、予約の開始・終了、サービス名、仮予約・確定の状態、
安定した不透明な event UID、イベントの作成日時を読めます。
完成した URL も秘密として扱い、Git、Issue、メッセージ、スクリーンショット、referrer、アクセス解析、コマンド出力に残さないでください。

更新する場合は、新しい値を同じ Secret 名で登録します。新しい binding が有効になった時点で旧 URL は無効になり、
無効・停止中のリクエストと同じ 404 を返します。応答は `private, no-store` ですが、カレンダーアプリに以前の予定が残る場合があります。
必要なら旧購読を削除してください。フィードは storage 処理の前に公開 API の rate limit を適用し、制限された場合も同じ 404 を返します。

<a id="named-location-feed-and-target-controls"></a>
## 名前付きの場所の購読と送信先を設定する

1. `/setup.html` で運営者として認証し、対象の場所を選びます。
2. 「カレンダー連携」の「購読トークンを発行・再発行する」を押します。
   トークンは発行時だけ表示します。保存してください。storage には digest だけを保存します。
3. そのトークンと場所 ID で次の URL を組み立て、目的のカレンダーアプリで購読します。
   設定画面がコピーするのはトークンで、完成した URL ではありません。

   ```text
   https://<自分のホスト名>/api/adapters/calendar/feed.ics?location=<id>&token=<発行した購読トークン>
   ```

4. 同じ場所の「この場所の予約予定の購読フィードを有効にする」を選択し、設定を保存します。
   `default` のトークンでは名前付きのフィードを読めません。
5. Google 同期も使う場合は、共通認証情報で書き込める、その場所専用のカレンダー ID を指定してから有効にします。
   **一度登録した名前付きの送信先は、無効の間も変更できません。**
   待機中の書き込みや削除が別カレンダーへ向かうことを防ぐためです。

API では `POST /api/admin/calendar/feed-token?location=<id>` に現在の version を送ります。
新規の例は `{"expectedVersion":0}` です。応答の `{version,token}` は 1 回だけ返ります。
応答を失った場合は status を読み直して明示的に再発行します。
設定 API は `PUT /api/admin/calendar/settings?location=<id>` で、本文は `{expectedVersion,googleEnabled,calendarId,feedEnabled}` です。
名前付き status は設定 version と許可された項目を返し、トークン、digest、認証情報は返しません。
詳細な順序とエラーは[場所ごとの操作ガイド](MULTI-LOCATION.md#optional-calendar-per-location)を参照してください。

<a id="google-outbound-synchronization"></a>
## 必要な場合だけ Google への一方向同期を追加する

このアダプターは予定を書き込むだけです。予定の一覧取得、取り込み、watch、free/busy による空き枠判定は行いません。
Google の refresh token はアプリの外で運営者が用意します。本アプリに OAuth 認可や token 発行の画面はありません。

1. 自分の Google Cloud プロジェクトで Google Calendar API を有効にし、対象の運営者アカウント向けに OAuth 同意画面を設定します。
2. OAuth client を作り、対象カレンダーを所有するか書き込めるアカウントで同意を完了します。
   [Google の OAuth 手順](https://developers.google.com/identity/protocols/oauth2/web-server)に従い、offline access を要求します。
   scope は `https://www.googleapis.com/auth/calendar.events` だけを要求します。
   [Calendar の scope 一覧](https://developers.google.com/workspace/calendar/api/auth)も確認してください。
   同意設定が testing の場合は対象アカウントを test user に含め、現在の refresh token の制限を確認してから運用に使います。
3. client ID、client secret、refresh token、**default の**送信先カレンダー ID を、追加キーなしの次の JSON 形式にします。
   以下は実際には使えない架空値です。

   ```json
   {
     "clientId": "fixture.apps.googleusercontent.com",
     "clientSecret": "fixture-only",
     "refreshToken": "fixture-only",
     "calendarId": "fixture@example.invalid"
   }
   ```

4. 実際の JSON を、自分の Worker の Secret `GOOGLE_CALENDAR_CREDENTIALS` に入力します。
   CLI を使う場合は、対象ソースのディレクトリと実際の Worker 名を確認し、対話入力します。

   ```sh
   npx wrangler secret put GOOGLE_CALENDAR_CREDENTIALS --name my-salon-reservations
   ```

   `.dev.vars.example`、コマンド引数、Git、サポート Issue、ログに実値を残さないでください。
5. Secret の反映後、後述の再同期を実行します。名前付きの場所は先に専用の送信先を設定して Google 同期を有効にします。

Worker は Google の固定 token endpoint でだけ refresh token を交換し、access token は isolate のメモリーに保持します。
書き込むのは開始・終了、サービス名、仮予約・確定の状態、元の予約 ID を復元できない安定した event ID です。
redirect や利用者が指定した provider URL は追従しません。

<a id="credential-and-target-calendar-changes"></a>
### 認証情報や送信先を変更する

- 同じ送信先の client secret や refresh token を更新する場合は、正確な JSON を再登録して再同期します。
  現在の予定は安定した event ID で再びキューに入ります。
- **default の `calendarId` の変更では、旧カレンダーの予定を移動・削除しません。**
  旧アカウントの権限が残る間に専用の予定を確認し、手動で削除します。
  この導入専用のカレンダーなら、カレンダー自体の削除も運営者が判断します。
  その後 Secret を変更して再同期してください。旧権限が失われていれば、旧カレンダーの片付けは別途運営者が行います。
  アプリは新しい認証情報で安全に旧送信先を操作できません。
- 名前付きの送信先は最初の登録後に変更できません。別の場所を作るのは実際に別店舗である場合に限ります。
  送信先移行の代わりに場所を追加しないでください。
- 共通 Google Secret の削除や無効化は新しい Google 呼び出しを止めます。
  予約データは正本のまま残り、予約受付を続けられます。有効な認証情報を復旧して再同期してください。
  名前付きの有効設定を、認証障害だけで無効化・削除することはありません。

名前付きには、Google の設定から取得した実際のカレンダー ID を使います。
`primary` は[現在のユーザーの主カレンダーを表す別名](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)なので、独立した名前付き送信先を確定できません。
`default` はこの別名にも対応しますが、名前付き Google 同期を使う場合は共通設定の default 送信先にも実 ID が必要です。
後から共通送信先と衝突すると、名前付きの送信は再試行待ちになります。モードの無効化や状態の削除は行いません。
名前付き iCalendar は Google 認証情報を必要としません。

<a id="status-and-bounded-reconciliation"></a>
## 状態を確認し、範囲を区切って再同期する

次の API には運営者の Bearer トークンが必要です。名前付きは `?location=<id>` を付け、省略時は `default` になります。
再同期は同一 origin のリクエストを必要とし、運営者用 rate limit を適用します。

```text
GET  /api/admin/calendar/status
POST /api/admin/calendar/reconcile
```

status はモードの有効状態、集計数、cursor、秘匿化した ledger の理由を返します。
`default` は既存の応答形式を維持し、カレンダー ID を返しません。
名前付きは `settings:{version,googleEnabled,calendarId,feedEnabled,feedTokenPresent}` も返します。
フィードトークン・digest、Google 認証情報、予約 ID、event ID、provider の本文、Authorization ヘッダーは返しません。

初回有効化、認証情報の復旧、イベント引き渡しの欠落の疑い、default の送信先変更後に、次の順で再同期します。

1. reconcile に `{}` を送ります。日付を指定して続ける場合は `{"cursor":"YYYY-MM-DD"}` を送ります。
2. 応答の `nextCursor` が `null` になるまで、その値を次の `cursor` として繰り返します。
   同じページの再実行は冪等です。

1 リクエストは選択した場所の最大 7 日の正本を読み、仮予約の期限切れも適用します。
provider 変更処理の上限が一時的に埋まると、未処理の日付の直前で止まり、同じ日付を `nextCursor` に返します。
待機処理が進んでから再試行してください。失敗した upsert は新しい処理に容量を譲ります。
未完了・未解決の削除処理は保持しますが、取り消した予約は Google の容量を待たずに iCalendar から消えます。

有効な Google 設定での再同期は、ローカルの projection がなくても、保持中の失敗・設定待ちの削除を再度キューに入れます。
通常の回復でも、カレンダー actor の alarm が保持期限と対象期間の固定範囲を sweep します。

<a id="disable-and-recovery-boundary"></a>
## 連携を止め、保持中の処理を削除する

`default` は 2 つの任意 Secret を両方削除すると、フィードのアクセスと新しい provider 呼び出しを止め、ローカルの削除処理を開始します。
名前付きは、その場所の設定で購読フィードと Google 同期を無効にします。
共通 Google Secret の削除は認証障害であり、場所ごとの無効化の代わりにはなりません。

既存 descriptor の lease が期限切れになった後、固定範囲の sweep が calendar outbox、projection、mutation、診断記録を削除します。
完了して `disabled` になるまでプライバシー表示は残ります。
Secret の削除では、カレンダーアプリが保存したコピーや、旧権限を失った Google カレンダーの予定まで消去したとは保証できません。

この間に `CalendarAdapter` クラスや namespace を削除しないでください。
互換性のある切り戻しは、クラス、export、binding、alarm の処理を残した新しいビルドを前方にデプロイする方法です。
status が `disabled` となり、保持中の処理がなくなるまで維持します。

<a id="optional-live-smoke"></a>
## 任意で自分の導入先を確認する

開発で必須の根拠はローカル fixture です。運営者が別途許可して自分の導入を完了した後なら、
架空の予約 1 件でフィードまたは専用テストカレンダーを確認できます。
予定情報だけの payload を確認し、予約を取り消して予定が消えることを確認します。
終了後は架空の provider event を削除し、一時認証情報を更新してください。
この任意の確認手順は、開発タスクから外部デプロイを行う許可ではありません。
