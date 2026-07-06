# DDD リファクタ top-level design decisions

- 日付: 2026-07-06 / branch: `dddrefactor`(develop `8b4a1e9` から分岐)
- 根拠調査: `docs/audit/2026-07-05-ddd-refactor-investigation.md`(統合版・現状検証済。§ 参照は同 doc)
- 本 doc の役割: **プログラム全体の確定判断と phase 進捗の SSoT**。各 phase の実装詳細は持たない(phase ごとの spec / plan が持つ)。仕様判断が変わる場合は本 doc を更新してから phase spec に反映する。

---

## 1. 確定判断(OT 確定・2026-07-06)

### D-1. pragmatic DDD

domain 純粋層 + use-case 関数 + 既存 seam 昇格。フル DDD(全 aggregate に entity クラス + repository の機械的導入)はしない。
**client 側は既存 `runOptimistic*` を application service に昇格し、新 repository 層は作らない**(mirror 書込 + outbox enqueue + flush kick は persistence でなく application transaction であり、repository 抽象はこれを不可視化するため)。

### D-2. wire 変更系はスコープ外 + 凍結契約の定義

audit §6.2(pull の wire generic 化 / outbox 2 系統統合 / 競合解決統一)は今回やらない(→ §3)。
**凍結対象 = 「挙動同一の契約」**: API payload shape / Dexie schema※ / entity_mutations 形式、に加えて **error code・HTTP status・user-facing 日本語文言・cache header・revalidatePath 対象・tombstone entity_type・op 名・ops/log イベント名**。全 phase の review 観点に含める。
※ Dexie schema は D-6 により data 喪失観点の凍結は解除。ただし契約としての形(store 名・index・型)の変更は別 commit 隔離(D-6)。

### D-3. 安全網 = contract/golden test を標準

P0 で /api/pull response・mutation envelope・review-events bulk result・upload result union・webhook 状態遷移の snapshot を固定し、以降の全 phase の回帰検知の正とする。Playwright/E2E は**任意**(必要と判断した時点で別途 OT 相談 — 新規依存のため)。

### D-4. P0 から sprint 化

全 phase の安全網が P0 で作られるため先頭が正しい。phase 順は P0 → P1 → P2 → P3 → P4(§2)。

### D-5. 着手時期 = 今

dddrefactor branch 上で開始。exams UI への機能追加が進むほど P3 対象が広がるため先送りしない。

### D-6. DB 全消去可(prod 含む)の反映

- **Dexie 移行コード・lazy migration・旧版 schema 保持は書かない**。Dexie 変更は version bump + 旧定義削除で行う。
- Dexie store/index 変更は data 喪失リスクとしては**解除**(audit §6.2 の「pending outbox 喪失リスク」は前提消滅)。
- ただし **Dexie schema 変更は DDD 抽出(コード移動・層再編)とは別 commit に隔離**する — bisect 可能性の維持(「移動で壊れたのか schema で壊れたのか」を切り分け可能に保つ)。
- **隔離対象は「形の変化」に限定**:
  - store の追加・削除・index 変更 = D-6 隔離対象(別 commit)。
  - 既存 store の中身削除のみ(store 名・index・型は不変)= 通常の抽出 commit に同居可。
  - 理由 = bisect の切り分け対象は「schema の形が変わったか」であり、データの有無ではない(全消可のため)。形が不変なら「移動で壊れた」以外の疑いが無く隔離不要。

---

## 2. Phase 進捗表

定義は audit §7 の骨子(1 行要約)。詳細は各 phase spec が持つ。

| Phase | 内容(1 行) | 状態 | 完了時 HEAD | 再スキャン記録 |
|---|---|---|---|---|
| P0 | contract/golden tests + smoke checklist + import 境界 lint(allowlist 方式)+ dead code・stale 掃討 | 未着手 | — | — |
| P1 | domain 純粋層の抽出・移設 + 二重実装の仕分け・単一 source 化 | 未着手 | — | — |
| P2 | server 側 use-case 化(review-events route → webhooks 2 本 → process.ts 分解) | 未着手 | — | — |
| P3 | client 側 use-case 化(タグ CRUD 移設 / card write 集約 / side peek 複製解消 / runOptimistic* 昇格 / inline primitive 統合) | 未着手 | — | — |
| P4 | インフラ DRY(outbox flush 層の限定共通化 / pull server 内 factory / retry・transient 統合 / 認証 wrapper / lib 再編) | 未着手 | — | — |

**運用注記**:

- 各 phase は sprint フロー(brainstorming → spec → plan → 実装 + canonical/Codex review)に載せる。phase 完了時に本表へ **完了時 HEAD SHA** と **再スキャン箇所**(着手時に audit の該当主張を現 HEAD で再確認した範囲と結果)を記録する。
- audit の file:line は `5d3baef` 検証時点。**phase 着手時に対象箇所を再スキャン**し、stale があれば audit でなく phase spec 側に現状を記す(audit は歴史記録として凍結)。
- 状態欄の値: 未着手 / spec 起草中 / plan 確定 / 実装中 / 完了(SHA 記録済)。
- **状態欄の更新は各 phase の CC が該当 commit と同じ commit で行う**(spec 起草開始時 → spec 起草中、plan 確定 commit 時 → plan 確定、実装 commit 時 → 実装中、完了時 → 完了 + HEAD SHA 記録)。OT push で確定する。

---

## 3. やらない 4+1(理由の記録)

後から「なぜやらなかったか」を追うためのセクション。解除には OT 判断を要する。

| # | やらないこと | 理由 |
|---|---|---|
| N-1 | **競合解決 3 方式(replay / LWW / server-wins)の統一** | **反 DDD だから**。FSRS=event replay、entity 編集=LWW、mirror=server-wins は各 context のドメイン特性に合った正しいモデルであり、統一は「見た目の一貫性」のために意味論を壊す。恒久にやらない(deferではない)。 |
| N-2 | **outbox 2 系統(entity_mutations ⇄ answer_events)の統合** | **defer**。価値小: review 系のみ retry controller / pullBack hook / session grouping を持つ非対称(検証済)で、統合は大改修の割に得るものが薄い。将来 3 系統目が必要になった時に再評価。 |
| N-3 | **pull の完全 generic 化(PullResponse 型そのものの wire generic 化)** | server 内 factory 化(wire に出ない範囲)は **P4 で in scope**。wire generic 化は残り 2 割の**任意 consider** — P4 spec 起草時に費用対効果を見て判断し、採らない場合は理由を P4 spec に記す。 |
| N-4 | **Dexie schema の再設計(store 分割・index 全面見直し等)** | **別 sprint**。DDD 層再編と直交する関心。D-6 により移行コスト自体は低いが、混ぜると bisect 可能性と review 粒度を壊す。本リファクタ中の Dexie 変更は「抽出に必要な最小限 + 別 commit 隔離」のみ。 |
| N-5 | **client 側 repository 層の新設**(= D-1 の裏面) | **唯一の pragmatic 判断点として明示**。教科書的 DDD なら repository を置く場面だが、Dexie mirror + outbox + flush は application transaction であり、隠蔽すると coalesce / rollback / pull-back の同期挙動が不可視化する(audit §5.3、Codex 指摘 3)。`runOptimistic*` の application service 昇格で代替する。 |

---

## 4. 変更履歴

- 2026-07-06: 初版(OT 確定判断 D-1〜D-6 / phase 表初期化 / やらない 4+1)。
- 2026-07-06: D-6 に Dexie 隔離対象の明確化(形の変化に限定)、進捗表に状態更新の責任者・タイミングを追記。
