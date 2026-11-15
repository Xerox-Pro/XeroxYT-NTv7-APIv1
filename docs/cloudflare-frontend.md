# Cloudflareのみで画面とAPIを使う

2026-11-15: 既存Worker `xeroxyt-ntv6-apiv1` に、XeroxYT-NTv7のVite成果物をWorkers Static Assetsとして追加しました。

公開URL: https://xeroxyt-ntv6-apiv1.xeroxapps.workers.dev/

`cloudflare/api/frontend.mjs` はASSETS bindingがある場合だけ有効です。画面と同じOriginのAPI要求を既存APIへ渡し、共有シークレットはWorker内で付与します。外部Originやinternalルートにはこの処理を適用しません。既存のD1・サイトアカウント・暗号化済み連携情報を引き続き使用します。別ドメインのCookieは移動しないため、このURLではサイトへログインし直してください。

再配信するときは、フロントの `npm ci --ignore-scripts && npm run build` とAPIの `npm ci --ignore-scripts && npm run build` を実行し、フロントの `dist` をAPI WorkerのASSETSに関連付けます。既存のD1 binding、シークレット、許可Originは保持してください。実際の配信設定は次のとおりです。

```json
{
  "assets": {
    "directory": "<フロントのdistディレクトリ>",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/internal/*", "/health", "/stream/*", "/360/*", "/edu/*", "/scratch-edu/*"]
  }
}
```

`ALLOWED_ORIGINS` に上記WorkerのOriginを含めます。`/api/transport-config` は同じWorkerのOriginを返し、ブラウザに共有シークレットを返しません。静的ファイルには従来の画面用CSPなどのヘッダーを適用します。

Vercelへのアクセスを停止するため、この配信では `SOCIAL_BROWSER_PROVIDER=disabled` です。SNSブラウザログインは表示せず、既存の手動セッション接続・設定済み公式OAuthを保持します。SNSログインや投稿機能の実アカウント動作確認は未実施です。

## 確認結果

- 実際のサイトアカウント登録→状態確認→公開おすすめ39件→Shorts30件→ログアウトをCloudflareだけで確認しました。確認用アカウント・セッションは削除しました。
- Instagramの公開検索とTikTokの公開フィードは、提供元による拒否・共有上限により取得できませんでした。Cloudflare Browser RenderingでもInstagramの公開データ取得を確認できませんでした。
- URL追加からの公式埋め込み、公開プロフィールのHTML読み取り、取得失敗後の再試行を改善しました。これらは検索・フィード・ストーリー全体の復旧を保証するものではありません。
- DM・個人向けおすすめ・ノート・ストーリー投稿の新しい動作保証はしていません。提供元で認められたセッション・権限と実アカウント検証が必要です。

仕様: https://developers.cloudflare.com/workers/static-assets/direct-upload/
