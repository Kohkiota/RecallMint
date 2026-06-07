モデル: GPT-5 Codex
日付: 2026-06-08
対象コミットハッシュ: b693d2cb9a5b71bceb18d85b06d0a2ad85e0e133

# Codex Repo-Wide Review

RecallMint リポジトリ全体を、差分レビューではなく静的読解によるアーキテクチャレビューとして確認した。主な対象は Next.js App Router、Drizzle schema/API、Dexie local-first 同期、Clerk/Stripe webhook、OCR/Gemini、テスト・開発体験。

## 総評

設計意図と運用上の失敗モードがコメントとテストにかなり残されており、特に webhook idempotency、ユーザー削除、local-first 同期、Stripe の順序非保証への対処は丁寧に作られている。一方で、現在のリスクは「機能ごとの実装品質」よりも、local-first の outbox/mirror 境界、巨大同期時の無制限処理、開発ツールチェーンの腐食、外部 API 利用制限の厳密性に寄っている。

## Findings

### 1. タグ更新の optimistic mirror と outbox 書き込みが分離しており、ローカルだけ成功する状態が残りうる

重要度: High

`app/(app)/app/exams/[id]/_components/card-tags-section.tsx` の `handleToggle` は、先に Dexie `card_tags` を更新し、その後 `enqueueEntityMutation(...)` を `void` で投げている。`enqueueEntityMutation` や後続 flush が失敗しても、ローカル mirror は更新済みのまま残る。つまり「UI ではタグが付いたが、outbox に mutation が無い/失敗したのでサーバーへ永続化されない」状態が作れる。

同じ箇所で optimistic `card_tags.put` の `user_id` に空文字を入れている点も危険。現在の表示は `card_id` 中心なので目立ちにくいが、`ClientCardTag` の契約上は `user_id` を持つ mirror であり、将来の user scoped reset/filter、テスト、解析で汚染データになる。

推奨:

- optimistic mirror 更新と outbox enqueue を同じ Dexie transaction に寄せる。
- enqueue を `await` し、失敗時は mirror を戻すか、少なくとも failed/pending として回復可能にする。
- `user_id` は親から渡すか、現在の mirror から取得して正しい値を入れる。

### 2. `/api/pull` と client merge が無制限で、利用が伸びると同期が serverless timeout/メモリ圧迫の主要因になる

重要度: High

`app/api/pull/route.ts` は cards/exams/tombstones/tag streams をまとめて返すが、ページングや上限が見当たらない。client 側 `lib/sync/pull.ts` も 1 response を 1 Dexie transaction で bulkPut/delete する前提。ユーザーのカード数・タグ数・削除 tombstone が増えるほど、初回同期や cursor 破損時の全件 pull が重くなる。

これは local-first アプリの成長時に典型的なボトルネックになる。Vercel function の実行時間、レスポンスサイズ、ブラウザ IndexedDB transaction 時間のすべてに効く。

推奨:

- stream ごとに `limit` と `(updated_at, id)` の keyset cursor を導入する。
- response に `has_more` を持たせ、client は小さな transaction を繰り返す。
- tombstone retention 方針を決める。無期限保持なら初回同期で削除履歴が膨らむ。

### 3. Gemini 日次利用上限は安全弁としては approximate で、厳密なコスト上限にはなっていない

重要度: High

`app/(app)/app/upload/_actions/process.ts` は OCR 開始前に `getTodayAiUsageGlobal()` を読み、`GEMINI_DAILY_LIMIT` を超えていないか確認している。一方、実際の加算は `runOcrPipeline` の各 attempt 直前に `incrementAiUsage` で行われ、`lib/ai/ocr.ts` 側では callback 失敗を握りつぶす。

結果として、同時実行時には「全員が同じ現在値を見て通過し、後から加算する」形で上限を超過しうる。また counter DB write が失敗しても OCR は続くため、無料枠や予算を厳密に守る最後の防壁にはならない。

推奨:

- 厳密な上限が必要なら、`ai_usage` 行を transaction 内で atomic increment し、`count + requested <= limit` を同じ SQL で判定する。
- retry 回数込みの最悪 attempt 数を事前予約するか、attempt ごとに atomic guard を行う。
- counter 失敗時に OCR 継続してよいのか、運用ポリシーとして明文化する。

### 4. lint script が現在の Next.js/ESLint 構成と合っておらず、品質ゲートとして機能しない

重要度: Medium

`package.json` の `lint` は `next lint` だが、ESLint 設定ファイルが存在しない。実行時は Next.js の ESLint 設定プロンプトに入り、非対話 CI では失敗する構成になっている。さらに `next lint` 自体が deprecated と警告される。

このリポジトリはテストが厚い一方で、React hooks、import 解決、未使用コード、アクセシビリティ寄りの静的検査を lint に任せられていない。

推奨:

- `eslint.config.mjs` を追加し、`lint` を `eslint .` に移行する。
- Next.js plugin、TypeScript、React Hooks のルールを最低限入れる。
- CI で `pnpm lint`, `pnpm test`, `tsc --noEmit` を分けて実行する。

### 5. `price-mapping.ts` の env fail-fast は正しいが、import 境界を誤ると無関係機能も落ちる

重要度: Medium

`lib/stripe/price-mapping.ts` は module load 時に 4 つの Stripe price env を必須にしている。課金処理では fail-fast として妥当だが、pricing UI やテスト、将来の非課金ページから不用意に import されると、Stripe 設定が無い環境でページ全体が落ちる。

推奨:

- server-only の課金実行経路と、表示用 plan catalog を明確に分ける。
- env を読む module は import 可能範囲を絞り、UI 表示は env 非依存の catalog から読む。
- 現状維持なら「price-mapping は課金実行専用」とコメントだけでなく lint/import 境界で守る。

### 6. `/api/me/deletion-status` は public endpoint として設計されているが、userId の列挙・状態観測ができる

重要度: Medium

`app/api/me/deletion-status/route.ts` は Clerk auth なしで `userId` query を受け、`not_found/pending/clerk_synced/completed` を返す。削除後 polling 目的は理解できるが、`user_...` 形式の ID を知っている相手には状態観測が可能になる。

Clerk user ID は秘密ではないが、URL、ログ、サポート文脈などに出る可能性はある。削除状態はアカウント存在・課金キャンセル進捗に近い情報なので、public にするなら意図を運用レベルで受け入れる必要がある。

推奨:

- 削除開始時に短命の polling token を発行し、`userId + token` で照合する。
- もしくは返却を粗くし、存在確認に使える差分を減らす。

### 7. Clerk/Stripe webhook は 200 swallow 方針なので、監視と再処理手順が実装品質と同じくらい重要

重要度: Medium

webhook handler は retry loop 防止のため、handler 内 error を通知して 200 で飲み込む設計。これはコメント通り意図的で、idempotency table も整っている。ただしこの方針は、通知・監査テーブル・手動復旧 runbook が落ちるとデータ不整合が自然回復しない。

特に Stripe plan sync、Clerk deletion、scheduled downgrade release は外部状態を真実 source にしており、アプリ DB はコピー。copy の修復手順が運用品質に直結する。

推奨:

- `deletion_failures` 以外にも、Stripe plan sync failure の再処理手順を docs/runbook 化する。
- webhook event ID から安全に replay する admin script を用意する。
- Discord 通知だけでなく、DB 上で未解決 failure を一覧できる運用 query を固定化する。

### 8. schema とコードコメントに歴史的文脈が多く、保守時の判断コストが上がっている

重要度: Medium

`lib/db/schema.ts` や同期系ファイルには、過去 sprint、設計案、移行理由、将来予定が大量に残っている。これは事故防止に役立つ一方、現在の invariant と過去の経緯が同じ密度で混在しており、新しい変更者が「今守るべき制約」を見分けにくい。

推奨:

- コードコメントは現在の invariant と危険な理由に絞る。
- 経緯、廃止済み判断、sprint 名は `docs/architecture-guide.md` や ADR に逃がす。
- 各主要領域に「現在の契約」だけを短くまとめたファイルを置く。例: sync contract、billing contract、deletion contract。

## Good Signals

- owner scoped query が多く、`userId` を WHERE に含める意識が一貫している。
- webhook idempotency は event table の `ON CONFLICT DO NOTHING` で明示されている。
- user deletion は soft delete と child physical delete の差を理解した設計になっている。
- Dexie outbox と server bulk API は mutation/event ID で冪等化されている。
- テストファイル数が多く、仕様コメントと regression test の距離が近い。

## Verification

今回のレビューではコード本体は変更していない。`corepack pnpm lint/test/tsc` は一度実行しようとしたが、再開直後にユーザー指示で中断されたため、最新状態での検証結果としては扱っていない。lint については、静的に ESLint 設定ファイルが無いことと `package.json` の script を確認した。

