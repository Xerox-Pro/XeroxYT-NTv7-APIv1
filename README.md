# XeroxYT-NTv7-APIv1

**XeroxYT-NTv7という動画視聴WebサイトのバックエンドAPI**です。検索・動画情報・Shorts・コメント・チャンネル・サイトアカウント・視聴履歴をCloudflare Workers/D1で提供します。サイト画面は含みません。

フロントエンド: https://github.com/YOUR_ACCOUNT/XeroxYT-NTv7

## 必ずAPIとフロントの両方を設定してください

1. このAPIをCloudflareへデプロイする。
2. フロントをVercelへデプロイし、`API_BASE_URL` にAPIのHTTPS URLを設定する。
3. APIの `ALLOWED_ORIGINS` にフロントのURLを設定する。

フロントだけのデプロイ、API URLの未設定、許可Originの未設定では動作しません。

## 初回セットアップ

Node.js 22以上とCloudflareアカウントが必要です。

```sh
npm ci
npx wrangler login
npx wrangler d1 create xeroxyt-accounts
```

作成されたD1の `database_id` を、ルートの `wrangler.jsonc` の `REPLACE_WITH_YOUR_D1_DATABASE_ID` と置き換えます。同時に `vars.ALLOWED_ORIGINS` を、自分のフロントの正確なOriginに変更します。

```json
"vars": {
  "NODE_ENV": "production",
  "ALLOWED_ORIGINS": "https://your-site.vercel.app,https://your-preview.vercel.app"
}
```

初期スキーマを適用してデプロイします。

```sh
npm run db:migrate
npm run deploy
```

許可Originと共有鍵を設定したサイト経由の `/api/health` が `ok:true` を返すことを確認します。APIはアカウント機能も内包しており、別のアカウントWorker・Render・Vercel APIサーバーは不要です。新規D1に既存ユーザーのデータは入りません。既存のD1を使う場合は、バックアップを取り、そのIDを指定してください。

## フロント側の環境変数

VercelのSettings → Environment Variablesへ設定後、再デプロイします。

```dotenv
API_BASE_URL=https://your-api.your-subdomain.workers.dev
```

末尾の `/` と `/api` は付けません。Preview/Productionそれぞれの変数と、それぞれの正確なURLをALLOWED_ORIGINSに設定します。URLが増えたらAPI側も更新してください。

## APIの利用

サイトアカウントのログインが必要です。ブラウザーからはフロントの同一Originの `/api/…` を使用します。Worker URLを直接開いても、別サイトのログインCookieは共有されません。

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/health` | 許可Origin・共有鍵が必要な稼働確認 |
| POST | `/api/account/register` | サイトアカウント作成 |
| POST | `/api/account/login` | ログイン |
| GET | `/api/account/session` | セッション確認 |
| GET / PUT | `/api/account/history` | 履歴の取得・競合検知付き保存 |
| POST | `/api/account/logout` | ログアウト |
| GET | `/api/search?q=…` | 動画検索 |
| GET | `/api/suggestions?q=…` | 検索候補 |
| GET | `/api/video/:id` | 動画情報 |
| GET | `/api/video/:id/comments` | コメント |
| GET | `/api/video/:id/related` | 関連動画 |
| GET | `/api/channel/:id` | チャンネル |
| GET | `/api/channel/:id/tab/:tabName` | チャンネル内ページ送り |
| GET | `/api/channel/:id/search?q=…` | チャンネル内検索 |
| GET | `/api/recommendations` | おすすめ |
| GET | `/api/shorts` | Shorts候補 |
| GET | `/api/shorts-ranking` | Shortsランキング |

ログイン・登録のPOSTはJSONで `username` と `password` を渡します。ユーザー名は英小文字・数字・_で3～32文字、パスワードは12文字以上です。Originの検証とHttpOnly Cookieによる認証を維持してください。ダウンロード用APIは410を返します。

## 制限と検証

Workers FreeではCPU時間の制限により、重い解析で1102エラーが起こる場合があります。有料プランへの変更は自動では行いません。YouTube側の仕様・制限や外部プレイヤー取得元の状態によって利用できない機能・動画もあります。Googleログイン後の個人データ機能や配信中チャットはすべての条件で検証済みではありません。

```sh
npm run build
npx wrangler deploy --dry-run
```

D1にはユーザーと履歴が保存されます。アカウント用テーブルを削除したり、初回セットアップのつもりで別D1へ切り替えたりしないよう注意してください。表示名・アイコンの変更はフロント端末内だけで行い、このAPIに送信されません。

## Vercel / Renderで動かす（Node版）

同じリポジトリをNode APIとして起動できます。画面はありません。Vercelではリポジトリをインポートし、FrameworkをOther、Node.jsを22以上にします。`api/index.ts` と `vercel.json` が全APIリクエストを処理します。ビルドは `npm run build` です。

Renderでは `render.yaml` のBlueprintを利用するか、Web Serviceを作ってBuild Commandを `npm ci && npm run build`、Start Commandを `npm start` にします。PORTはRenderが設定します。無通信時の停止や初回起動の待ち時間はRender側のプランによります。

認証の設定は次のいずれかです。どちらも環境変数はバックエンド側のサーバー専用に設定します。

### A. 先頭のCloudflare APIを認証元にする

```dotenv
ACCOUNT_API_URL=https://your-primary.your-subdomain.workers.dev
ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

Node APIはサイトアカウントの登録・ログイン・履歴保存とGoogle認証の処理を先頭APIへ転送します。アカウントの分裂を防ぐため、フロント側の全APIが同じ認証元を使ってください。認証元が停止するとログインはできません。

### B. Node版から同じCloudflare D1へ直接接続

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
D1_DATABASE_ID=your-database-id
CLOUDFLARE_API_TOKEN=your-server-only-d1-token
ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

D1データベースとスキーマは最初の手順で作成します。トークンには対象アカウントのD1操作に必要な権限だけを与え、Vercel/RenderのSecretとして保存します。ブラウザーやフロントの `VITE_*` 環境変数へ渡さないでください。このモードではCloudflare Workerを認証のために起動する必要はありません。D1のREST APIが認証・履歴・OAuthフローの保存先になります。

Cloudflareはバインディング、Node版はD1 REST経由で同じテーブルを扱います。すべてのホストで同じ認証元/同じD1を使って初めて、Cookieをゲートウェイから転送したときに認証を共有できます。

## 複数APIの登録

フロントのVercel環境変数で `API_BASE_URL_1`、`API_BASE_URL_2`…を追加します。API自体には固定登録数の制限を設けません。プロバイダーの環境変数・リクエスト時間制限はあります。先頭をアカウント処理の正本にし、その他は同じD1または同じACCOUNT_API_URLを参照するようにしてください。

CORSは `ALLOWED_ORIGINS` の完全一致だけを許可します。自動モードで直接接続が認証/CORSエラーになった場合、フロントはサーバー経由へ切り替えます。ログインCookieのSameSite属性はこの機能のために緩めません。

Node起動の `/health` とCORS/未認証拒否はローカルで検証しています。Renderへの実デプロイやD1 RESTモードでの実アカウント作成は、この更新時点では未検証です。

## 接続元の制限（全ルート）

`ALLOWED_ORIGINS` に列挙したフロントのOrigin以外は、`/health` を含めすべて403で拒否します。Originなしの呼び出しも許可しません。OriginはURLの `https://ホスト名[:ポート]` 部分で、ページのパス単位の許可ではありません。

さらに標準設定では `REQUIRE_PROXY_SECRET=true` とし、VercelゲートウェイとAPIだけが持つ `API_SHARED_SECRET` を必須にします。Vercelフロント側とすべてのAPI側に同じ十分長いランダム値をSecretで設定します。Cloudflareでは `npx wrangler secret put API_SHARED_SECRET` を使います。リポジトリ・ブラウザーコード・VITE_*には保存しません。ゲートウェイはAuthorizationヘッダーでサーバー間だけに送信します。

| 変数 | API側 | フロント側 |
|---|---|---|
| ALLOWED_ORIGINS | 許可するフロントOriginをカンマ区切り | 不要 |
| API_SHARED_SECRET | 必須・Secret | 必須・サーバー専用Secret |
| REQUIRE_PROXY_SECRET | 標準はtrue | 不要 |

この設定では、許可されたOriginをcurlなどで偽装しても共有秘密鍵がない呼び出しは403になります。秘密鍵だけが合っていてもOriginが許可されていなければ拒否します。サイトアカウントの認証も別途必要です。

ブラウザーは秘密鍵を持たないため、秘密鍵必須時の直接接続は拒否されます。フロントの自動モードはサーバー経由へ切り替わります。直接接続を許可したい場合に限りREQUIRE_PROXY_SECRET=falseにできますが、その場合Originは偽装可能で、他サーバーからの呼び出しをOriginだけで完全に防ぐことはできません。

RenderはHTTPのhealthCheckPathを設定せず、TCPの起動確認を使用します。APIの `/health` を外から確認する場合も、許可Originと共有鍵が必要です。サイト経由の `/api/health` はゲートウェイが必要なヘッダーを付けます。

実際のデプロイURL・許可Origin・共有キーはホスティング側の環境変数で設定してください。このリポジトリのURLはすべて例示用です。個人の接続先をコミットしないでください。
