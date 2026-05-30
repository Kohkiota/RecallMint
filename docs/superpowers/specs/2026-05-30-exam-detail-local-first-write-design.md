# 試験詳細画面 local-first 書込化 — 設計 spec

- **日付**: 2026-05-30
- **種別**: design spec
- **前提**: 演習読込 増分 pull 化 (step 1-7) 完了。本 spec は試験編集 (**書込**) 側を、
  演習と対称な local-first にする。
- **関連**: 比較ドキュメント `recallmint-idb-sync-bestpractice-comparison` §1 原則A / §7 / §8-1 /
  §11 / §12、`s-local-1` design (`/api/card-mutations/bulk` + Dexie `card_mutations` table の構想)
- **実装はまだしない。本 spec の承認後に `writing-plans` で plan 化する。**

---

## 1. 目的 / 背景

試験詳細 (`/app/exams/[id]`) の card 編集を、演習側で確立した local-first / outbox パターンと
対称な形にする。すなわち「IDB へ即時書込 → UI は手元の状態で即時表示 → 背景で自動的に server へ
送信」。

現状は React state/ref のみの揮発書込 + server action 直叩きで、永続層が欠落している (§8-1)。
編集値は drain 前に reload / crash すれば失われ、送信は debounce 後の単発呼出で、失敗時の
永続 retry も無い。本 spec はこの非対称を解消し、演習で実証済みの outbox / flush / pull-back
機構を書込側へ流用する。

## 2. スコープ

### 含む

- **card 編集の書込を local-first 化**: IDB 直書き (Dexie 永続 outbox + cards mirror) + 背景 flush。
- **詳細画面は cards mirror を `useLiveQuery` で直読み**: 表示の真実は IDB 一本 (component state の
  二層管理を持たない)。編集も mirror へ optimistic 直書きし、表示は IDB 直読みで返ってくる。
  入力中フィールドのカーソル保護は既存 inline component の dirty-guard (編集中 / 送信中は外部値で
  上書きしない) を流用する。
- **永続 outbox**: 既存の dormant な Dexie `card_mutations` table を活用 (`mutation_id` 冪等)。
  `(cardId, field)` 単位で coalesce — 最新値が pending を上書き、深さ 1 の永続版。
- **送信口**: bulk endpoint。`s-local-1` 構想の `/api/card-mutations/bulk` を実装し、
  `/api/review-events/bulk` と対称にする。ドメインロジック (owner-scope UPDATE /
  `correct_answer_ids` 再生成 / `card_count` / tombstone) は既存関数を内部流用する。
- **`createCard` 冪等化**: client 生成 id + `ON CONFLICT (id) DO NOTHING`。
  `updateCardField` (overwrite=自然冪等) / `deleteCard` (tombstone `onConflictDoNothing`=既に冪等)
  は据え置き。
- **送信タイミング**: edit → 500ms debounce で outbox を drain (debounce を「送信遅延」から
  「drain」へ移設、§3-3) + ambient (mount / visibilitychange / online) flush + retry/backoff
  (transient のみ、429 即停止) + best-effort pagehide flush。**interval polling は入れない**。
- **二重送信防止**: 演習流用 — 冪等 key (`mutation_id` / `createCard` は client id) + in-flight
  guard + Web Locks (`runGuardedFlush`)。
- **入口 pull kick**: 詳細 mount で `runGuardedPull` を 1 回 kick。layout の `PullTrigger` は
  一覧 → 詳細の内部遷移で再発火しないため、入口 fresh pull を明示配線する。
- **詳細画面 滞在中は ambient pull を suppress**: 詳細滞在中は layout 常駐 `PullTrigger` /
  `runGuardedPull` の ambient 発火 (mount / visibilitychange / online) を止め、離脱で再開する。
  mount で suppress on・unmount で必ず suppress off を **React cleanup に紐付け**、解除し忘れを
  構造的に防ぐ。単一ユーザー前提のため、編集中に取り込むべき他者変更が存在せず、滞在中 pull を
  止めても失うものがない (発生源から衝突を消す軽量解)。

### 含まない (defer)

- **OCC** (`content_version` の +1 配線): 器は残置、v1.x。演習も持たない (対称)。
- **複数人協働 / CRDT / field 単位 merge**: 本アプリは単一ユーザー前提のため、滞在中 pull-suppress
  という軽量解で衝突を発生源から消す。将来 multi-user 化したら、pull-suppress は (Notion 等が採る)
  協働マージへ置換が必要 (滞在中も他者変更を取り込む必要が出るため)。
- **真の offline / Service Worker**。

## 3. 衝突方針

ベストプラクティス裏取り (low-stakes・単一ユーザーは LWW + フィールド単位の自然マージが推奨、
OCC/CRDT は overkill) に基づく。

### ケース1: 自分の pull と自分の未送信編集のかち合い

- **詳細滞在中は pull を suppress するため、自分の pull × 自分の編集の衝突はそもそも発生しない**
  (発生源から消す)。滞在中に未送信編集を mirror 上で潰す ambient pull が走らないので、
  `bulkPut` 除外 (dirty-guard) は不要 = 撤去。
- flush 成功 → **pull-back** (演習と同型) は維持するが、位置づけは「離脱後 / suppress 再開後の
  最新化」。自分の確定値を mirror に引き戻し時系列整合を取る。

### ケース2: 他デバイス変更との衝突

- **後勝ち (LWW)**。`updateCardField` はフィールド単位なので、重ならないフィールドは自然マージ
  (両方残る)。同一フィールドのみ後勝ち。
- `options` は配列まるごと 1 フィールドのため、配列ごと後勝ち (部分マージ不可、低リスク&単一
  ユーザーで許容)。
- client 時計ずれ問題は、打刻の DB `now()` 統一 (増分 pull step1) で回避済。

## 4. 演習からの機構流用マップ

| 項目 | 演習 | 試験詳細 (本 spec) |
|---|---|---|
| working set | 入口 Dexie snapshot、再 read なし | cards mirror を `useLiveQuery` で直読み (IDB 一本) |
| 表示 | component state | IDB 直読み (component state 二層なし、編集も mirror 直書き) |
| 書込 | `answer_events` outbox (append-only) | `card_mutations` outbox + mirror 直書き。update は自然冪等、`createCard` のみ client id + `ON CONFLICT` |
| push | 5 件 / 完了 / ambient / retry | debounce-drain / ambient / retry |
| pull | ambient + flush 後 pull-back | ambient (**滞在中は suppress**) + 入口 kick + 離脱後 pull-back |
| 二重送信防止 | 冪等 key + in-flight + Web Locks | 同型 |
| OCC | 無し (append-only) | defer (`content_version` の器は残置) |

## 5. 確定事項 (旧「要確認」、全て確定済)

- **送信口** = bulk endpoint (`/api/card-mutations/bulk`)。dormant な `card_mutations` table +
  `s-local-1` 構想を活用、演習と対称。
- **ケース1 の手当て** = 詳細滞在中の **pull-suppress** (発生源から衝突を消す)。flush→pull-back は
  離脱後 / 再開後の最新化として維持。**pending card の pull 除外 (dirty-guard) は撤去** (suppress で
  不要)。
  (改訂註: 旧案「flush→pull-back + pending card pull 除外」は dirty-guard を mirror 層に持つ複雑さが
  あり、単一ユーザー前提では滞在中 pull を止める方が単純。本改訂で pull-suppress に変更。)
- **入口 pull kick** = 足す (詳細 mount で 1 回)。
- **送信タイミング** = debounce-drain + ambient + best-effort pagehide、interval なし。

## 6. 参照

- 比較ドキュメント `recallmint-idb-sync-bestpractice-comparison` §1 / §7 / §8-1 / §11 / §12
- `s-local-1` design (`docs/superpowers/specs/2026-05-26-s-local-1-design.md`)
- 本スレ調査ログ: `updateCardField` / `createCard` 現状、`PullTrigger` mount 位置、演習セッションの
  スナップショット隔離
