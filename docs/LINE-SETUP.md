<a id="line-adapter-setup-operator-walkthrough"></a>
# LINE ログインと通知を設定する

LINE は任意の連携です。新しい場所では無効になっており、この手順を行わなくても予約サイトを使えます。
まず [Cloudflare の公開準備](CLOUDFLARE.md#demo-first-then-live-readiness)を完了してください。
1 つの共通 provider で `default` と個別に有効にした名前付きの場所を扱いますが、予約ごとの顧客同意が必要です。
場所ごとの操作は[複数店舗ガイド](MULTI-LOCATION.md#optional-line-per-location)も参照してください。

以下は運営者が自分の導入先で実施する手順です。リポジトリ、テスト用 fixture、CI は実際の LINE チャネルに接続しません。
このページの ID は架空の例です。実際のチャネル ID、channel secret、LIFF ID を公開リポジトリ、Issue、ログに残さないでください。

<a id="what-you-create-on-the-line-side"></a>
## 同じ provider にログイン用と通知用のチャネルを用意する

1. [LINE Developers コンソール](https://developers.line.biz/)で、自分が管理する provider を用意します。
   ログイン用と Messaging API 用には必ず同じ provider を使います。
   LINE user ID は provider ごとに異なり、作成後のチャネルを別 provider に移せません。
   詳細は[チャネルと provider の注意事項](https://developers.line.biz/en/docs/line-mini-app/develop/develop-overview/)を参照してください。
2. ログイン用の **LINE MINI App** チャネルを作成します。
   LINE は新しい LIFF アプリを MINI App として作成することを推奨しています。
   利用条件が合わない場合は、従来の **LINE Login** チャネルに LIFF アプリを追加する方法も、このアダプターで使えます。
   作成条件と公開・認証による制限は、[現在の LIFF 登録ガイド](https://developers.line.biz/en/docs/liff/registering-liff-apps/)で確認してください。
   このアダプターは MINI App の service message 機能を使わず、Messaging API で通知します。
3. ログイン用の **channel ID** と **LIFF ID** を控えます。
   endpoint URL は `https://<自分のホスト名>/line.html` にします。
   従来の LINE Login + LIFF を使う場合は、LIFF の **Scope** で `openid` を必ず選択します。
   本アプリは `liff.getIDToken()` を使うため、`openid` の許可がないと連携できません。
   [LIFF API リファレンス](https://developers.line.biz/ja/reference/liff/#get-id-token)を参照してください。
4. 通知用の **LINE 公式アカウント**を作成します。
   **LINE Official Account Manager** で Messaging API を有効にし、手順 1 と同じ provider を選択します。
   その後 LINE Developers コンソールで、生成された Messaging API チャネルの **channel ID** と **channel secret** を控えます。
   Messaging API チャネルは Developers コンソールから直接作成できません。
   [公式の開始手順](https://developers.line.biz/en/docs/messaging-api/getting-started/)に従ってください。
5. Messaging API の webhook URL を `https://<自分のホスト名>/api/adapters/line/webhook` にし、webhook を有効にします。
   不要な自動応答は LINE 側で無効にしてください。webhook URL に `location` は付けません。

<a id="the-one-secret"></a>
## Messaging API の Secret を登録する

Worker に保存する LINE の Secret は、Messaging API の **channel secret** だけです。
対象 Worker のダッシュボードの Secret 欄に `LINE_MESSAGING_CHANNEL_SECRET` として入力します。
CLI を使う場合は、自分の公開ソースのディレクトリで、`my-salon-reservations` を実際の Worker 名に置き換えて対話入力します。

```sh
npx wrangler secret put LINE_MESSAGING_CHANNEL_SECRET --name my-salon-reservations
```

値を `wrangler.jsonc`、`.dev.vars.example`、コマンド引数、シェル履歴、Git に残さないでください。
この Secret は必須 Secret の一覧に含まれません。未設定なら LINE の操作は顧客画面に出ません。
有効化後に Secret が失われると、既存の連携を確認・解除するだけの cleanup モードになります。
通知は送らず、設定状態に劣化を表示します。Secret を復旧するまでこの状態が続きます。

<a id="enabling"></a>
## オーナー API で有効にする

以下は `location` を省略した `default` の例です。
API クライアントに運営者の Bearer トークンを設定します。トークンや Authorization ヘッダーをログに残さないでください。
変更リクエストは `Content-Type: application/json` と、導入先に一致する `Origin: https://<自分のホスト名>` を必要とします。

1. `GET /api/admin/line/status` で `phase` と現在の `lifecycleVersion`、配送診断を確認します。
2. 無効の間に `POST /api/admin/line/settings` で識別子を保存します。
   次の JSON の ID は自分の値に、version は直前に読んだ値に、`commandId` は新しい UUID に置き換えます。

   ```json
   {
     "commandId": "550e8400-e29b-41d4-a716-446655440000",
     "expectedLifecycleVersion": 0,
     "identifiers": {
       "liffId": "1234567890-abcdefgh",
       "loginChannelId": "1234567890",
       "messagingChannelId": "9876543210"
     }
   }
   ```

3. status を読み直し、`POST /api/admin/line/enable` を送ります。
   Secret が必要です。このリクエストの識別子が有効化の正本となり、有効な間は変更できません。

   ```json
   {
     "commandId": "550e8400-e29b-41d4-a716-446655440001",
     "expectedLifecycleVersion": 1,
     "identifiers": {
       "liffId": "1234567890-abcdefgh",
       "loginChannelId": "1234567890",
       "messagingChannelId": "9876543210"
     }
   }
   ```

4. status で有効化の結果を確認します。

version の `0` と `1` は例です。各操作の前に status の最新値を使ってください。
別の操作には新しい UUID を使います。応答を受け取れず結果が不明な同一操作の再送では、保存した同じ `commandId` と同じ本文を使います。
同じ ID は記録済みの結果を返します。識別子を変更する場合は無効化してから再度有効化します。

有効化には公開準備の保護条件も必要です。`allowedHostname` と対応する Turnstile 設定が未完了なら `ORIGIN_UNCONFIGURED` になります。
通知には予約の管理 URL を含めません。

<a id="named-locations-and-the-shared-webhook"></a>
## 名前付きの場所を設定する

名前付きの場所では、既存の status、settings、enable、disable の各オーナー API に `?location=<id>` を付けます。
各コマンドには、その場所の現在の `lifecycleVersion` を使います。新しい場所の LINE は無効です。
有効・有効化中・無効化中の識別子は共通の provider 設定と一致する必要があり、S4 は 2 つ目の LINE アカウントを追加しません。

登録する `/api/adapters/line/webhook` は全場所で共通で、`location` を付けません。
生の本文の署名を 1 回検証し、有効または処理中の actor にのみ渡します。
ある actor が失敗して LINE が再送しても、各 actor の重複排除により受付済みの場所へ二重送信しません。

顧客は予約が属する場所で明示的に連携します。同じ LINE user ID でも、別の場所へ同意や連携を自動的に引き継ぎません。
名前付きの場所の通知には検証済みの公開表示名を含め、`default` の v1 通知の内容は維持します。
LIFF の戻り先は名前付きなら `/line.html?location=<id>`、`default` なら `/line.html` です。
どちらにも予約の管理キーやトークンを付けません。

<a id="-regional-message-quotas-and-pricing"></a>
<a id="regional-message-quotas-and-pricing"></a>
## 地域ごとの配信上限と料金を確認する

Messaging API のプランと上限は国・地域ごとに異なります。
日本課金のコミュニケーションプランは、現在は月 200 通までで追加購入ができず、上限で配送が止まります。
他の地域やプランにはこの数字を当てはめず、[現在の地域別料金](https://developers.line.biz/en/docs/messaging-api/pricing/)で確認してください。
月に数百件の予約があれば、このプランの枠を超える可能性があります。

月間上限と一時的なレート制限は、どちらも HTTP 429 になります。
LINE の再試行方針では 4xx を再試行しないため、このアダプターはその試行を終端状態 `rejected` として記録し、診断 ledger に HTTP 429 を残します。
配送の成功にかかわらず、予約の状態は顧客の予約管理画面に表示されます。通知を唯一の記録にしないでください。

<a id="verifying-a-live-channel-operator-side-only"></a>
## 自分のチャネルで動作を確認する

CI の根拠は fixture によるプロトコル検証です。別途許可された自分の導入先で実チャネルを確認する場合は、架空の予約を使います。

1. `https://<自分のホスト名>/` で架空の予約を作り、予約管理画面で「LINE で通知を受け取る」を選びます。
2. LINE ログインを完了し、画面で連携済みになったことを確認します。
3. 管理画面で予約を承認し、日付・サービス名・状態の LINE 通知を確認します。
4. `/api/admin/line/status` の配送件数と終端失敗を確認します。
5. 署名のない不正リクエストが webhook で拒否され、署名失敗のカウンター以外に変更がないことを確認します。

<a id="rotation-and-disabling"></a>
## Secret を更新する、連携を無効にする

Secret を更新する場合は LINE 側で更新し、対象 Worker の `LINE_MESSAGING_CHANNEL_SECRET` を新しい値に置き換えます。
ダッシュボードか、同じディレクトリ・Worker 名で次の対話入力を使います。

```sh
npx wrangler secret put LINE_MESSAGING_CHANNEL_SECRET --name my-salon-reservations
```

LINE 側で旧値が残る方式なら、Worker 更新後に旧値を失効させます。
配送中の処理は新しい認証情報で再試行します。切り替えの空白期間には、有効な全場所が cleanup モードを表示します。

無効にする場合は status を読み直し、`POST /api/admin/line/disable` に次の **2 フィールドだけ**を送ります。
名前付きなら `?location=<id>` を付けます。`identifiers` は送らないでください。

```json
{
  "commandId": "550e8400-e29b-41d4-a716-446655440002",
  "expectedLifecycleVersion": 2
}
```

UUID と version は例です。新しい操作には新しい UUID、version には最新 status の値を使います。
結果不明の同一操作を再送する場合は、同じ ID と本文を使います。
その場所は `deactivating` となり、待機中の処理を取り消して、連携、subject、未配送分、日別 outbox を削除した後に `disabled` になります。
1 つの場所の無効化は他の有効な場所に影響しません。共通 Secret は、**すべての場所が `disabled` になってから**削除します。
再有効化は新しい世代を使い、以前の配送を復活させません。

<a id="updating-the-pinned-liff-sdk"></a>
## 固定した LIFF SDK を更新する

`public/line.html` の LIFF SDK は、バージョン付き URL と subresource integrity で固定しています。
更新は PR で行い、URL のバージョンと取得ファイルの `integrity` hash を同時に更新して、ブラウザーのテストを実行します。
edge チャネルへの追従には変更しないでください。
