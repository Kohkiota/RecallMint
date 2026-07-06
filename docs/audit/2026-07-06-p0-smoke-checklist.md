# P0 smoke checklist (定義)

- 日付: 2026-07-06 / branch: `dddrefactor` / phase: **P0**
- 位置づけ: 各後続 phase 完了時の smoke 実行のチェックリスト定義。実行は DevTools MCP (Playwright / chrome-devtools) で CC が行う。OT 依頼は課金 API 実走 / 物理 mobile 等 CC 環境制約のある手順のみ。
- stg URL: `https://stg.recallmint.nekotest.net`
- P0 では定義のみ。各 phase の smoke 実行で本 checklist を参照する。

---

## Flow 1: 認証 (auth)

**mobile 要否**: No

### 手順

1. Incognito / プライベートウィンドウで `https://stg.recallmint.nekotest.net/` を開く
2. ヘッダまたはランディングページの「ログイン」ボタンをクリック
3. Clerk 認証モーダルが表示されることを確認
4. テストアカウントのメール / パスワードを入力してログイン
5. `/app` (dashboard) へのリダイレクトを確認
6. dashboard が描画されることを確認(試験数 / due カード数のいずれかが表示される)
7. ネットワーク: `/api/pull` が `200` を返すことを確認(auth 後の初回 pull が成功)
8. アカウントメニューから「ログアウト」をクリック
9. ランディングページ / サインインページへリダイレクトされることを確認

### 期待挙動

- Clerk モーダルが正常に表示・完了する
- `/app` に遷移後、dashboard が error なく描画される
- `/api/pull` → 200 (6 streams が返る)
- ログアウト後は認証状態がクリアされる (再アクセスで `/app` が auth redirect する)
- ネットワークに 401 が出ない(auth 直後)

---

## Flow 2: カード編集 (inline edit)

**mobile 要否**: No

### 手順

1. ログイン済み状態で `/app/exams` を開く
2. 任意の試験をクリックして試験詳細ページ `/app/exams/[id]` に遷移
3. カードテーブルが表示されることを確認
4. 「タイトル」列の任意セルをクリック → インライン入力フィールドが表示されることを確認
5. 新しいタイトル文字列を入力し Enter キーを押す
6. セルに更新後のタイトルが即座に表示されること(optimistic update)を確認
7. ネットワーク: POST `/api/entity-mutations/bulk` → 200 `{ ok: true, applied: 1, failed: [] }` を確認
8. DevTools > Application > IndexedDB > recallmint > entity_mutations: レコードが消えて outbox が空になることを確認
9. ページを hard refresh (Ctrl+Shift+R) して試験詳細を再表示
10. 更新後のタイトルが DB に永続していることを確認

### 期待挙動

- インラインエディタが正常に開く
- 保存後 outbox (Dexie `entity_mutations` table) が cleared になる
- `/api/entity-mutations/bulk` → 200 `{ ok: true, applied: 1, failed: [] }`
- リフレッシュ後も更新値が保持されている (DB 永続確認)

---

## Flow 3: タグ CRUD

**mobile 要否**: No

### 手順

1. ログイン済み状態で `/app/tags` を開く (またはサイドバーのタグリンク)
2. 「新規カテゴリ」ボタン(またはそれに相当する UI)をクリック
3. カテゴリ名を入力して確定 → カテゴリ一覧に追加されることを確認
4. 作成したカテゴリ配下に新しいオプションを追加する
   - オプション名を入力して確定
5. 作成したオプションの名前を変更する(リネーム操作)
6. ネットワーク: POST `/api/entity-mutations/bulk` → 200 `{ ok: true, applied: 1, failed: [] }` を確認
7. DevTools > Application > IndexedDB > recallmint > tag_categories / tag_options: mirror が更新されていることを確認
8. オプションを削除する(delete ボタン → 確認ダイアログ → OK)
9. オプション一覧から消えることを確認
10. ネットワーク: DELETE op が `/api/entity-mutations/bulk` 経由で処理されることを確認 (applied:1)

### 期待挙動

- カテゴリ / オプション の CRUD が全て正常完了
- 各操作後に `/api/entity-mutations/bulk` → 200 で applied が増える
- Dexie `tag_categories` / `tag_options` mirror が操作後に更新されている
- 削除操作: `entity_mutations` テーブルへの INSERT がない (skipLog)、かつ applied:1

---

## Flow 4: 5 問回答 → bulk flush

**mobile 要否**: Yes (モバイル実機でも確認が必要な主要学習フロー)

### 手順

1. ログイン済み状態で `/app` dashboard を開く
2. 「学習開始」または due カード一覧から学習セッションを開始する
3. 5 問連続で回答する(回答選択 → 次問へ)
4. DevTools > Application > IndexedDB > recallmint > answer_events: 回答ごとに event が蓄積されることを確認
5. セッション終了ボタンを押す(または 5 問完答でセッション完了)
6. ネットワーク: POST `/api/review-events/bulk` → 200 `{ ok: true, failed: [] }` を確認
7. DevTools > IndexedDB > recallmint > study_days: 今日の日付 (JST) でエントリが存在することを確認
8. dashboard に戻り、due カード数が減少していることを確認(FSRS スケジュール更新)
9. (mobile 実機確認) 同操作をモバイルブラウザ実機で繰り返す

### 期待挙動

- 回答ごとに Dexie `answer_events` にレコードが追加される
- セッション完了時に `/api/review-events/bulk` → 200 `{ ok: true, failed: [] }`
- `study_days` に JST date でエントリが作成 / 更新される
- `failed: []` — イベントが全て正常処理される
- dashboard の due count が更新される

---

## Flow 5: OCR upload

**mobile 要否**: No (ファイル選択は DevTools で操作可能。ただし結果確認は PC のみで可)

### 手順

1. ログイン済み状態で `/app/upload` を開く
2. 残量 banner が表示されることを確認(月次 OCR ページ残量)
3. テスト用 PDF ファイル (5 ページ以下、4 MB 以下) を選択
   - DevTools MCP: `browser_file_upload` でファイルを指定
4. 投入先を選択(既存試験または新規試験)
5. 「アップロード」ボタンをクリック
6. 処理中インジケータが表示されることを確認
7. 処理完了後、`/app/upload/result/[sourceDocumentId]` へのリダイレクトを確認
8. 結果ページ: 抽出されたカード一覧が表示されることを確認
9. ネットワーク: Server Action response `{ ok: true, data: { sourceDocumentId, examId, cardsExtracted, ... } }` を確認
10. 試験詳細 `/app/exams/[id]` に遷移して新規カードが追加されていることを確認

### 期待挙動

- OCR パイプライン全体が正常完了する
- 結果ページに `cardsExtracted > 0` が表示される
- Server Action の戻り値: `{ ok: true, data: { ... } }`
- 対象試験に新規カードが保存されている (DB 永続確認)
- `/app/upload` と `/app` が revalidate されている (残量 banner が更新される)

---

## Flow 6: plan 変更

**mobile 要否**: No (Stripe Checkout への遷移まで。決済実行は OT 実機のみ)

### 手順

1. ログイン済み状態でアカウント設定またはプランページ(`/app/settings` または相当 URL)を開く
2. 現在のプラン表示を確認(free / pro 等)
3. 「プランを変更」または「アップグレード」ボタンをクリック
4. Stripe Checkout ページへリダイレクトされることを確認
   - URL が `https://checkout.stripe.com/...` であることを確認
5. Checkout ページが正常に描画されることを確認(プラン名 / 金額が表示される)
6. Checkout を完了せずにブラウザバック / キャンセル
7. アプリに戻ることを確認(broken redirect がない)
8. webhook 経由のプラン同期は OT 実機確認(Stripe Checkout 完了 → `customer.subscription.updated` webhook → plan DB 更新 → UI 反映)

### 期待挙動

- プランページが正常に表示される(現在のプラン・上限が明示されている)
- Stripe Checkout ページに正常に遷移する(broken redirect なし)
- Checkout ページに正しいプラン情報が表示される
- キャンセル後にアプリに戻れる
- (OT 実機) Checkout 完了 → webhook 受信 → users.plan 更新 → UI 反映のフルサイクル確認
