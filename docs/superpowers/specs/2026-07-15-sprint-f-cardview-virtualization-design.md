# Sprint F spec: カードビュー freeze 修正(仮想化 + 前提 2 件)

- **日付**: 2026-07-15 / **起草 HEAD**: `develop` `748e8bf`
- **状態**: rev2(claude.ai レビュー反映済: G 通常則化・W0 分割・F6 follow-up 記録。OT 承認待ち。承認後に writing-plans)
- **fact-finding**: `docs/audit/2026-07-15-b1-scope-reduction-and-cardview-freeze-factfinding.md` §1(記述は本 spec 起草時に現 HEAD で再検証済)

## 1. 背景 / 目的

約 300 件のカードを持つ試験のカードビューで inline 編集から抜けるとブラウザが応答不能になる。fact-finding の静的 trace により原因 = **未仮想化 O(N) 同期再レンダー**(枚数/レイアウト起因・ループではない)と確定。1 commit(blur)→ 単一 `useLiveQuery`(`inline-card-list.tsx:93-119`)再発火 → 全 card が新 identity(`toExamDetailCard` :103)で降り、未 memo の重い `CardEditorFields` × N を同期再レンダー。

**OT 確定判断**: 小規模 repro は取らない。実証 = 修正 → OT push/deploy → 既存 300 件 seed 試験で OT 人力 smoke。カードビュー仮想化は仮説の当否に関わらず単独価値(T2 資産の共有)があるため先に修正する。

## 2. スコープ / 非スコープ

**スコープ(3 点のみ)**:
- **S**: カードビューへの仮想化移植(`useWindowVirtualizer` + native + top/bottom spacer + `measureElement` + `getItemKey=card.id`・型 swap 厳禁)
- **W1(前提①)**: `newCardIds` autoEditOnMount Set への consume 経路追加
- **W2(前提②)**: `InlineOptionCell` への commit-on-unmount 付与(データ保全)

**非スコープ**: 画像 4 欄化(Sprint I)/ 表描画(Sprint T)/ props 参照安定化・per-row `React.memo`(§8.4)/ 多択行高肥大対策(§9・監視)/ side-peek blur workaround の撤去(§7.4)/ テーブルビューへの変更。

**順序制約(絶対)**: W0・W1・W2 は S より前に着地。**branch 内のどの時点でも「仮想化あり・ガードなし」の状態を作らない**(仮想化は unmount を常態化させるため、W2 なしで S を入れると option 編集消失が実害化、W1 なしだと誤 auto-edit が発生)。

## 3. 現状事実(spec 起草時に現 HEAD で再検証済)

| # | 事実 | 根拠 |
|---|---|---|
| F1 | カードビューは未仮想化(`cards.map` 全 mount)| `inline-card-list.tsx:268-319` |
| F2 | `newCardIds` Set に consume 経路なし。正しさが「cell が unmount/remount しない」ことに明示依存(仮想化時の誤 auto-edit をコメントが予告)| `inline-card-list.tsx:159-179` |
| F3 | `InlineTextField` は commit-on-unmount **あり**(latestRef 自己整合 snapshot + 削除済 card 存在 gate)| `inline-text-field.tsx:142-164` |
| F4 | `InlineOptionCell` は commit-on-unmount **なし**(unmount cleanup は timer clear のみ)。blur 時 `onSave` のみ | `inline-option-row.tsx:294-298` / `use-card-options.ts:134-141` |
| F5 | side peek は F4 の workaround として close 時に `activeElement.blur()` を明示発火 | `exam-card-side-peek.tsx:55-63` |
| F6 | `runOptimisticUpdate` は missing row でも enqueue する(`store.update` 0 行でも throw せず後続 enqueue 実行)→ 削除済 card への unmount commit は orphan mutation になる | `optimistic-mutation.ts:275-280` |
| F7 | T2 資産(テーブル)= element-based `useVirtualizer` + spacer `<tr>` + `measureElement` + `getItemKey` + 単一 Memoized body(型 swap 厳禁の教訓)| `exam-card-table.tsx:132-139` / `exam-card-table.remount.test.tsx` |
| F8 | `useWindowVirtualizer` は app 内未使用・installed `@tanstack/react-virtual@3.14.5` に export 実在(新 dep 不要)| `node_modules/@tanstack/react-virtual/dist/esm/index.d.ts:49` |
| F9 | jsdom は layout 計算不可。仮想化テストの先例 = Fix-3 T2「有界窓」非空振りパターン(N=200 → 描画行数 0 < count < N のみ担保、窓サイズ実測は stg smoke に委譲)| `exam-card-table.test.tsx:779-805` |
| F10 | カードビューの行間は `<ul className="space-y-2">`(margin ベース)| `inline-card-list.tsx:268` |

## 4. Phase 構成と commit/tag 方針

```
G(安全網)→ W0(InlineCardRow verbatim 抽出)→ W1(consume)→ W2(commit-on-unmount)→ S(仮想化)
```

| Phase | 種別 | review | tag |
|---|---|---|---|
| G | test(挙動変更なし・非真空性が review 対象)| canonical + Codex | `[reviewed]`(通常則)|
| W0 | refactor(verbatim 移動のみ・挙動不変)| canonical + Codex | `[reviewed]`(通常則)|
| W1 | fix(挙動変更)| canonical + Codex | `[reviewed]`(通常則)|
| W2 | fix(**データ保全**)| canonical + Codex | **tag 無し commit → OT smoke 後 session doc を [reviewed] 正記録**(stg smoke 要の重要 Fix 規律・GC v2 W2 と同型)|
| S | fix(構造変更・表示内容不変)| canonical + Codex | `[reviewed]`(通常則。freeze 仮説の実証は smoke で別途 = §11)|

各 phase の完了条件: 対象 test green + 既存 test 無傷 + review Critical 0 / Important 0 + 上記 tag 方針。sprint 完了 gate: whole-repo `pnpm lint --max-warnings=0` exit 0。

## 5. G(安全網): characterization 監査結果と欠落分

**監査結果 — 編集離脱→commit の現挙動はほぼ pin 済**(golden 非 cover 領域だが component test が厚い):

| 挙動 | pin 状況 | 根拠 |
|---|---|---|
| text field: blur → mirror + enqueue / no-op skip / null 正規化 | ✅ | `inline-text-field.test.tsx:178-356` |
| text field: commit-on-unmount(保存核心 / not-editing / clean / 存在 gate / blur→unmount 二重 commit なし)| ✅ | `inline-text-field.test.tsx:820-924` |
| text field: dirty-guard(編集中 clobber なし / idle 同期)| ✅ | `:683-817` + debounce test `:167-215` |
| autoEditOnMount one-shot(mount 即 edit / blur 後再 edit しない)| ✅ | `:474-524` |
| option: blur → onSave → mirror + enqueue / no-op skip / 該当 index のみ書換 / ghost ライフサイクル | ✅ | `inline-option-row.test.tsx:114-435,672-771` |
| card 追加 → 新 card のみ auto-edit / 2 連続追加は最後のみ | ✅ | `inline-card-list.test.tsx:442-509` |
| **option: blur 済み後 unmount → 追加書込なし**(W2 の二重 commit ガード前提)| ❌ 欠落 | — |

**G の追加分 = 欠落 1 件のみ**: 「option cell を編集 → blur(commit 1 回)→ その後 unmount → 追加の mirror 書込/enqueue が発生しない」を pin(現挙動として真・W2 後も不変のため characterization として安全)。「unmount で編集値が失われる」現挙動は **pin しない**(W2 で意図的に変える挙動を固定しても即捨てになるため)。

## 6. W0(InlineCardRow verbatim 抽出)+ W1(newCardIds consume 経路)

### 6.1 W0: InlineCardRow の verbatim 抽出(挙動不変)

現 inline map の中身(`inline-card-list.tsx:269-318` の `<li>` 内)を module scope の `InlineCardRow` へ **verbatim 移動のみ**。hook 追加なし・props 追加なし・挙動不変。W1(consume effect)と S(measureElement ref)の持ち場を先に用意する。

**なぜ W1 と分離するか(移動と書換えの分離)**: 表示不変 ≠ reconciliation 不変 — component 境界が 1 枚増えれば fiber が増え hook の持ち主が変わる。定義位置を誤れば(render 内定義・key 不安定)subtree 全 remount = 本 sprint が扱う病理そのものを自作する。verbatim 移動を単独 commit にすることで、抽出の瑕疵を W1/W2 のガードに隠さず bisect 可能に保つ。

**完了条件**: 既存 test(`inline-card-list.test.tsx` / `inline-card-list-live.test.tsx`)が**無傷で green** = 挙動不変の客観証明。

### 6.2 W1: consume 経路

**目的**: 仮想化下の remount で `autoEditOnMount=true` が再発火し誤 auto-edit する穴(F2)を塞ぐ。

**consume 境界(確定)**: **該当 card 行の初回 mount 直後**(行 level `useEffect`)。
- W0 で抽出済みの `InlineCardRow` に mount effect を追加: 「自分の `card.id` が Set にあれば親の `consumeNewCardId(id)` を呼ぶ」。親は functional updater で Set から削除(`inline-card-list.tsx:159-179` コメントが予告した経路の実装)。
- **正当な auto-edit は殺さない**: 子 `InlineTextField` の `useState` initializer(one-shot 読取)は**render 中**に走り、consume の effect は **render 後**に走る。同一 mount 内で「読取 → consume」の順序が React の実行モデルで構造的に保証されるため、初回 mount の auto-edit は必ず発火してから Set が縮む。
- **再発火しない**: 以後の remount(scroll-out → scroll-in)時は Set に id が無く `autoEditOnMount=false`。
- consume は冪等(Set delete)・StrictMode の effect 二重実行でも安全。
- 追加が off-screen になるケースは §8.3(scrollToIndex)が吸収(可視化 → mount → auto-edit → consume)。

**W1 test**: ① 既存 `inline-card-list.test.tsx:442-509`(追加→auto-edit / 2 連続)が**無傷で green**(consume が正当経路を壊さない証明)② 新規:「追加 → auto-edit 発火 → 該当行を unmount → remount しても edit mode に入らない」(remount は RTL の rerender + key 変更等で実 unmount を起こす。仮想化前でも行 component 単体で検証可能)。

## 7. W2: InlineOptionCell commit-on-unmount

**目的**: 仮想化で常態化する scroll-out unmount 時に option 編集中の値が失われる(F4)のを防ぐ = データ保全。

### 7.1 設計(InlineTextField F3 と同型・既存パターンに乗る)

- `InlineOptionCell` に latestRef 自己整合 snapshot(`{editing, editValue, 比較基準 value, save}`)+ empty-deps cleanup を追加: `editing && editValue !== value` の場合のみ保存経路を呼ぶ。
- **blur→unmount 二重 commit ガード**: blur handler で `latestRef.editing = false` を**同期反映**(`inline-text-field.tsx:242-247` の Codex P2 fix と同一手法)。blur が先に走った same-batch unmount では cleanup が skip。

### 7.2 存在 gate(F6 対応・必須)

`runOptimisticUpdate` は missing row でも enqueue するため(F6)、unmount 経路の保存は **card 存在確認を挟む**: `use-card-options.ts` に existence gate 付き unmount 用 handler を新設し(`getClientDb().cards.get(cardId)` → 存在時のみ commit)、cell の cleanup はそれを呼ぶ。semantics は `inline-text-field.tsx:154-159` と同一(scroll-out=card 生存→commit / 削除=card 不在→skip)。**blur 経路は不変**(触らない — InlineTextField も blur 経路は gate なしで対称)。

### 7.3 test 非真空化(必須要件)

- **実 unmount で検証**: RTL で `InlineOptionList` を render → edit 突入 → 入力 → `unmount()` を呼び、mirror 書込 + outbox enqueue を assert。**mock で cleanup を握らない**(`inline-text-field.test.tsx:820-924` の実 unmount 方式と同一 = 先例が非真空を実証済)。
- test 構成は text field 側 5 本と対称: #1 保存核心(editing+dirty→unmount→保存)#2 not-editing guard #3 clean guard #4 存在 gate(card 削除後 unmount→enqueue なし)#5 blur→unmount 二重 commit なし。
- **scroll-out 起因の unmount は jsdom で再現不可**(layout 非計算・F9)。unmount() 直呼びが React の実 unmount ライフサイクルを通るため unit の担保はこれで足りるが、「scroll が unmount を起こす→保存される」の end-to-end は **OT smoke 項目 ②(§10)に落とす**。

### 7.4 side-peek workaround との関係

F5 の明示 blur は W2 後は冗長になるが**撤去しない**(scope 外・挙動同一: blur が先に commit → cleanup は editing=false で skip = 二重 commit なし。#5 test がこの共存を pin)。撤去は別途 chore として起票可。

## 8. S: カードビュー仮想化(useWindowVirtualizer)

### 8.1 構成

- カードビューは page flow の `<ul>`(内部 scroll container なし)のため **`useWindowVirtualizer`**(F8。T2 の element-based と異なる点はここのみ・他は T2 資産踏襲)。
- options: `count=cards.length` / `estimateSize=() => ESTIMATED_CARD_HEIGHT`(定数。多択 card は `measureElement` が補正)/ `overscan=3`(行が table 行より桁違いに高いため T2 の 5 より絞る。実機 smoke で調整可)/ `getItemKey=(i) => cards[i].id`(F7 踏襲・sort 変動時の index-key churn 防止)/ **`scrollMargin`=リスト先頭の document offset**(window 座標系との原点合わせ。element-based の T2 には無かった window 固有の注意点)。
- DOM: `<ul>` 内に **top spacer `<li aria-hidden>` + 可視 items(`ref={measureElement}` + `data-index`)+ bottom spacer `<li aria-hidden>`**(native flow・absolute positioning 不使用 = T2 spacer `<tr>` 方式の移植)。
- 行 component は **W0 で抽出済みの `InlineCardRow`**(§6.1)に `measureElement` ref + `data-index` を追加配線する。**型 swap 厳禁**(F7 教訓): 条件分岐で component 型を切り替えない・key は `card.id` 固定。
- SSR fallback(`initialCards`)/ empty state / 見出し件数 / 「+ カードを追加」の描画は不変。

### 8.2 行間 margin の扱い(高さ計算の落とし穴)

`space-y-2`(F10)は li 間 margin であり **`measureElement` は margin を測らない** → spacer 高さと実 layout が drift する。行間は **li 内 padding(`pb-2` 相当)へ移し、margin を仮想化の高さ計算外に出す**。視覚上の間隔は不変に保つ(mobile `space-y-3` / md `space-y-2` の responsive も padding で再現)。

### 8.3 「+ カードを追加」の UX 保持

現挙動: 追加 → 新 card mount → auto-edit の `focus()` が browser 標準で scroll-into-view。仮想化後は off-screen = 未 mount = focus も scroll も起きないため、**追加後に `scrollToIndex`(新 card の位置・`align: 'auto'`)で可視化**する(→ mount → auto-edit 発火 → W1 consume)。**align は `'auto'`**(rev2 訂正・当初 `'end'`): scrollToIndex の職務は position でなく mount で、正確な位置は直後の auto-edit `focus()` の scroll-into-view が担う。`'end'` は position 指定 → focus() 上書きで二度 scroll(4500px 級 card で往復が目視)。jsdom では window scroll が no-op のため、この経路の end-to-end は smoke 項目に含める(§10 ⑤)。

### 8.4 memo 方針(明示的にやらないこと)

per-row `React.memo` は**導入しない**。理由: `toExamDetailCard` が毎 tick 新 identity を返す現構造では memo は不発(props 参照安定化はより大きな改修 = scope 外)、かつ仮想化により再レンダー対象が可視窓(≈10 行)に有界化されるため freeze 修正に不要(YAGNI)。T2 の「単一 Memoized body」は列 resize 凍結の文脈でありカードビューに resize は無い — 持ち込むのは「型 swap 厳禁・stable key」のみ。

### 8.5 S の test(jsdom 制約下)

- **有界窓 test(F9 先例の移植)**: N=100 を mirror に seed → 描画 `<li>`(row)数が `0 < count < N`。window virtualizer は `window.innerHeight`(jsdom 既定 768)+ `estimateSize` で窓が成立するため container shim 不要見込み(成立しない場合は vitest.setup の offset shim を流用)。窓サイズの実測・scroll 追従は smoke へ委譲(F9 と同じ切り分け)。
- **既存 test 無傷**: `inline-card-list.test.tsx` / `inline-card-list-live.test.tsx` は小 N(≤5)で全行が窓 + overscan 内に収まり green を維持する(= 表示内容不変の characterization)。崩れる場合は test の書き換えでなく実装側を疑う。
- scrollToIndex は jsdom で no-op のため mount 経路のみ unit で担保(§8.3)。

## 9. 多択行高肥大(explanation 常時表示)の扱い: **今回スコープに含めない(監視)**

- 事実: 各 option 行は explanation cell を常時 instance 化(`inline-option-row.tsx:194`)し、20 択 card は極端に高い(fact-finding §1-1)。
- 判断: 仮想化 + `measureElement`(ResizeObserver 追従)は可変行高を前提設計として吸収する。explanation のトグル化は**挙動/UX 変更**であり freeze 修正に必須でない(YAGNI・scope 規律)。可視窓に多択 card が 1-2 枚入っても再レンダー対象は有界。
- **リスク認識**: 極端な可変行高は measure jitter(scroll 中の spacer 高さ再計算による飛び)とコスト増を招きうる。
- **再燃条件(これを満たしたら別 task 起票)**: OT smoke で「多択 card 前後の scroll で目視できる gap/飛び/カクつき」または「編集離脱は直っても scroll 自体が重い」が観測された場合。対策候補 = explanation トグル化 / estimateSize 精緻化 / overscan 調整。

## 10. OT smoke checklist(人力・push/deploy 後)

1. **仮説の実証(最重要)**: 既存 300 件 seed 試験のカードビューで「inline 編集に入る → 抜ける(blur)」が固まらない。複数 field(問題文/選択肢/解説)で反復。
2. **W2**: option 編集中に scroll-out(行が画面外へ)→ 戻って値が保存されている。
3. **W1**: 新規カード追加後に scroll して該当行を出し入れしても誤 auto-edit(勝手に編集モード)しない。
4. **S 描画健全性**: 全域 scroll で spacer 飛び・行高 jitter・空白帯がない(多択 card 前後を重点)。件数見出し・空 state・削除・タグ操作が従来どおり。
5. **追加 UX**: 「+ カードを追加」→ 新 card へ scroll + 問題文 auto-edit(既存 UX 保持)。
6. **回帰**: side peek 経由の option 編集保存が従来どおり / テーブルビューの cell 編集 enter/exit が無変化(共有 primitive を触るため 1 pass)。

## 11. 失敗時の扱い(必須分岐)

**修正後も 300 件で freeze する場合**: fact-finding の静的 trace 結論(ループ不在・枚数起因)が**誤りだった**ことを意味する。この場合:
- **仮想化で糊塗しない・追加の緩和(memo 追加・debounce 延長等)を積まない**。
- 観測事実(どの操作で固まったか・可能なら Performance trace)を添えて **claude.ai へ即上げ(Critical 扱い)**。自走継続条件の例外(未解決 Critical)に該当し、CC 単独で次の修正試行に入らない。
- 「固まらないが遅い」の中間結果は Critical ではなく、観測値を記録して OT 判断(§9 の再燃条件と照合)。

## 12. 影響範囲 / 触らないもの

- **触る**: `inline-card-list.tsx`(W0 行 component 抽出 → W1 consume → S 仮想化)/ `inline-option-row.tsx`(W2 latestRef + cleanup)/ `use-card-options.ts`(W2 unmount 用 existence gate handler)/ 対応 test(G 含む)。
- **触らない**: `exam-card-table.tsx` 系(テーブルビュー)/ `inline-text-field.tsx`(F3 で完備)/ `card-editor-fields.tsx` / side peek / sync 層(`optimistic-mutation.ts` 等)/ server 側全部。
- 新 dep なし(F8)。`.env` 変更なし。migration なし。
- **follow-up(本 sprint では触らない・記録のみ)**: 「`runOptimisticUpdate` は missing row でも enqueue する」契約(F6)は 3 人目の unmount-commit 実装者が踏む地雷。現状は unmount commit 経路 2 箇所とも call site gate・blur 経路は両方とも意図的に gate なし(対称)で、rule of three 未充足ゆえ局所 gate が正 — helper への契約明示 or gate 内蔵の要否は別途起票して判断。
