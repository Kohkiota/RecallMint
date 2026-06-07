# Tag-4b-fix stg smoke checklist (Notion 方式 popover UI)

> 対象 commit: Tag-4b-fix Tasks 1〜5 を統合した単一 commit (controller が後で積む)。
>
> **核心**: Tag-4b 本体 smoke (`docs/superpowers/plans/2026-06-07-tag-4b-smoke-checklist.md`) は旧 row 方式 (全カテゴリ常時表示 + dropdown) で PASS 済。 本 fix は **Notion 方式 popover UI に全面再設計**: 付与済タグのみバッジ表示 + 「+ タグを追加」 button → 2 stage popover。 本 checklist は再設計後 UI の動作と regression なしを検証する。

## 環境情報

- URL: https://stg.recallmint.nekotest.net/app/exams/08ec7835-db67-4e45-b402-db776ba93048
- アカウント: `komail9server+clerk_test@gmail.com` / pw `komail9server` (memory `stg-smoke-login`)
- IDB 名: `recallmint`
- 対象 exam: `Sync1 Smoke Exam` (id=`08ec7835-db67-4e45-b402-db776ba93048`、 Tag-4b smoke で使用済)
- 既存残骸 (Tag-4b smoke 後): `Smoke分野` (multi) + `Smoke-4b-single分野` (single) + 各配下 option
- deploy commit: Tag-4b-fix 統合 commit (controller が push 後に記入)
- 対象 card ID: (smoke 中に `dump('cards')` で控える)
- mobile 要否: **必要** (DevTools mobile view 600×800 程度)

## 事前準備

1. ログイン → `/app/exams/08ec7835-...` を開いて pull 完走。
2. DevTools console: `dump` / `readCardTags(cardId)` helper を定義 (Tag-4b smoke checklist §事前準備参照)。
3. DevTools Network: `/api/entity-mutations/bulk` と `/api/pull` を filter。
4. 対象 card を 1 件選定、 `<cardId>` としてメモ (`dump('cards')` で id を控える)。
5. カテゴリがなければ `/app/tags` で事前に multi / single 各 1 件 + option 2〜3 件 作成。

---

## 観点チェックリスト

PASS = (1) 期待動作通り、 (2) console error 0 (Clerk dev domain DNS 失敗は除外)、 (3) 全 API 200。

---

### 1. バッジ「カテゴリ名: option名」 表示

**確認手順:**
- 予め 1 枚の card に任意の tag を 1 件付与してあること (Tag-4b smoke 残骸か、 本 smoke 中に先付与)
- 試験詳細 page の対象 card 行を確認

**期待挙動:** タグ section に「`{カテゴリ名}: {option名}`」 形式のバッジ pill が表示される。 見出し横の「タグ管理 →」 link は存在しない (popover footer のみ)。

| 結果 | Notes |
|------|-------|
|      |       |

---

### 2. バッジ × で即解除 (optimistic)

**確認手順:**
- バッジ右端の「×」 span を click

**期待挙動:** reload なしでバッジが即消滅 (optimistic IDB delete + enqueue)。 ~500ms 後に `POST /bulk` 200。

| 結果 | Notes |
|------|-------|
|      |       |

---

### 3. バッジ本体 click で edit popover open (該当カテゴリ option のみ)

**確認手順:**
- バッジ pill の × 以外の部分 (「カテゴリ名: option名」 テキスト部分) を click

**期待挙動:** そのバッジのカテゴリに対応する edit popover が開く。 popover 内には該当カテゴリの option list のみ表示 (他カテゴリの option は出ない)。 現在付与中の option に checkmark / checked 表示。

| 結果 | Notes |
|------|-------|
|      |       |

---

### 4. edit popover で multi toggle / single radio / 0 個許容

**確認手順:**
- multi カテゴリのバッジ click → option を複数 toggle → popover 開いたまま複数選択できることを確認
- single カテゴリのバッジ click → 別 option 選択で入れ替え → 同一 option 再 click で 0 個に戻る

**期待挙動:**
- multi: popover 閉じずに複数 toggle 可
- single: 選択直後に popover 閉じる、 同 option 再 click で解除 (0 個許容)

| 結果 | Notes |
|------|-------|
|      |       |

---

### 5. 「+ タグを追加」 button 1 つだけ表示

**確認手順:**
- card の「タグ」 section を確認
- 「+ タグを追加」 button の個数を数える

**期待挙動:** card ごとに「タグを追加」 button が 1 つだけ存在。 旧 UI の「+ 追加」 dropdown が各カテゴリ行にあった形とは異なり、 section 末尾に 1 つのみ。

| 結果 | Notes |
|------|-------|
|      |       |

---

### 6. stage 1 カテゴリ選択 → stage 2 option 選択

**確認手順:**
- 「タグを追加」 button を click
- stage 1 でカテゴリ一覧が表示されることを確認
- カテゴリ行を click して stage 2 (option 一覧) に遷移することを確認

**期待挙動:**
- stage 1: カテゴリ名 + 型アイコン (multi=ChechkSquare / single=Circle) + → arrow が表示
- stage 2: 選択したカテゴリの option 一覧が表示。 付与済 option に check icon

| 結果 | Notes |
|------|-------|
|      |       |

---

### 7. stage 2 で Esc → stage 1 に戻る (Notion 方式)

**確認手順:**
- popover を開いて stage 2 (option 選択) まで進む
- Esc キーを押す

**期待挙動:** popover が閉じずに stage 1 (カテゴリ選択) に戻る。 「カテゴリ選択へ戻る」 ← button が表示されている状態での Esc も同様。

| 結果 | Notes |
|------|-------|
|      |       |

---

### 8. stage 1 で Esc → popover 閉じる

**確認手順:**
- popover を開いて stage 1 (カテゴリ選択) の状態で Esc キーを押す

**期待挙動:** popover が閉じる。 stage はリセットされ、 次回 open 時は stage 1 から始まる。

| 結果 | Notes |
|------|-------|
|      |       |

---

### 9. tag manager link は popover footer のみ (見出し横にない)

**確認手順:**
- カード行の「タグ」 section の h3 見出し付近を確認
- popover を開いて footer 部分を確認

**期待挙動:**
- 見出し「タグ」 の横に「タグ管理 →」 link は存在しない
- popover の footer に「タグ管理 →」 link が表示される (`/app/tags` へ)

| 結果 | Notes |
|------|-------|
|      |       |

---

### 10. カテゴリ 0 件 placeholder + link (popover 内)

**確認手順:**
- カテゴリが 0 件の状態 (事前に `/app/tags` で全カテゴリ削除、 または別 exam/account で確認) で試験詳細 page を開く
- 「タグを追加」 button を click

**期待挙動:**
- popover 内に「カテゴリがありません。 タグ管理 → でカテゴリを作成してください」 placeholder が表示
- placeholder に「タグ管理 →」 link が含まれる
- タグ section 本体 (popover 閉じた状態) には placeholder テキストは表示されない

| 結果 | Notes |
|------|-------|
|      |       |

---

### 11. option 0 件カテゴリで placeholder + link

**確認手順:**
- option が 0 件のカテゴリを選択して stage 2 へ進む

**期待挙動:**
- stage 2 に「このカテゴリには option がありません」 placeholder が表示
- 「タグ管理 →」 link が表示される
- popover footer の「タグ管理 →」 は非表示 (placeholder に link 済のため重複防止)

| 結果 | Notes |
|------|-------|
|      |       |

---

### 12. whole-set 不変条件 (他カテゴリ落とし回避)

**確認手順:**
- 同一 card で multi カテゴリ A と single カテゴリ B の両方に tag を付与
- カテゴリ A のバッジを × で削除
- `readCardTags('<cardId>')` で IDB 確認

**期待挙動:** カテゴリ A の tag が消えても、 カテゴリ B の tag は残る。 `POST /bulk` の `patch.value` が全カテゴリ横断の whole-set (A 側の解除後も B 側の option_id を含む)。

| 結果 | Notes |
|------|-------|
|      |       |

---

### 13. 案 a 取り直し (reload + pull で IDB 反映)

**確認手順:**
- tag を付与または解除 → `POST /bulk` 200 確認
- page reload → pull 完走を確認
- `readCardTags('<cardId>')` で IDB 確認

**期待挙動:** reload 後も操作結果が維持される。 server 側 whole-set replace が正しく反映され、 取り直し後も card_tags が一致する。

| 結果 | Notes |
|------|-------|
|      |       |

---

### 14. 既存 regression (試験詳細 card 編集、 タグ管理 page) 動作

**確認手順:**
- 同 card で title / 問題文 などの inline 編集が依然動作することを確認
- `/app/tags` のタグ管理 page を開き、 カテゴリ / option の基本操作 (任意 1 観点) が動作することを確認
- card 追加 / 削除 button が動作することを確認

**期待挙動:** Tag-4b-fix は card-tags-section のみの変更。 他の機能 (card 編集、 タグ管理 page、 card 追加削除) は影響なし。

| 結果 | Notes |
|------|-------|
|      |       |

---

## 総合判定

| 判定 | Notes |
|------|-------|
| (PASS / FAIL) |       |

## 残課題

(smoke 完了後に記入)

---

## 参照

- 設計仕様: `docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md`
- plan: `docs/superpowers/plans/2026-06-07-tag-4b-fix-popover-ui.md`
- Tag-4b 本体 smoke checklist: `docs/superpowers/plans/2026-06-07-tag-4b-smoke-checklist.md`
- Tag-4b 本体 smoke 結果: `docs/superpowers/sessions/2026-06-07-tag-4b-stg-smoke.md`
- UI 主要 file:
  - section (orchestrator): `app/(app)/app/exams/[id]/_components/card-tags-section.tsx`
  - badge: `app/(app)/app/exams/[id]/_components/card-tag-badge.tsx`
  - edit popover: `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx`
  - add popover (2 stage): `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx`
  - option list (shared sub): `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx`
  - parent (4 store subscribe): `app/(app)/app/exams/[id]/_components/inline-card-list.tsx`
