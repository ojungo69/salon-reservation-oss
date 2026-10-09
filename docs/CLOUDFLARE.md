<a id="cloudflare-deployment-and-operations"></a>
# Cloudflare に自分の予約サイトを導入する

公開リポジトリを自分の Cloudflare アカウントに導入する運営者向けの手順です。
まず架空データのデモを開き、公開準備が整ってから実際の予約を受け付けます。
LINE とカレンダーは任意です。導入時には設定しなくて構いません。
場所とスタッフの設定は[複数店舗ガイド](MULTI-LOCATION.md)を参照してください。

以下のアカウント操作とコマンドは、自分の導入先で実施する例です。
この文書や開発作業自体が、既存の本番環境の変更を許可するものではありません。
料金・制限・ドメイン設定は、操作前にリンク先の Cloudflare 公式資料で確認してください。

<a id="deployment-contract"></a>
## デプロイボタンで導入する

1. パスワードマネージャーで、32 バイト以上の乱数に相当する推測困難な運営者トークンを生成し、保存します。
   この保存済みの値を、デプロイと後の設定画面のログインに共通で使います。
   `OWNER_TOKEN` は公開リポジトリ、URL、シェル履歴、ログ、設定受領書に残さないでください。
2. [README の Deploy to Cloudflare ボタン](../README.md)を開き、自分のアカウントと導入先を確認します。
   ボタンはこの公開リポジトリのコピーを導入します。既存の予約サイトやデータへのアクセス権は付与しません。
3. デプロイフォームの `OWNER_TOKEN` のサンプルを、保存した運営者トークンで置き換えます。
   `TURNSTILE_SECRET` の公開テスト値は、架空データのデモの間だけ使えます。
   後で変更する場合も、この方法で導入した人は対象 Worker のダッシュボードの Secret 欄から入力できます。
4. [Workers Builds の設定](#workers-builds)を確認してビルドします。
   完了したら表示された Worker と作成リソースを確認し、[デモを開く](#demo-first-then-live-readiness)へ進みます。

[Deploy ボタンの公式説明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)も参照してください。
このプロジェクトは Worker、静的ファイル、レート制限、SQLite Durable Objects を Wrangler 設定で定義します。
D1 データベースの作成、データベースコンソールでの SQL 実行、通常の初回導入のためのソース編集は不要です。
実際の作成結果は Cloudflare 側で確認してください。特定のアカウント状態を保証するものではありません。

必須 Secret は `OWNER_TOKEN` と `TURNSTILE_SECRET` です。
`CalendarAdapter` は共通の SQLite Durable Object クラスで、設定した場所ごとに別の actor を持ちます。
`default` は任意 Secret を使い、名前付きの場所は独立した設定とフィードトークンを使います。
Google の認証情報は共通です。詳細は[カレンダー設定](CALENDAR-SETUP.md)を参照してください。
クラスと export は、将来の更新・切り戻しでも保持します。

2 つのレート制限 namespace ID は Cloudflare のサンプルとは別の値です。
同じアカウントの別 Worker が同じ ID を使うとカウンターを共有します。
既存リソースと衝突する場合は、導入前に自分のコピーで未使用の正の整数を 2 つ割り当ててください。

<a id="workers-builds"></a>
## Workers Builds の npm を設定する

このプロジェクトには [`.nvmrc`](../.nvmrc) の Node.js と npm `12.0.2` が必要です。
`.nvmrc` で Node.js を選んでも、Cloudflare のビルド環境の npm が 12 になるとは限りません。
自分の Worker の **Settings > Build** で、次の設定を確認します。

- **Build Variables and Secrets** に `SKIP_DEPENDENCY_INSTALL=1` を追加します。
- ビルドコマンドを次の値にします。

  ```sh
  npm install -g --ignore-scripts npm@12.0.2 && npm ci --ignore-scripts && npm run build
  ```

- デプロイコマンドを `npx wrangler deploy` にします。

自動の依存インストールを止め、npm 12 を選んでから依存をインストールする順序です。
`npm run build` はローカルのバンドル検証で、デプロイコマンドが Cloudflare に反映します。
設定項目は[ビルドイメージの公式資料](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)を参照してください。
初回フォームでこれらを設定できない場合は、[CLI 手順](#cli-setup)を使うか、初回ビルドの失敗後に自分の Worker の設定を修正して再実行します。
デプロイボタンの初期値だけでビルドが通るとは限りません。

<a id="cli-setup"></a>
## CLIで導入する

デプロイボタンの代わりに端末から導入する場合の手順です。Git と、`.nvmrc` の Node.js を用意してください。
以下は新しい自分用 Worker を作る例です。`my-salon-reservations` を自分の Worker 名に置き換え、既存の本番 Worker を誤って指定しないでください。

1. 公開ソースを取得し、そのディレクトリで作業します。

   ```sh
   git clone https://github.com/ojungo69/salon-reservation-oss.git
   cd salon-reservation-oss
   ```

2. `.nvmrc` の Node.js を選びます。nvm を導入済みなら、次のコマンドを使えます。
   nvm を使わない場合も同じバージョンを用意します。

   ```sh
   nvm install
   nvm use
   ```

3. npm を明示的に選び、依存をインストールします。Wrangler のグローバルインストールは不要です。

   ```sh
   npm install -g --ignore-scripts npm@12.0.2
   npm --version
   npm ci
   ```

   `npm --version` が `12.0.2` であることを確認します。理由は[ツールチェーン](../CONTRIBUTING.md#toolchain)を参照してください。

4. 自分の Cloudflare アカウントにログインし、バンドルを検証します。

   ```sh
   npx wrangler login
   npm run build
   ```

5. [保存した運営者トークン](#deployment-contract)と Turnstile Secret を対話入力します。
   デモの Turnstile Secret には、公式の[テスト用キー](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)を使えます。
   実際の予約には後述の実キーが必要です。

   ```sh
   npx wrangler secret put OWNER_TOKEN --name my-salon-reservations
   npx wrangler secret put TURNSTILE_SECRET --name my-salon-reservations
   ```

   新規 Worker の作成確認が出たら、アカウントと名前を確認して進めます。
   トークンをコマンド引数やパイプで渡さず、保存した値を入力してください。
   デプロイボタンで作った Worker を CLI から更新する場合も、このリポジトリのディレクトリで、実際の Worker 名を `--name` に指定します。
   [必須 Secret がないデプロイは失敗します](https://developers.cloudflare.com/workers/configuration/secrets/)。

6. 同じ Worker 名へデプロイします。

   ```sh
   npx wrangler deploy --name my-salon-reservations
   ```

表示された導入先を確認し、次の公開準備へ進みます。Secret 値やアカウント識別子を含む出力を公開しないでください。

<a id="demo-first-then-live-readiness"></a>
## デモを開き、公開準備を完了する

1. デプロイで割り当てられた `workers.dev` URL があれば開き、架空データの画面を確認します。
   デモ・設定中は予約変更が拒否されます。実在するお客様の情報を入力しないでください。
2. `https://<自分のホスト名>/setup.html` を開き、保存した `OWNER_TOKEN` と同じ値で認証します。
   新しく別の値を生成してログインするのではなく、Worker に登録した値を使います。
3. 画面の「運営情報」「サービスと時間」「公開の保護」「最終確認」を進めます。
   運営者の表示名、問い合わせ先、公開ソース URL、プライバシー案内、利用条件、取消の案内を実際の運用に合わせます。
   ソース URL では、その稼働版に対応する AGPL ソースを公開してください。
4. 使用する正確なホスト名を決め、[Turnstile Spin](https://developers.cloudflare.com/turnstile/spin/)でそのホスト名用のウィジェットを作ります。
   設定画面に公開 site key と同じホスト名を保存し、対象 Worker の `TURNSTILE_SECRET` を実 Secret に置き換えます。
   ダッシュボードから入力するか、CLI 導入と同じディレクトリ・Worker 名で `npx wrangler secret put TURNSTILE_SECRET --name my-salon-reservations` を使います。
5. 各場所の公開準備画面で、運営者認証 `owner`、自動送信防止 `protection`、運営・法的表示 `identity`、受付容量 `capacity` の 4 項目を確認します。
   すべて完了してから最終確認で公開予約を有効にします。設定受領書には Secret や顧客データを含みません。

公開テストキー、Secret の欠落、ホスト名の不一致がある間は公開予約を受け付けません。
[サーバー側 Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)の検証も必要です。
DNS や Worker のデプロイ成功だけでは、法的表示や自動送信防止の準備は完了しません。

独自ドメインは設定に必須ではありませんが、業務で使う前の導入を推奨します。
自分のアカウントでドメインを追加したら、Turnstile にもその正確なホスト名を追加し、設定と実際の Siteverify 応答を確認してから予約を受け付けてください。

<a id="branch-builds-and-previews"></a>
## ブランチのビルドとプレビューを確認する

Workers Builds は、本番以外のブランチのバージョンを、アクティブなデプロイに昇格せずアップロードできます。
ただし、このアプリの Durable Objects を備えた Worker にはプレビュー URL が生成されません。
また、Workers Builds の本番と非本番の binding が自動的に分離されるわけではありません。
[ビルド設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、
[プレビュー URL の制限](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)、
[binding に関する移行資料](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)を参照してください。

ブランチの検証には、ローカルの対象ランタイムテストと `npm run build` を使います。
別途許可された外部デモが必要な場合は、binding とホスト名を明示的に確認し、架空データだけを使います。
ブランチのビルドを実データから隔離された環境と決めつけないでください。

<a id="free-plan-fit"></a>
## 利用量と料金を確認する

場所は `default` を含めて最大 4 つです。各場所は、担当・設備 1～8、サービス 1～16、同時選択 1～4、
提示する担当・設備と開始時刻の組 96、1 日の予約作成 96、作成以外の受付済み変更 192 を上限とします。
これはアプリの制限で、Cloudflare のアカウント上限はすべての場所で共有します。

1 日の作成・変更回数は累積です。取消、却下、期限切れで枠が空いても回数は戻らず、行は保持期限まで残ります。
作成回数の上限に達すると、予約画面と管理画面は満席とは区別して表示します。
変更回数の上限に達した操作には、その操作のエラーを返します。
[Workers の制限](https://developers.cloudflare.com/workers/platform/limits/)、
[Durable Objects の料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)、
[静的ファイルの制限](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)、
[Turnstile プラン](https://developers.cloudflare.com/turnstile/plans/)で導入先の予算を計算してください。

60 秒間隔の sweep を使う架空の空 actor のローカル計測では、アダプターごとに alarm と日別 RPC が 1 日 24,138 リクエストでした。
LINE とカレンダーを 4 場所で使う 8 actor に外挿すると **1 日 193,104 Durable Object リクエスト**です。
顧客・管理・provider・名前付き設定の処理を加える前で、公式の Free プランの **1 日 100,000 リクエスト**を超えます。
これは特定のローカル条件からの外挿であり、実請求額や最大負荷の計測ではありません。
4 場所以内でも Free プラン内に収まる保証はありません。運用前にアカウントの利用量を監視し、規模とプランを選んでください。
S4 では実際の請求、遅延、quota 到達時の挙動は未計測です。
[ADR0003 の料金・上限の根拠](ADR-0003-MULTI-LOCATION-BOUNDARY.md#bounds-evidence-and-cost)も参照してください。

カレンダーを設定した場所では、予約時に短時間有効な descriptor を取得し、コミット後に Durable Object を起こします。
予約トランザクション中に Google へのリクエストは送りません。
カレンダー actor は 1 回に日別イベントを最大 32 件取り込み、alarm ごとに Google への変更を最大 8 件、日別 partition の sweep を最大 16 件行います。
upsert の最長経路は update → insert → update なので、送信 alarm の Calendar リクエストは 25 件未満、token 交換は最大 1 件です。
運営者の再同期は、1 リクエストにつき選択した場所の最大 7 日を読みます。
いずれも actor ごとの上限です。アカウントの 1 日の総量ではありません。
運用前に外部・内部 subrequest、CPU、接続数、Durable Objects、alarm の現在の制限と照合してください。

<a id="retention-export-recovery-rollback-and-deletion"></a>
## 保持・復旧・切り戻しを決める

- アプリの保持期限が来ると、場所・日別 object 全体を削除します。
  予約、顧客情報、管理キーの digest、snapshot、休業設定、receipt、alarm が対象です。
  取消は予約状態の変更で、即時の個人情報消去ではありません。
- アプリはバックアップサービスではなく、自動的にデータを外部へエクスポートしません。
  法令、業務継続、消去依頼に必要な場合は、運用前に、別途許可されたアクセス制御付きのエクスポート手順を決めて検証します。
  既存システムの移行目的の読み取りや出力には、[個別の事前確認](../AGENTS.md#existing-system-data-migration)が必要です。
  出力は最小限にし、保護と保持期限を決め、Git、Issue、ログには残しません。
- Durable Object SQLite の [PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)には復旧範囲の制限があります。
  運営者のバックアップ方針の代わりにはならず、アプリの保持期間をすべて復旧できるとは限りません。
  復旧は既存データを書き換える操作です。書き込みを止め、正確な object と日付を特定し、復旧前の状態を保全したうえで、個別の許可を得て実施・検証・記録します。
- コードを切り戻す場合は、対象バージョンを確認し、[Cloudflare の rollback 手順](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)に従います。
  コードの切り戻しでは Durable Object の書き込み、削除、schema 変更は戻りません。データ復旧とは別に判断します。
- 各場所の `CalendarAdapter` alarm は SQLite から Google の再試行、claim 回復、日別 sweep、無効化後の削除、次の alarm を再構成します。
  alarm は重複配送され得るため、安定した event ID、受付済みイベントの重複排除、desired-version claim、冪等な削除結果を保ちます。
  アダプターの切り戻しは、クラス、binding、export、名前付き actor 名、schema を保持する新しいビルドを前方にデプロイし、削除処理が `disabled` になるまで残します。
  アダプター導入前や S4 より前のコードでは、保持中のすべての namespace を処理できません。
- Worker、ドメイン route、Turnstile widget、Durable Object namespace の削除は外部操作で、元に戻せない場合があります。
  方針に必要な出力を保全し、対象アカウント・リソースを確認して、現在の公式削除手順に従います。復旧可能な範囲も記録してください。

<a id="before-accepting-real-bookings"></a>
## 実際の予約を受け付ける前に確認する

各場所の公開準備に未完了項目がないこと、公開ソース URL が対応する AGPL ソースを返すこと、
画面のプライバシー・利用条件・取消の案内が実際の運営者を示すことを確認します。
保持・エクスポート・消去の手順も運営者の義務と一致させてください。

最後に架空データで、空き枠、冪等な予約送信、管理キーによる状態確認と取消、運営者認証、Turnstile の拒否、
狭い画面、キーボード操作、ログの秘匿化を確認します。
データとブラウザーの保持は[プライバシー資料](PRIVACY.md)を参照してください。
Secret、顧客情報、管理キー、Cloudflare アカウント識別子を診断出力に含めないでください。
