# S-local-1 cards local mirror / offline 演習 設計調査

- 起票日: 2026-05-26
- 種別: investigation outline (= design spec 化 前段の調査範囲整理)
- 状態: 調査範囲のみ確定、 実装方針未確定
- 前提 sprint: S-cache 系列 close (`docs/superpowers/sessions/2026-05-26-s-cache-series-close.md`)

## 目的

回答イベントは既に Dexie-first (S-cache-1 で実装済) になっている。 次は
「カード本体を local に持つか」 「due 判定を client に寄せるか」
「offline 演習をどう成立させるか」 を **調査する** sprint。

着手目標は MVP として local-first offline 演習が一通り回せる状態だが、 まず
要件 / 設計トレードオフ / 既存 Dexie schema との差分 / 段階的移行ステップを
整理してから実装する。

**本 sprint では実装しない**。 調査と design spec drafting のみ。 実装は別
sprint (S-local-2 以降) で別途 plan 化。

## 非ゴール (本 sprint 範囲外)

- cards / exams / properties の Dexie schema 確定 (調査結果を見てから別 sprint で
  drafting)
- FSRS scheduler の client 移植 (TS port が必要、 重い)
- Service Worker / Workbox 等の offline shell 構築
- 完全 offline 演習の実装 (調査結果を受けて MVP 範囲を確定後 別 sprint)
- conflict resolution の本格設計 (last-write-wins で行くか、 ベクタクロック等で
  行くかは別議論)
- マルチデバイス同期の UX 設計
- dashboard dueCount の local projection (S-cache-3.2 と同じ理由、 cards local
  pull が前提として必要なため本 sprint 後の話)

## 調査項目

### 1. cards local mirror の必要性 / 範囲

- 何のために cards を local に持つか (offline 演習 / FSRS due 計算 / inline 編集
  optimistic 等の use case 整理)
- 持つカラムは何か (全 column? FSRS state + content だけ? user-editable 部分は除
  外?)
- 何件くらいまで保持するか (上限 / pagination / 古い exam の eviction 戦略)
- pull 戦略 (起動時全量 / on-demand / Δ pull / Last-Modified base)

### 2. 既存 Dexie schema との差分

`lib/client-db.ts` の現状 (S-cache-1 で確定):
- exams (pull cache、 read-only として placeholder)
- cards (pull cache、 sync_status index あり、 write path 未配線)
- user_settings
- study_sessions (write、 PK = client UUIDv4)
- answer_events (write、 event_id 冪等)
- card_mutations (inline 編集 debounce 用、 mutation_id 冪等)
- sync_meta (key-value)

調査ポイント:
- 既存 cards table の column 定義は今の use case で十分か (実装未配線なので
  schema migration は早期に固めるべき)
- cards local mirror に必要な column を追加するなら schema version up が必要か
- exam も write path (cards pull に exam metadata 必要) を切るか

### 3. FSRS due 判定を client に持つ場合の影響

- server: `submit-review-tx.ts` で `ts-fsrs` を使い `cards.due / state / stability
  / difficulty / elapsed_days / scheduled_days / reps / lapses / learning_steps`
  等を更新中
- client 側に FSRS 計算を移すなら `ts-fsrs` を client bundle に含める必要 (bundle
  size 影響を測定)
- server / client で同 FSRS パラメータ (w / desiredRetention 等) を同期する仕組み
  が必要 (user_settings 経由で持つか、 fixed config か)
- 計算結果は server authoritative にどう reconcile するか (= server 側で再計算
  上書き or client 値を server が受領)

### 4. server authoritative との reconcile

- cards 一覧の pull: full snapshot vs Δ (`updated_at` cursor) vs CRDT
- write path の冪等性: 既に answer_events / card_mutations は event_id /
  mutation_id で冪等。 cards.update を client から打つ場合は同様の mutation_id
  pattern を踏襲できるか
- 同一 card への concurrent edit (別デバイス) の解決方針:
  Option A: last-write-wins (timestamp ベース)
  Option B: server が contentVersion で OCC 検出、 conflict は手動 merge
  Option C: CRDT / OT (overkill)
- offline 中の write が server reach 時に conflict した場合の UX

### 5. bulk sync / retry / conflict handling の延長

既存 bulk endpoint (`/api/review-events/bulk`) は answer_events + study_sessions
upsert のみ。 cards local mirror を導入する場合の追加 endpoint 検討:
- `GET /api/cards/sync?since=...` で Δ pull
- `POST /api/cards/sync` で client → server の mutation push
- retry / backoff / online 検知 / visibilitychange トリガー (§14.7.1 に既述あり)

### 6. offline 演習 MVP の最小範囲

「最小限の offline 演習」 として何が必要か:
- session 開始時に必要な card 一覧を local から取得 (cards local mirror 必須)
- 回答 → 判定 (client) → Dexie answer_events 記録 (既存)
- FSRS due 計算 (client) → cards local の state 更新 (新規)
- online 復帰時に bulk sync (既存 + cards mutation 追加)

最小 MVP の範囲を絞る場合、 次のような段階分けが考えられる:
- Phase α (本 sprint 後 / S-local-2): cards local pull (read-only mirror、 起動
  時 full snapshot)、 server 側は無変更
- Phase β (S-local-3): FSRS client 計算 + cards local write (client が cards
  ローカル更新後 server に push)
- Phase γ (S-local-4 以降): offline 演習成立 (online 切断中も session 通せる)
- Phase δ (将来): Service Worker / app shell / offline UI

各 Phase が独立 sprint として価値を持つかを評価。

### 7. dashboard dueCount への波及

cards local mirror + FSRS client が揃った時点で初めて、 S-cache-3.2 (dueCount
local projection) が現実的になる。 本 sprint 中はその設計まで踏み込まない。

### 8. 今やるべき最初の 1 sprint の候補

調査結果を踏まえて、 次の design spec drafting で具体化する候補:

候補 X: cards local pull (read-only) の MVP
- 起動時 / dashboard 表示時に全 cards を Dexie cards table に pull
- 一旦は server authoritative 維持、 local cards は read 専用
- FSRS は server 側で従来通り、 client は cache としてしか使わない
- MVP 価値: 次 sprint で local read を活用する基盤、 cards local mirror の
  pull / sync の動作確認

候補 Y: FSRS client 計算の PoC
- ts-fsrs を client bundle に追加し、 同一入力で server / client が同値を
  返すことを vitest で確認
- 実 user 影響なし、 影響範囲は bundle size と library 互換性確認のみ
- 候補 X より先行可

候補 Z: 両方 (cards pull + FSRS PoC) を 1 sprint で
- 工数は中、 ただし review 範囲が広がる

候補 W: schema 確定だけ
- cards local mirror の column 拡張、 sync_meta key 設計だけを別 sprint
- migration は drizzle / Dexie 両側で必要

## 進め方 (本 sprint 内)

1. 上記 1-7 の各項目について file / code を grep して現状確認 (read のみ)
2. trade-off を整理した design spec を `docs/superpowers/specs/` に drafting
3. OT に design レビュー (本 investigation の output → 確定 design spec)
4. 確定後、 候補 X-W の中から最初の 1 sprint を OT が選択
5. その sprint の plan を別途 `docs/plans/` に drafting (writing-plans skill 経由)

本 sprint で 1-3 まで完了させ、 4-5 は次 mini sprint。

## 期待される deliverable

- design spec: `docs/superpowers/specs/2026-05-26-s-local-1-design.md`
  (名前は確定時に固める、 -investigation を -design に置換 or 別名)
- 1 sprint candidates X-Z-W の trade-off 比較表
- OT 判断ポイントの明示 (FSRS client 化のスコープ / cards full pull の制限 等)

## 関連ファイル (調査時に読む候補)

- `lib/client-db.ts` (Dexie schema)
- `lib/sync/review-events.ts` (sync helper、 cards にも同 pattern 適用予定)
- `lib/cards/submit-review-tx.ts` (server FSRS 計算)
- `lib/db/schema.ts` (cards / reviews / study_days drizzle schema)
- `docs/02-tech-spec.md` §13.14 (local-first 設計記述、 §14 (IndexedDB schema /
  sync flow)
- `package.json` (ts-fsrs / dexie バージョン)
