# Salon Reservation OSS

自分のCloudflareアカウントで動かせる、日本語の予約アプリです。
予約・キャンセル・同日の時間変更、管理画面、スタッフ権限、最大4店舗の運用に対応しています。
LINE・Google Calendarとの連携は任意です。設定しなくても予約機能を使えます。

このプロジェクトは独立したOSSとして開発します。既存システムのデータ移行や本番環境の変更は、
OSSの導入・公開に必要ありません。新しい環境は架空データのデモモードで始まります。

<a id="deploy-and-finish-setup"></a>
## 自分のCloudflareへ導入する

CloudflareアカウントとGitHubアカウントを用意します。データベースの手動作成やSQL実行は不要です。

1. パスワード管理ツールで十分に長いランダムな管理者キーを作り、保存します。
   `OWNER_TOKEN`に設定する値と、後でセットアップ画面へ入力する値は同じです。
   OpenSSLを使う場合は、手元の端末で`openssl rand -base64 32`を実行し、生成した値を保存します。
   キーをチャット、Git、URL、スクリーンショットへ残さないでください。
2. 次のボタンで、自分のアカウントにコピーを作成します。`OWNER_TOKEN`には保存したキーを入力します。
   `TURNSTILE_SECRET`のサンプル値は架空デモ用です。

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fojungo69%2Fsalon-reservation-oss)

   自動ビルドにはnpm 12が必要です。実行前に[Workers Buildsの設定](docs/CLOUDFLARE.md#workers-builds)を確認します。
   初回フォームで必要な設定を指定できない場合は、[CLI導入手順](docs/CLOUDFLARE.md#cli-setup)を使います。
3. 配備後、発行された`https://<自分のホスト>/`でデモ画面が表示されることを確認します。
   次に`https://<自分のホスト>/setup.html`を開き、保存した管理者キーで認証します。
   デモでは予約を受け付けません。実際の顧客情報を入力しないでください。
4. 実際に予約を受け付けるときは、[Turnstileの設定](https://developers.cloudflare.com/turnstile/spin/)で
   配備先のホスト名を登録します。公開サイトキーをセットアップ画面へ入力し、
   対応する秘密キーをCloudflareの対象Workerの`TURNSTILE_SECRET`へ保存します。
   テスト用のキーでは公開準備を完了できません。
5. セットアップ画面の順番に、運営情報、サービスと時間、公開の保護、最終確認を完了します。
   店名・問い合わせ先・利用条件・プライバシー案内を実際の運営内容に置き換え、
   公開するソースコードのURLを設定してから、ライブモードへ切り替えます。

独自ドメインは任意です。追加するときはTurnstileのホスト名も合わせて変更します。
画面の表示と、実際の予約を受け付ける準備は別に確認します。
詳細と困ったときの対応は[Cloudflare導入・運用ガイド](docs/CLOUDFLARE.md)を参照してください。

## ローカルで試す

Cloudflareアカウントや外部連携を使わず、架空のデモを確認できます。
Git、[`.nvmrc`](.nvmrc)のNode.js、npm 12を用意します。
Node.jsに同梱されたnpmだけでは要件を満たさないため、npmも指定します。

```bash
git clone https://github.com/ojungo69/salon-reservation-oss.git
cd salon-reservation-oss
# nvmを使う場合。使わない場合も.nvmrcのNode.jsを用意します。
nvm install
npm install -g --ignore-scripts npm@12.0.2
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars
```

パスワード管理ツールで作成・保存した管理者キーを、手元の`.dev.vars`の`OWNER_TOKEN`へ設定します。
その後、次を実行します。

```bash
npm run dev
```

Wranglerが表示したURLを開くとデモ画面が表示されます。
同じURLの`/setup.html`では、`.dev.vars`へ設定した管理者キーで認証できます。
ローカルのテスト用Turnstileや`localhost`ではライブモードへ切り替えられません。
予約まで確認する開発者向け手順は[ブラウザテスト](CONTRIBUTING.md#rendered-page-tests)にあります。

## 必要な機能だけ追加する

| 目的 | 手順 |
| --- | --- |
| LINEログイン・予約通知を使う | [LINE設定](docs/LINE-SETUP.md) |
| カレンダー購読・Google Calendarへの反映を使う | [カレンダー設定](docs/CALENDAR-SETUP.md) |
| 店舗を追加し、スタッフの担当店舗を設定する | [複数店舗の運用](docs/MULTI-LOCATION.md) |
| 保存期間やプライバシー上の扱いを確認する | [プライバシーと保持期間](docs/PRIVACY.md) |
| 費用・復旧・更新時の注意を確認する | [Cloudflare導入・運用](docs/CLOUDFLARE.md) |

<a id="what-it-includes"></a>
<a id="deliberate-limits"></a>
## 機能と制限

- スマートフォン向けの予約・予約確認・管理・セットアップ画面
- 複数サービスの選択と、サーバーで確定する所要時間・料金・空き状況
- 仮予約の枠確保、同じ要求の安全な再試行、承認・却下・キャンセル・同日の時間変更
- ブラウザで生成する256ビットの予約管理キー。サーバーにはSHA-256ダイジェストだけを保存
- 最大4店舗、店舗ごとの設定・予約データ・スタッフ権限・任意の外部連携
- 1店舗につき1〜8リソース、1〜16サービス、1回の予約で1〜4サービス、管理画面は最大7日間
- 保持期間を過ぎた日単位の削除、競合・復旧・権限の検証、公開ファイルの監査

タイムゾーンは`Asia/Tokyo`です。日付や店舗をまたぐ予約変更、共通の顧客台帳、決済、
既存システムからの取り込みは現在の対象に含めていません。
予約が残っているサービス・リソースの識別子は維持してください。
互換性のない設定変更は新しい予約を停止しますが、既存予約の確認・キャンセル・確定済み要求の再試行は維持します。

最大4店舗という制限は、Cloudflare無料枠への適合を保証する値ではありません。
4店舗でLINEとGoogleの両方を有効にした条件では、顧客アクセスを加える前でも無料枠の要求数を超える試算があります。
[費用と上限](docs/CLOUDFLARE.md#free-plan-fit)を確認してください。

<a id="parity-status"></a>
## 開発状況

現在の`main`には複数店舗対応までが含まれます。公開タグ`v0.2.0`は複数店舗対応より前のリリースです。
タグの内容は[CHANGELOG.md](CHANGELOG.md)、現在の機能と制限は[機能一覧](docs/PARITY.md)、
今後の方針は[ロードマップ](docs/ROADMAP.md)で確認できます。
データ移行は、必要になったときに別途計画する任意の作業です。
既存本番と同等であるという評価は、OSSのリリース可否とは別に扱います。

<a id="architecture"></a>
## 構成

Cloudflare Worker、Static Assets、Turnstile、Rate Limiting、SQLite Durable Objectsを使います。
実行時のnpm依存はありません。店舗と日付ごとのDurable Objectが予約の整合性を管理し、
任意のLINE・カレンダー連携は予約の空き判定を変更しません。

<a id="local-verification"></a>
## 開発・検証

ローカル環境を準備した後、次を実行します。

```bash
npm run check
npx playwright install chromium
npm run test:browser
```

テストと`npm run build`はローカル検証です。Cloudflareのリソースを作成しません。
詳細は[開発ガイド](CONTRIBUTING.md)を参照してください。

<a id="public-release-boundary"></a>
## 公開とライセンス

通常の変更はPRと`npm run release:audit`を通します。
初回公開用のassemblerで既存リポジトリの履歴を置き換えないでください。
[リリース手順](docs/RELEASING.md)に従って公開します。OSSの公開自体に稼働環境への配備は不要です。

ライセンスは[AGPL-3.0-only](LICENSE)です。自分の変更を配布・運用するときも、
対応するソースコードの公開URLと各貢献の公開権利を確認してください。
[開発ツールのライセンス](docs/THIRD_PARTY_LICENSES.md)も掲載しています。

<a id="security"></a>
実際の顧客情報、認証情報、アカウント識別子、非公開資料、配備結果をGitやIssueへ含めないでください。
脆弱性は[SECURITY.md](SECURITY.md)に従って非公開で報告してください。
<a id="contributing-and-license"></a>
貢献時は[CONTRIBUTING.md](CONTRIBUTING.md)と[行動規範](CODE_OF_CONDUCT.md)を確認してください。
