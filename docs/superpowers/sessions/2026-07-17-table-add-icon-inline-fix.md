# Sprint T follow-up: テーブルビュー選択肢 add アイコンの行内 co-locate 修正

- **日付**: 2026-07-17
- **branch**: develop / **commit**: `5a913a9`(fix・[reviewed])
- **対象 file**: `app/(app)/app/exams/[id]/_components/exam-card-table-options-edit-cell.tsx`(+ 同 `.test.tsx`)
- **前提**: Sprint T 追加バッチ item2 = d680526「テーブルビューに画像 add affordance を配線」の follow-up

## 症状

選択肢列の add アイコン(compact ImagePlus)が explanation 下の **別 wrapper**(`mt-0.5 flex flex-wrap items-center gap-2`)に置かれ、独立行を取っていた。text 非空の選択肢ごとに 1 行ぶん行高が増える。card view / side peek では add は × の直左にインラインで収まっている。

## 修正

- `slot="add"` gallery を **row 1(checkbox + 本文 + × の行)へ移動**し、× 削除ボタンと共有の
  `<div className="flex shrink-0 items-center gap-0.5">` にまとめた(card view `inline-option-row.tsx:262` と同一グルーピング)。
- 下段の別 wrapper は撤去し、`slot="thumbnails"` gallery を **bare render**(wrapper なし)に縮退。
  `CardImageGallery` は画像 0 で `null` を返す(`card-image-gallery.tsx:222`)ため、空 DOM 増ゼロ。
- add の gate は `opt.uid && userId && opt.text.trim().length > 0`(旧 nested 形と論理等価)。
  空 ghost 選択肢への添付 = `option:<ghost uid>` 孤児化を防ぐ既存 gate を維持。

**不変であること(review で byte 一致確認済)**: add gallery の props(`images` / `target=option:<uid>` /
`cardId` / `userId` / `slot` / `compact` / `attachAriaLabel`)は変更なし = attach 経路は不変、DOM 配置のみ移動。
hidden file input は add gallery 内にあるため trigger→input 配線も不変。× の tap-target(`min-h-8 md:min-h-6`)/ a11y も不変。

## なぜ効くか(density は列ごとに効き方が違う — 一般化した論拠が誤りだった)

d680526 で add affordance を table 列に配線する判断の際、claude.ai は「Sprint I で icon は小さく
圧縮済であり、問題文セルは表の描画で数百 px あるので icon の寄与は無視できる」と述べた。**これは
問題文 / 解説 / メモ 列にしか当てはまらない**。

- 問題文 / 解説 / メモ列 = セル 1 個が数百 px 高。add icon が独立行を取っても相対寄与は小さい。
- **選択肢列 = 各選択肢がコンパクトな行**(px-1.5 py-0.5)。1 行増えると **選択肢数ぶん倍加**する。
  todo Phase 4 の監視項目「多択 card 行高肥大: 20択 ≈ 4531px」に直結。

→ 「icon 寄与は無視できる」を全列に一般化したのが誤り。density(縦密度)への add icon の効き方は
**列の 1 セル高で決まる**ため、コンパクトな繰り返し行(選択肢)では独立行が致命的に効く。行内
co-locate(card view と同じ)が正。

## test

- ⑥ `deleteBtn.parentElement` が add ボタンを内包する構造 assert(同一行 = 同一コンテナ)。
  破損状態では add は別 wrapper(row 1 の sibling)にあり contain されず RED。RED→GREEN 実証済。
- ghost gate 既存 test(③-c text 空 → add 出ない / ② uid 無し → gallery 出ない)回帰なし。
- 既存 table 系 回帰なし: 40 file test green / exams 966 green / tc0 / whole-repo lint exit 0。

## review

- **canonical**(`superpowers:requesting-code-review` / general-purpose / template 改変なし):
  Ready to merge — Critical 0 / Important 0 / **Minor 1**。Minor = thumbnails の `mt-0.5` 喪失(bare render)。
  card view の bare thumbnails(`inline-option-row.tsx:117`)準拠の **意図的**挙動ゆえ code 変更不要。
- **Codex 独立**(`scripts/ai/codex-review.sh table-add-icon-inline`): Critical 0 / Important 0 / Minor 0。
  raw = `docs/codex/2026-07-17-table-add-icon-inline.md`。git clean detector PASS。
- 収束: 未解決 Critical 0 / Important 0(1 周で収束)。

## smoke checklist(OT push 後)

CC 検証困難な実 attach を含むため OT 実機/stg。

1. **[本項]** 選択肢 5 件のカードで、add アイコンが × の隣に収まり **行高が増えていない**こと。
   多択カード(選択肢が多いもの)でも同様。row-count / scroll-height を証拠に(20択で 4531px から縮む実測)。
2. **[論点2 の穴閉じ]** テーブルビューから **実際に 1 回だけ**画像を添付(選択肢 1 件に 1 枚)。
   reload して残っていれば PASS。理由: mock unit test は attach 経路が呼ばれたことしか証明せず、
   `meta.userId` が実行時 undefined でも通る(署名付き URL 403 は実 upload 時のみ)。「新配線 × mock
   では捕まらない失敗モード」を 30 秒で閉じる。※本 fix は userId 源(prop)不変ゆえ回帰ではないが、
   d680526 の add 経路の実 attach 未 smoke を併せて閉じる。
3. thumbnails のある選択肢で、add 行内化後の余白(explanation 直下に thumbnail が接する)が読める見た目か目視。

## 停止

Sprint 境界で停止。OT push → smoke。
