# Y-2 Sub-plan C T-C4 — content_version 用途調査 (2026-06-12)

audit §10.3 (b) #8 (= spec §9 audit 突合表 #12) を消化するための **read-only 調査**。
implementation ではなく OT 判断のための callsite inventory + Phase 4 / Y-3 roadmap 突合。

## 1. 調査範囲 + 方法

- `rg -n "content_version|contentVersion"` を repo 全体に実行 (node_modules / .next / .git / lockfile / drizzle snapshot 除外、 SQL migration / docs / test は残す)
- 各 non-test callsite を 10-30 行の文脈で読解し bucket 化
- 関連 spec / pre-investigation docs を突合 (`docs/02-tech-spec.md §14.9`、 `docs/superpowers/specs/2026-05-26-s-local-1-design.md`、 `docs/superpowers/specs/2026-05-30-exam-detail-local-first-write-design.md`、 `docs/recallmint-idb-sync-bestpractice-comparison.md`、 `docs/audit/2026-06-12-repo-wide-audit.md`、 `docs/superpowers/specs/2026-06-12-y2-launch-hardening-design.md`)

## 2. 全 callsite 一覧 (categorized)

### 2.1 schema definition (3 sites)

| path:line | bucket | 抜粋 / 推定役割 |
|---|---|---|
| `lib/db/schema.ts:255` | schema (Drizzle, exams) | `contentVersion: integer('content_version').notNull().default(0)`。 コメントに「server 側 bulk API が mutation 適用時に +1 する楽観ロック相当の数値。 client は受領済 version を保持し、 push 時に比較に使う」 と**意図**は明記、 だが配線なし。 |
| `lib/db/schema.ts:324` | schema (Drizzle, cards) | 同上。 cards 側にも同コメントで宣言、 配線なし。 |
| `lib/client-db.ts:48` (ClientExam type) / `:96` (ClientCard type) / `:241,:243` (Dexie store index 文字列) | schema (Dexie) | `content_version` 列を型と Dexie compound index 文字列に含む。 read-only mirror 側でも保持。 index に含まれているが、 既存 query は updated_at + due で十分で、 content_version 列は実際には index 利用なし。 |

### 2.2 read callsite (mapping のみ、 比較なし) (4 sites)

| path:line | bucket | 抜粋 / 推定役割 |
|---|---|---|
| `lib/db/cards-mapper.ts:43` | server-read (mapper out) | `toClientCard()`: server row → ClientCard 変換時に `content_version: row.contentVersion` をそのまま転送。 |
| `lib/db/cards-mapper.ts:81` | server-read (mapper in) | `toCard()`: 逆変換 `contentVersion: c.content_version`。 smart-session で Dexie → server Card 型復元用。 比較ロジック呼出元はなし。 |
| `lib/db/exams-pull.ts:21` | server-read (mapper) | `toClientExam()`: 同上 pattern (`getExamsDelta` で /api/pull に出力)。 |
| (pull route) `app/api/pull/route.ts` 経由で client へ流れる | client-write (pull bulkPut) | pull route は exams/cards-pull.ts 由来の row をそのまま Dexie に bulkPut する。 client は受領するが「比較」 で使う read 経路なし (grep で `if (...content_version...)` / `>` / `<` / `===` / `!==` 系 hit 0)。 |

### 2.3 client write callsite (default 0 のみ、 increment なし) (1 site)

| path:line | bucket | 抜粋 / 推定役割 |
|---|---|---|
| `lib/cards/build-new-client-card.ts:59` | client-write (optimistic create) | 手動 card 追加で mirror に optimistic 行を組む helper。 `content_version: 0` を hard-coded。 「server 適用後の pull-back で確定値に収束」 とコメント、 だが server 側で +1 されないため永続的に 0。 |

### 2.4 server write callsite (increment / set) — **0 件**

- 全 grep + `app/api` 配下精査の結果、 `contentVersion: ...` を **INSERT 以外で書込む箇所はゼロ**。
- `app/api/entity-mutations/bulk/route.ts` / `app/api/review-events/bulk/route.ts` / `lib/sync/*` に `+1` / `inc` / `sql\`content_version + 1\`` の hit なし。
- Drizzle schema default(0) 経由 INSERT のみ、 application code から明示書込みなし。
- `app/(app)/app/exams/_actions/create-exam.ts:14` のコメントが「cardCount / contentVersion は DB default (0) を使用」 と明示、 これが現状の唯一の「書込み policy」。

### 2.5 server read callsite (gating / 比較) — **0 件**

- pull の SELECT に列が含まれるのみ。 WHERE / IF / COMPARE で content_version を使う query は **存在しない**。

### 2.6 test fixtures (24 sites、 fixture のみ、 比較 expect なし)

`*.test.ts(x)` 21 件 + `*-delta.test.ts` の type 定義 3 件。 全て row オブジェクトの prop として `content_version: 0` または fixed 値を埋めるだけで、 期待値 assertion 側でも単に「pull 後に同じ値が現れる」 ことを確認する round-trip。 actual logic 検証はゼロ。 詳細: `app/api/pull/route.test.ts:149,165` / `lib/cards/build-new-client-card.test.ts:57` / `lib/cards/get-dexie-session-cards.test.ts:35` / `app/(app)/app/exams/[id]/_components/*.test.tsx` (5件) / `app/(app)/app/exams/_components/exam-list-live.test.tsx:58,92` / `app/(app)/app/_components/dashboard-actions.test.tsx:55` / `lib/sync/pull.test.ts:51,67` / `lib/sync/optimistic-mutation.test.ts:80` / `app/(app)/app/study/smart/page.test.tsx:118` / `study-session-host.test.tsx:66` / `session-runner.test.tsx:105` / `lib/db/cards-delta.test.ts` / `lib/db/exams-delta.test.ts` / `lib/db/cards-pull.test.ts` / `lib/db/exams-pull.test.ts`。

### 2.7 dead code 判定 = **全 callsite が「書かれるが読まれない」 dead column**

- INSERT 時 default 0 / pull 時 mapping pass-through のみで、 永遠に 0 のまま流通。
- audit §3 P1 (= `docs/audit/2026-06-12-repo-wide-audit.md:89`) と一致: 「`content_version` 列が exams/cards 双方で宣言済 + client-db 索引持ち、 だが apply / pull / bulk receiver で参照・増分されていない。 LWW は updated_at のみに依存」。

## 3. Phase 4 / Y-3 roadmap 突合

### 3.1 当初設計意図 (`docs/02-tech-spec.md §14.9 / 15.x`)

- 「`POST /api/card-mutations/bulk` で cards 更新 ・ content_version 更新」 と tech-spec L1657 で明示
- = **OCC (Optimistic Concurrency Control) 用の楽観ロック列**として設計
- = Dexie 側に index 持たせて push 時 server 値と比較 → 古い base なら conflict

### 3.2 設計時点の defer 判断 (`s-local-1-design.md:143` / `exam-detail-local-first-write-design.md:54-93`)

- > 「マルチデバイス同編集の OCC: `contentVersion` (server cards 既存 column) で検出可能だが**実装は別 sprint (S-local-N、 N >> 1)**。 last-write-wins から開始」
- > 「OCC (`content_version` の +1 配線): **器は残置、 v1.x**。 演習も持たない (対称)」
- exam-detail 設計の confict 表でも「OCC | 無し (append-only) | defer (`content_version` の器は残置)」
- `recallmint-idb-sync-bestpractice-comparison.md:254`: 「**OCC (content_version 照合) / CRDT / field 単位 merge / 複数人協働: defer (content_version の器は残置、 v1.x)。 将来 multi-user 化したら pull-suppress はマージ方式に置換が必要**」

### 3.3 現フェーズ (Y-2) の前提

- アプリは現在 **単一ユーザー前提**。 詳細滞在中の pull-suppress + LWW (updated_at) で衝突を発生源から消す軽量解で運用 (s-local 系完了)。
- multi-device / multi-user 化は **v1.x 以降** (具体 sprint 未割当)。 Y-3 spec にも `content_version` 関連 task 0 件 (`y2-launch-hardening-design.md:34-37` Y-3 繰越 list = NEXT_PUBLIC_APP_URL / card_tags index / stripe_events processed_at の 3 件のみ)。
- Phase 4 (pull response zod、 sync-fix-1 §1.3 で明示) も `content_version` には触れない。

### 3.4 (a)/(b)/(c) 支持度

| 案 | spec / docs 上の支持 | 評価 |
|---|---|---|
| (a) 廃止 | tech-spec §14.9 / s-local-1 / exam-detail / idb-bestpractice は全て「**器は残置**」 と明言。 即廃止は spec 一貫性を破る (= spec freeze 違反、 CLAUDE.md「Spec の凍結」 規律) | 弱い |
| (b) Y-2 で +1 配線実装 | 単一ユーザー前提では「比較対象」 がない (= 必要性ゼロ)。 工数 M (audit 評価)、 sub-plan C 残 task と並行不可、 sprint 完了 gate を脅かす | 弱い |
| (c) Y-3 繰越 | spec すべての「v1.x で実装」 言及と整合。 sub-plan C T-C4 制約に既に「(c) Y-3 繰越判定時: 本 task のみ Y-3 へ、 sub-plan C は残 5 task で完了可」 と明記済 = pre-authorized fallback | **最強** |

## 4. CC 推奨 + 3 案

### (a) 廃止
- **根拠**: 現状 dead column である事実は明確。 audit P1 の根拠と一致。
- **必要 cleanup**: schema.ts から 2 列削除 / client-db.ts から 2 type + 2 index 文字列削除 / build-new-client-card.ts / cards-mapper.ts (×2) / exams-pull.ts の 5 callsite 削除 / 24 test fixture 修正 / Dexie store version 上げ (`v3` → `v4` のような migration、 column drop) / postgres は drizzle migration 追加 (DROP COLUMN exams.content_version, cards.content_version)。
- **欠点**: spec 全体 (tech-spec / s-local-1 / exam-detail / idb-bestpractice) が「器は残置」 で揃っているのを破壊。 spec 凍結違反。 Dexie migration v4 は実 user の IDB に影響 → 全 user 全 pull 再走 risk あり (現実的に user 0 環境ならコスト無、 launch 前提なら回避したい)。

### (b) versioning gate として実装
- **根拠**: tech-spec §14.9 の当初設計を Y-2 内で確定。
- **Y-2 sprint 内実装可否**: 工数 M (audit) + multi-device 前提なし → **不可** (sprint scope 外、 sub-plan C 残 5 task と budget 競合)。
- **必要 helper**: server 側 mutation apply で `contentVersion = contentVersion + 1` SQL inc + push 時 client が `expectedContentVersion` を送る envelope 拡張 + conflict response の zod + client 側 conflict UX (現状ゼロ)。 envelope / entity-mutation-registry の改修が大きい。

### (c) Y-3 繰越 — **CC 推奨**
- **根拠**: spec 全体 (tech-spec §14.9 / s-local-1 / exam-detail-local-first / idb-bestpractice) が「器は残置、 v1.x で実装」 で 4 docs 一貫しており、 audit P1 の指摘は「**用途決定**」 = 「使うか捨てるか」 で、 v1.x で使う方針が既に確定。 単一ユーザー前提が解除される multi-device 化 sprint (= v1.x) で同時に +1 配線 + envelope 拡張 + conflict UX を 1 sprint で消化するのが整合的。 Y-2 (launch hardening) の scope ではない。
- **取扱**: 本 task のみ Y-3 へ移し、 sub-plan C は残 5 task (T-C1 / T-C2 / T-C3 / T-C5 / T-C6) で完了。 plan T-C4 制約に既載の fallback。
- **記録**: sprint 完了報告 + audit 突合表に「#8 = Y-3 繰越 (OT 判断、 2026-06-12)」 を明記、 帰属 trace を残す (plan T-C4 完了条件文と一致)。

**CC 推奨 = (c) Y-3 繰越**。 根拠は spec 凍結原則と 4 docs 一貫 (「器は残置、 v1.x 実装」)。 audit P1 は「用途決定」 が要件で、 「即時実装 / 即時廃止」 ではない — Y-3 繰越判定自体が一つの「決定」 として audit 要件を満たす (todo / audit 突合表に明記すれば取り残し扱いではない)。 ただし最終決定は OT。 (a) を選ぶ場合は spec 4 件を同時に「器も廃止 / 単一ユーザー前提継続」 に書き換える必要があり、 別 task 化が望ましい。
