# inline 編集 2 不具合 調査 (2026-06-01)

read-only 調査。HEAD = `6baeaf4` (縦揃え self-center + autosize `0px` のみ。末尾改行正規化
`67ab653` は revert 済)。両不具合とも 6baeaf4 で再現。原因とコード箇所の特定が目的、修正はしない。

---

## 結論 (要約)

- **不具合1 (空選択肢の後方移動・残留)**: **`70d0714` (2026-05-25) で混入**。本 sprint
  (A1-A3 `dc62038`/`f927c5c`/`3ea3eed`、`6baeaf4`) でも revert 済 `67ab653` でもない。
  70d0714 が「連続追加で 2 つ目が消える」を直すため、merge を `setOptions(serverOptions)`
  (ghost evict=空削除) から `[...serverOptions, ...localGhosts]` (ghost 末尾保持) に変えた
  **トレードオフ回帰**。空選択肢は commit 対象外 (sanitized 除外) のまま working-set に残り、
  serverOptions 更新のたびに末尾へ append され続ける。「以前は blur/同期時に削除」= 70d0714 前の
  evict 挙動。
- **不具合2 (末尾空改行が表示で 1 つ減る)**: データは全数保持 (mirror/server)。表示の
  `<span white-space:pre-wrap>` が**末尾の単一改行を line box 化しない** CSS 挙動が原因。
  該当: `inline-text-field.tsx:273` / `inline-option-row.tsx:554`。
- **2 つは独立**。不具合1=InlineOptionList の working-set/merge/commit/ghost、不具合2=display
  span の CSS。共有経路なし。`67ab653` B-1 は ghost 判定 (`.trim().length`) に対し trim 不変で
  **ghost ロジックに干渉しない** (6baeaf4=B-1 なしでも不具合1 再現 → 無関係)。

---

## 調査軸1: 不具合1 (空選択肢) のコード特定と発生時期

### 関連コード (`inline-option-row.tsx`, `InlineOptionList`)
- **ghost 生成** `handleAddOption` (`:235-246`、blame=**a1e4b58** S2.0b-3): 「+ 選択肢を追加」で
  `{id, text:'', is_correct:false}` を working-set 末尾に追加、**commit は呼ばない** (コメント
  `:232-234`「text='' は ghost、sanitize で除外」)。
- **commit の ghost 除外** `commit` (`:153-162`、blame=**8a59a95** Task 4.2): `sanitized =
  target.filter((o) => o.text.trim().length > 0)`。空 (whitespace-only 含む) は mirror/enqueue の
  どちらにも入らない=**永続化されない**。
- **merge 戦略** useEffect(`[serverOptions]`) (`:114-122`、blame=**70d0714**):
  ```
  const serverIds = new Set(serverOptions.map((o) => o.id))
  const localGhosts = optionsRef.current.filter((o) => !serverIds.has(o.id))
  const merged: CardOption[] = [...serverOptions, ...localGhosts]
  setOptions(merged)
  ```
  → server 確定値に **無い** working-set 行 (=未 commit の空 ghost) を**末尾に append**。
- **空 ghost を blur で消す処理は無い**。working-set からの除去は明示的削除ボタン
  `handleDeleteOption` (`:250-256`) のみ。`handleCellSave` (`:211-221`) は値更新のみ・空でも残す。

### 後方移動・残留の機構 (再現「空追加→次に文字→交互→blur」)
1. 「+追加」→ 空 ghost G を末尾追加 (未 commit)。
2. 別の選択肢 R に文字入力 + blur → `handleCellSave` → `commit` → `sanitized` が **G を除外**し
   mirror/enqueue は実選択肢のみ。mirror 更新。
3. `useLiveQuery` → `serverOptions` prop 変化 → merge useEffect: `localGhosts=[G]` (G は server に
   無い) → `merged=[...serverOptions, G]` で **G を末尾へ移動**。`setOptions`。
4. 繰り返すと空 ghost が末尾に蓄積 (選択肢 7/9/11/13 が末尾に固まる)。空は永続化されないが
   working-set には残り表示され続ける → **後方移動・残留**。

### 発生 commit と「以前の正しい挙動」 (70d0714 message が明示)
- **70d0714 前**: merge は `setOptions(serverOptions)` で working-set を**一括置換**。server に無い
  local ghost は **evict (消える)** = 「空選択肢が同期時に削除される」旧挙動。
- 70d0714 はこの evict が「連続追加で typing 中の 2 つ目 ghost まで消す」race を起こすため、
  ghost を末尾保持する merge に変更 (message 引用: 「serverOptions に存在しない local ghost を
  末尾 append、user の編集中状態を保護」)。
- → **不具合1 は 70d0714 のトレードオフ回帰**。typing 中 ghost の保護 (改善) と引き換えに、
  「放置された空 ghost が末尾に残留」を新規に生んだ。両立には「編集中 ghost は保護 / 放置された
  空 ghost は除去」の区別が要る (現状はその区別が無い)。

### sort_key について (軸1-4 の前提補正)
選択肢に sort_key は無い。選択肢の順序は `card.options` 配列の index。後方移動は **merge の
配列末尾 append** によるもので、sort_key 再採番は無関係 (sort_key は card 側の field)。

---

## 調査軸2: 不具合2 (末尾改行表示) のコード特定

### 該当行 (display mode の値表示)
- `inline-text-field.tsx:273`: `<span className="whitespace-pre-wrap break-words">{displayText}</span>`
- `inline-option-row.tsx:554`: `<span className="whitespace-pre-wrap break-words">{value}</span>`
(両 component の display 分岐。edit 側は `<Textarea>`。)

### 「データに残る」×「span で 1 つ畳まれる」の特定
- データ: mirror/server とも末尾改行を全数保持 (前回 stg 実測 `"あ\n\n"` 保持、commit の trim は
  ghost 判定の `.trim()` のみで値非加工、server schema も multiline は trim 無し)。
- 表示: `white-space: pre-wrap` の span は **コンテンツ末尾の単一改行に line box を生成しない**
  (CSS の既知挙動)。一方 `<textarea>` は末尾改行の空行を必ず描画。前回 stg 実測:
  `"テスト\n"` → textarea 48px(2行) / span 32px(1行)、`"あ\n\n"` → textarea 68px(3行) /
  span 50px(2行) = **末尾の最後 1 改行ぶんだけ非描画**。autosize `0px` (6baeaf4) は textarea の
  scrollHeight を末尾空行込みで返すため edit 側は全描画、span 側のみ 1 行欠ける。

### display のみで「入れた数ぶん表示」する選択肢 (コード箇所付き・列挙のみ)
対象は上記 2 span。いずれも **display レンダリングのみ**で ghost ロジック・保存・検索は不変。
- **(2-a) 行分割描画**: `value.split('\n')` し各行を `<div>`/`<span>` + `<br/>` 等で描画。末尾空文字列
  要素も 1 行ぶん高さを持たせれば末尾改行が見える。影響: コピー時の改行 (要素間の改行扱い)、
  空行の高さ確保 (空 div は `min-h`/`<br>` 必要)、break-words の維持に注意。
- **(2-b) 終端の高さ確保要素を条件付与**: `value` が末尾 \n の数 N で終わるとき、span 末尾に N 個の
  改行ぶんの placeholder (例 `{trailing}` 個の `<br/>` か空行) を足す。最小変更。影響: textContent
  に余分要素が混ざらないよう aria/コピー対象から除外する配慮。
- **(2-c) display を `<textarea readOnly>` 化**: edit と同一描画で完全一致。変更大。影響: コピー/
  選択/a11y/クリックで edit 開始のハンドリングを textarea 用に再設計。
- (2-d) 純 CSS: `white-space: break-spaces` は末尾**空白**の扱いが pre-wrap と異なるが、末尾**改行**
  の line box 生成は仕様上保証されず信頼できない (列挙のみ・非推奨枠)。
各案とも ghost ロジック・保存 payload・enqueue には非干渉 (display 専用)。検索は DB 値 (改行保持)
依存で表示変更の影響なし。コピーは 2-a/2-b で textContent 構成が変わり得る点のみ注意。

---

## 調査軸3: 2 つの不具合の関連

1. **独立**。不具合1 は `InlineOptionList` の working-set/merge(`:114-122`)/commit(`:153`)/ghost
   ライフサイクル。不具合2 は display span の CSS (`inline-text-field.tsx:273` /
   `inline-option-row.tsx:554`)。共有する条件分岐は無い。
2. **67ab653 (revert 済 B-1) は不具合1 と無関係**:
   - B-1 は `InlineOptionCell.handleBlur` で `onSave(kind==='id' ? editValue : editValue.replace(/\s+$/,''))`
     と保存値を末尾 trim していた。
   - だが ghost 判定は `o.text.trim().length > 0` (`commit:155`) で **trim 不変** — whitespace/改行
     のみの値は B-1 有無いずれでも `.trim().length===0` で ghost 扱い。B-1 は ghost 分類を変えない。
   - 不具合1 は **B-1 を含まない 6baeaf4 で再現** → 因果なし。「B-1 が ghost に干渉」という仮説は
     不成立 (B-1 の保存値 trim は ghost 判定に影響しない)。両者は「option 編集に触れる」点以外で
     独立。

---

## 修正の選択肢 (推奨なし・列挙のみ)

### 不具合1 (空選択肢の残留・後方移動)
- **(1-a) 放置 ghost の除去を merge/blur に追加**: merge で localGhosts を「現在 auto-edit 中
  (`autoEditOptionId`) または focus 中の 1 件のみ保持、それ以外の空 ghost は drop」に絞る。
  70d0714 の typing 保護を壊さず放置空を消す。`:114-122` を改修。
- **(1-b) blur 時に空 ghost を除去**: 空セルの blur (`InlineOptionCell.handleBlur` / 親
  `handleCellSave`) で、その row が空かつ編集対象から外れたら working-set から除去。`:211-221`。
- **(1-c) 70d0714 前の evict に戻す + 別途 typing 保護**: merge を一括置換に戻し、編集中 ghost は
  別 state で保持。70d0714 が直した「2 つ目消失」を再発させない設計が必要 (難度高)。
- いずれも mirror/enqueue は既に ghost を除外済 (永続化は正しい) なので、working-set 表示の
  ライフサイクルのみの問題。

### 不具合2 (末尾改行表示)
- (2-a) display 行分割描画 / (2-b) 末尾に高さ確保要素 / (2-c) display textarea 化 / (2-d) 純 CSS
  (上記軸2 参照)。display 専用でデータ・ghost 非干渉。

---

## 発生 commit まとめ
| 不具合 | 発生 commit | 種別 |
|---|---|---|
| 1 空選択肢 残留・後方移動 | **70d0714** (2026-05-25) | merge 戦略変更のトレードオフ回帰 (a1e4b58 ghost + 8a59a95 sanitize が前提) |
| 2 末尾改行 表示減 | 元から (span pre-wrap の CSS 挙動、spans は 414720a 系で導入) | 仕様由来・回帰ではない |

本 sprint (A1-A3 / 6baeaf4) も revert 済 67ab653 も**いずれの不具合の原因でもない**。
