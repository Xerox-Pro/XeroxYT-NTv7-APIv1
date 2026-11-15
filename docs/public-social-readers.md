# 公開投稿の取得とGAS入口の復旧（2026-11-15）

## GASの拒否

以前の配信では、既存GAS専用鍵を受け付けるラッパーを配信エントリーから外してしまい、GASの `Origin: https://script.google.com` が拒否されていました。

`cloudflare/api/worker.mjs` から `withGasKey` を直接呼び出すようにし、APIの通常ビルドへ組み込みました。既存のGAS専用鍵・サイト用鍵・DBは維持しています。Worker本体への回帰テストで、有効なGAS鍵は未ログインの401まで通り、不正な鍵・別Originは403になることを確認しています。既存の有効セッション延長も保持します。

## TikTok

- ユーザー提供記事: https://qiita.com/app_js/items/98072393ec656927572f
- 現在の元ライブラリ: https://github.com/davidteather/TikTok-Api
- Workersで採用したnpm: `@cloudflare/puppeteer@2.0.0`
- 公式の実行方法: https://developers.cloudflare.com/browser-run/puppeteer/

記事は2023年のPython実装です。現在のライブラリもブラウザセッションを使うため、Workersでは既存BROWSER bindingにPuppeteerを接続し、ログインしていない公式公開ページを読み取ります。Cookieや認証情報をユーザーから受け取りません。取得した動画リンクを公式プレイヤーで表示します。

`SOCIAL_PUBLIC_BROWSER_ENABLED=true` で有効です。`SOCIAL_BROWSER_PROVIDER=disabled` はログイン機能だけの設定で、公開閲覧用ブラウザとは独立しています。ブラウザは要求ごとに閉じます。公開一覧を30分、検索を15分、投稿URLを5分、メモリとCloudflare Cache APIに保持します。再取得が一時制限された場合は期限付きの過去データを、その旨を明示して返します。個人向け・認証済みデータはこのキャッシュに入れません。件数・ページ送りを作り足しません。

公開ブラウザが有効な本番では、失敗後にTikWMへ自動で切り替えません。明示的に `SOCIAL_TIKWM_ENABLED=true` の場合だけ従来の外部APIを使います。TikTokの投稿URLは公式oEmbedを先に使い、ブラウザの日次予算を消費せずに公式プレイヤーへ渡します。Cloudflareの日次上限と同時実行制限、SNS側のログイン要求を区別して返します。本当の日次上限は実装変更で解除できません。

Cloudflareで公開フィードの7件取得を確認しました。キーワード検索・プロフィール・ストーリーは提供元が拒否する場合があり、全機能の復旧保証はありません。

## Instagram

参考実装: https://github.com/instaloader/instaloader/blob/master/instaloader/structures.py および https://github.com/instaloader/instaloader/blob/master/instaloader/instaloadercontext.py

公開開始ページが発行する匿名トークンで、現在の公開投稿用web APIを呼びます。転送するCookieはその開始ページが発行した匿名csrftokenだけです。ログイン済みユーザーのCookieは使用しません。非公開アカウントの応答を拒否します。動画・画像・カルーセルを正規化し、取得できなければ既存の公開ページ・公式埋め込みへ切り替えます。

Cloudflareの `public/resolve` で公開動画1件を取得し、返された動画URLのRange要求が `206 video/mp4` になることを確認しました。

公開投稿の取得と、おすすめ一覧・ストーリーの取得は別の機能です。おすすめ一覧のログイン要求は、日次上限とは表示せず、公開投稿URLの入力へ案内します。

## Google連携のホーム継続取得

ログイン中の個人向けホームが失敗しても、公開おすすめに切り替えません。読み込んだ動画と継続カーソルを保持して同じページを再試行します。連携状態の確認が一時失敗しても、既知の連携情報を削除しません。TVクライアントのvisitorDataを継続カーソルに含め、リクエストごとに生成するWorkersクライアントへ復元します。OAuth情報は引き続きサーバー側の暗号化ストアから読み込みます。

ホームの継続カーソルはURLではなく `POST /api/user/feed/home` のJSON本文で送ります。GASのUrlFetchAppにはURL長2,082文字の上限があるためです（https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app）。既存GETは互換性のため残し、フィードPOSTは更新操作とは分けて読取としてレート制御・通信再試行します。20,000文字を超えるカーソルの画面回帰テストと、55,000文字の本文を短いURLで送るGASテストを追加しています。

## npmの比較実行

- `instagram-url-direct@2.0.7`: 参考として試しましたが、従来のgraphql/query呼び出しは401になりました。製品依存には追加していません。
- `@tobyg74/tiktok-api-dl@1.3.7`: Trending取得はNodeで成功しましたが、返るのはユーザー・タグ・音楽の一覧です。その他の処理はNodeのファイル読み取りや署名生成に依存します。公開動画フィードには、実際に動画リンクを取得できた公式Browser Run用npmを採用しました。

## 共有リンク

TikTokの `vt.tiktok.com` / `vm.tiktok.com` / `www.tiktok.com/t/` とInstagramの公式 `/share/...` を最大4回の公式ドメイン内リダイレクトで展開します。Cookie・Authorizationは送りません。別ドメイン・内部アドレスへの転送を拒否します。フロントの「公開投稿を追加」でも共有リンクを受け付けます。
