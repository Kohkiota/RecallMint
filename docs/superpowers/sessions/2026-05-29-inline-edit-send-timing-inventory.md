# インライン編集 (/app/exams/[id]) サーバー送信タイミング棚卸し — IDB 配線化の資産切り分け

- 日時: 2026-05-29
- 種別: investigation / session log (**実装変更・commit なし**、 成果物は本 doc のみ)
- 対象 branch: `develop`
- 目的: 試験詳細画面 inline 編集を IDB 配線化 (card_mutations) する際に、 **既存送信タイミング実装のうち流用できる資産 / 編集向けに新規で要る部分**を実コード行で切り分ける
- 手段: grep + 実コード read (推測排除)。 対象 file は grep で自己特定
- 関連: `docs/superpowers/sessions/2026-05-29-localsync-mvp-pre-investigation.md` (前 investigation)、 `docs/cache-fix-roadmap.md` §5、 `docs/superpowers/sessions/2026-05-24-s2-0b-2-optimistic-debounce.md` (本機構の実装 session)

### 対象ファイル (grep + read で特定)

| 役割 | path |
| --- | --- |
| text field cell (sort_key/title/question_text/explanation_text/memo) | `app/(app)/app/exams/[id]/_components/inline-text-field.tsx` |
| option 編集 (親 `InlineOptionList` + view `InlineOptionRow` + cell `InlineOptionCell`) | `app/(app)/app/exams/[id]/_components/inline-option-row.tsx` |
| card 一覧 (cell を配置する親) | `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` |
| 送信先 server action | `app/(app)/app/exams/[id]/_actions/update-card-field.ts` |
| page (cards データ源) | `app/(app)/app/exams/[id]/page.tsx` + `lib/exams/list.ts` |
| 比較対象 (演習側) | `lib/sync/review-events.ts` + `app/(app)/app/study/smart/_components/session-runner.tsx` |

---

## 軸1. 各編集の送信発火イベント

| 編集対象 | 発火イベント | 経路 (file:line) |
| --- | --- | --- |
| 問題文 / タイトル / sort_key / 解説 / メモ (text 5 種) | **blur + 500ms debounce** (onChange は local `value` 更新のみ、 送信しない) | `inline-text-field.tsx`: 編集中 `onChange→setValue` (`:226-228`)、 `onBlur→handleBlur` (`:229,185`)、 handleBlur 内で optimistic `setCommittedValue(value)` (`:207`) → `scheduleSend(value)` (`:211`) → 500ms 後 `send` (`:164-167`) → `updateCardField` (`:137`) |
| 選択肢 本文 / id / 解説 (text cell) | **blur + 500ms debounce** | `inline-option-row.tsx`: cell `InlineOptionCell.handleBlur` (`:597-601`) → 親 `onCellSave`→`handleCellSave` (`:258`) → optimistic `setOptions(nextAll)` (`:267`) → `scheduleSend(nextAll)` (`:270`) → 500ms 後 `send` (`:250-252`) |
| 選択肢 正解 ○× 切替 (checkbox) | **debounce なし即時 send** (進行中の text debounce timer を cancel してから) | `inline-option-row.tsx`: `handleCheckboxToggle` (`:277`) → timer clear (`:279-282`) → optimistic `setOptions` (`:285`) → `await send(nextAll)` (`:289`) |
| 選択肢 追加 (+ボタン) | **送信しない** (optimistic ghost row を local 追加のみ。 text='' は server zod で reject されるため即時送信しない) | `handleAddOption` (`:302-314`)。 user が text 入力+blur すると `handleCellSave` 経由の通常 debounce send に乗る (`:299`) |
| 選択肢 削除 (×ボタン) | **debounce なし即時 send** (timer cancel してから) | `handleDeleteOption` (`:319`) → timer clear (`:321-324`) → optimistic filter `setOptions` (`:325`) → `await send(nextAll)` (`:329`) |

補足:
- **Enter 確定は無い**。 display モードの `onKeyDown` (`inline-text-field.tsx:177-183` / `inline-option-row.tsx:590-595`) の Enter/Space は **編集開始 (startEdit) のみ**。 編集中の Enter は textarea の改行 (送信トリガではない)
- onChange 都度送信は**しない** (local state 更新のみ、 送信は blur 起点)

---

## 軸2. debounce / 発火制御

- **debounce = 500ms**。 定数 `DEBOUNCE_MS = 500` が **両 component に個別定義** (`inline-text-field.tsx:48` / `inline-option-row.tsx:107`)
- 実装場所: **共有 util / hook ではなく、 各 component が `scheduleSend` + `setTimeout`/`clearTimeout` を `debounceTimerRef` で個別実装** (`inline-text-field.tsx:160-168` / `inline-option-row.tsx:246-254`)。 連続 blur は timer reset で最後の値のみ送信
- debounce 以外の発火制御:
  | 制御 | 内容 | file:line |
  | --- | --- | --- |
  | no-change short-circuit | 値が server 確定値と一致なら送信 skip (network 節約) | text: `value === serverCommittedRef.current` (`:197`)、 option: `shallowEqualOptions(sanitized, serverCommittedRef.current)` (`:214`) + handleCellSave (`:263`) |
  | in-flight guard + queue 深さ1 | 送信中なら新値を `pendingValueRef`/`pendingPayloadRef` に queue (深さ1上書き)、 完走後に最新値で連鎖 send | text: `:131-135,153-157`、 option: `:207-210,235-243` |
  | dirty 保護 | 編集中 / in-flight / queue 中は外部 prop 同期を skip (= 未確定値保護) | text useEffect (`:101-113`)、 option useEffect (`:167-176`) |
  | checkbox/delete の timer cancel | 即時送信前に進行中 text debounce を cancel (text 楽観値は options state 経由で同梱) | `:279-282` / `:321-324` |
  | StrictMode 対応 mountedRef | unmount 後 setState 抑止 + timer clear | text `:119-128`、 option `:178-188` |
- throttle / 確定ボタン / 明示 dirty フラグは**無し** (dirty 相当は `value !== serverCommittedRef` の差分判定で代替)

---

## 軸3. 送信粒度

| 対象 | 粒度 | 根拠 |
| --- | --- | --- |
| text 5 field | **field 単位で 1 往復** (each `InlineTextField` が独立に送信) | `updateCardField(cardId, field, target)` (`inline-text-field.tsx:137`)。 server は 1 列のみ UPDATE (`update-card-field.ts:75-103`) |
| options | **card 単位で全 option 配列を 1 batch** | 親 `InlineOptionList` が options 配列全体を保持し、 1 cell/checkbox/delete の変更でも**全 option 配列**を送る (`updateCardField(cardId, 'options', payload)` `:218`)。 server は `options` + `correctAnswerIds` (is_correct から再生成) の 2 列を set (`update-card-field.ts:104-120`) |

- **field 横断の batch は無い** (例: title と question_text を 1 request にまとめない)。 text は per-field、 options は per-card-array、 という 2 粒度が混在
- server action は単一行 owner-scoped UPDATE `.update(cards).set(...).where(eq(id), eq(userId)).returning(examId)` (`update-card-field.ts:142-146`)

---

## 軸4. 楽観的更新 (optimistic UI) / rollback

- **optimistic = あり**。 server 応答を待たず即時 display 反映:
  - text: blur 時に `setCommittedValue(value)` を debounce send の**前**に実行 (`:207`)
  - option: `setOptions(nextAll)` を send の前に実行 (handleCellSave `:267` / checkbox `:285` / delete `:325` / add `:310`)
  - 正解サマリ / 選択肢件数も optimistic `options` state から算出して checkbox と同時即時更新 (`:338,346`)
- **rollback = あり** (失敗時):
  - text: `!result.ok` → `setCommittedValue(serverCommittedRef.current)` で直前 server 値に戻す + `setError` (edit mode には戻さない、 E-1) (`:142-148`)
  - option: `!result.ok` → `setOptions(serverCommittedRef.current)` で**全 row rollback** + `setError`、 queue 破棄 (連続失敗 storm 防止) (`:223-231`)
- rollback target = `serverCommittedRef` (最後に server 成功した値)。 成功時に `target`/`sanitized` へ更新 (`:150` / `:233`)
- 失敗後の retry は**無し** (rollback + error 表示のみ、 queue は捨てる)

---

## 軸5. review-events (演習側) との比較

演習側送信実装: `FLUSH_THRESHOLD=5` (`session-runner.tsx:72`) で 5 件閾値 flush (`:285-286`) + session 完了で全 session flush (`:307`)。 `flushPendingEvents`/`flushAllPendingEvents` (`review-events.ts:245,227`)、 in-flight guard は module-scope `inFlightEventIds` Set を event_id 単位 (`:182,265,278,344`)。

### 共通 (流用できる設計)

| 概念 | review-events | inline 編集 |
| --- | --- | --- |
| in-flight + queue 深さ1 | module Set (event_id 単位、 `:182`) | per-component `inFlightRef` + `pendingValueRef`/`pendingPayloadRef` |
| optimistic-then-send | 回答を Dexie 記録 → background flush | display 即時反映 → debounce send |
| 1 payload に複数まとめて送信 | events 配列 (session 単位) | options 配列 (card 単位) |
| 失敗時 local 保持 | pending 残置で次 trigger 再送 | rollback + error (ただし retry なし) |

### 流用できない / 性質の違い (新規 or 改修要)

| 軸 | review-events | inline 編集 | 含意 |
| --- | --- | --- | --- |
| **永続性** | pending は **Dexie (IndexedDB)** に保存 → reload / route 跨ぎ / tab 跨ぎで生存 | **React state + ref のみ** → unmount / reload / navigation で消失 | inline は永続化ゼロ。 IDB 配線の最大の追加点 |
| **冪等性 key** | `event_id` UNIQUE + server ON CONFLICT DO NOTHING (再送安全) | **冪等 key 無し** (直 UPDATE、 last-write-wins だが mutation_id 不使用) | card_mutations の mutation_id を新規導入要 |
| **trigger model** | count 閾値(5) + session 完了 (+将来 online/visibility) | blur + 500ms debounce + 即時(checkbox/delete) | debounce ロジックは review から流用不可 (inline 固有)。 逆に inline には trigger orchestrator が無い |
| **retry / backoff** | 次 trigger 任せ (backoff なし) で再送 | **retry 一切なし** (失敗で rollback + 破棄) | 永続 retry + backoff を新規導入要 |
| **送信経路** | `/api/review-events/bulk` (単一 tx + bulk SQL) | per-field/per-card の server action 直 UPDATE | bulk endpoint + sync helper 新規 |

---

## 軸6. PullTrigger 全置換 pull による編集上書きリスク

### 現状: 衝突しない (データ源が別)

- `exams/[id]/page.tsx:36` の cards は `getCardsForExam(userId, id)` = **server Drizzle query** (`lib/exams/list.ts` が `getDb()` 使用、 `:1` で「server 限定」 明記)。 inline 編集の表示源は **RSC props** (`card.options` / `initialValue`)、 **Dexie ではない**
- PullTrigger は **Dexie `cards`** に `clear()+bulkPut()` 全置換 (`lib/sync/cards.ts:70-76`)。 exams/[id] page は Dexie cards を**読まない**
- → **現状は pull と編集が disjoint なデータ源** (Dexie ↔ RSC) のため、 pull が編集中値を上書きする危険は**無い**

### IDB 配線化後: 衝突リスクが発生 → 抑制 / dirty 保護が必須

- 編集表示を Dexie cards 由来に切替えると、 PullTrigger の **`clear()+bulkPut()` 全置換**が:
  1. 編集中の optimistic 値を stale な server snapshot で上書き
  2. (card_mutations store 自体は clear 対象外だが) cards 行の楽観値が revert される
- ただし **dirty 保護機構は既に component 側に存在** (`inline-text-field.tsx:101-113` / `inline-option-row.tsx:167-176` が編集中/in-flight/queue 中の外部 prop 同期を skip)。 同じ「pending は上書きしない」 判定を **Dexie pull 側にも持たせれば流用可能**
- → roadmap §5.1 の「編集画面 pull 抑制」 + 「dirty 上書き防止 (`sync_status='pending'` は pull で上書きしない)」 が必要。 現 `clear()+bulkPut()` 全置換を **増分 upsert (pending row skip)** に変える、 もしくは /app/exams/[id] mount 中は pull 抑制する、 のいずれか

---

## まとめ: 資産切り分け

### A. 流用できる既存資産

1. **500ms debounce + scheduleSend/clearTimeout** (`inline-text-field.tsx:48,160-168` / `inline-option-row.tsx:107,246-254`) — card_mutations enqueue の debounce に転用 (ただし共有 util 化されていないので抽出要、 §B-8)
2. **in-flight + queue 深さ1** (送信中は pending ref に上書き、 完走後 drain: text `:131-135,153-157` / option `:207-210,235-243`) — flush の並走制御に転用 (review-events の module-Set 形に寄せても可)
3. **optimistic 反映 + serverCommittedRef rollback** (text `:145,150` / option `:227,233`) — 「IDB write → push 失敗で rollback」 に直対応
4. **dirty 保護 (編集中/in-flight/pending は外部同期 skip)** (text `:101-113` / option `:167-176`) — 「pull で pending を上書きしない」 (軸6) に直対応
5. **no-change short-circuit** (`shallowEqualOptions` / `value===serverCommitted`: text `:197` / option `:214,263`) — mutation の重複送信抑止に転用
6. **card 単位の options batch (全配列 fold)** (`InlineOptionList` の共有 options state `:122-123,148-149`) — 「同 card_id の patch を 1 つに merge してから push」 (前 investigation 軸D-3) の素地
7. **server apply ロジック** (owner-scoped UPDATE + field 別 zod + `correctAnswerIds` 再生成: `update-card-field.ts:71-146`) — bulk route の server 側 apply にほぼ移植可
8. **revalidate (RSC 再実行) による確定値の戻り** (`update-card-field.ts:151-158` のコメント通り、 server action 完了で route segment 自動再実行 → props 更新) — pull-back loop の closure

### B. 編集向けに新規実装が要る部分

1. **Dexie 永続化**: 現状 React state のみで unmount/reload で消失。 編集を Dexie cards に optimistic write + `card_mutations` 行 enqueue する (現編集経路は Dexie 書込ゼロ)
2. **mutation_id 冪等性**: 冪等 key が無い。 mutation_id 採番 + UNIQUE dedup を導入 (形式は前 investigation 軸C-1 の要決定点 = server `uuid` ↔ spec `clientId:uuid`)
3. **bulk push endpoint + sync helper**: `/api/card-mutations/bulk` + `lib/sync/card-mutations.ts` (review-events pattern)。 per-field/per-card の server action 往復を置換
4. **永続 retry / backoff**: 現状 retry なし (失敗で破棄)。 pending 永続 + retry trigger + backoff + 24h drop
5. **cross-route/cross-tab flush orchestrator**: inline debounce は component-scope (unmount で消失)。 5 trigger 制御 + Web Locks (component を跨いだ in-flight 状態管理) を新規
6. **delete 表現**: option 削除は「配列から除外」 で表せるが、 card 削除を card_mutations 経由で表すには schema に type/sentinel が無い (前 investigation 軸B の gap)。 表現方法の決定 + 実装
7. **pull 抑制 / dirty-aware 増分 pull**: PullTrigger の `clear()+bulkPut()` 全置換を pending skip 増分 upsert に、 もしくは編集画面 pull 抑制 (軸6)。 併せて編集表示源を RSC props → Dexie へ切替
8. **debounce の配置/値の見直し**: 現 debounce は **component 内 500ms (送信そのもの)**。 IDB モデルでは enqueue は即時 Dexie write にし、 debounce は **push 層 (roadmap trigger ① = 2s debounce push)** へ移す設計差がある。 500ms→2s の値 + 配置 (UI 層→push 層) の違いを spec で明示

**結論**: 送信制御の「形」 (debounce / optimistic / in-flight queue / rollback / dirty 保護 / no-change skip) は inline 編集側に既に揃っており**転用可能**。 不足は全て **永続化 (Dexie) と それに伴う系** — 冪等 key・bulk endpoint・永続 retry・cross-tab orchestrator・pull 衝突回避 — であり、 これが IDB 配線化の新規実装の核。
