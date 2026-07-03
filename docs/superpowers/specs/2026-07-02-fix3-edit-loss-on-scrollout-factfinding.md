# Fix-3 Important #1: 編集中スクロールアウト消失 — fix 前 fact-finding + 設計(DRAFT・未 commit)

- 種別: fact-finding + fix 設計。実装・commit・push なし。OT 承認で実装 task 化。
- 手法: CC 単独(現物 read)。対象 = whole-branch review Important #1。
- 問題: T2 仮想化で編集中(focus)の行を scroll で overscan 外へ→行 unmount→未 commit 編集が silent 消失。

## 1. InlineTextField の commit/unmount 経路(現物 file:line)

- state: `value`(単一 optimistic, :88)/ `editing`(local, :90)。dirty = `value !== initialString`(:83, initialString = initialValue ?? '')。
- commit 発火点 = **`handleBlur` のみ**(:224-233): `setEditing(false)` → `value === initialString` なら no-op return → 否なら `commit(value)`。
- `commit`(:168-198) = `runOptimisticUpdate`(mirror `cards.update` + outbox enqueue を 1 Dexie rw tx, `skipInternalFlush:true`)+ `scheduleDrain`(500ms debounce)。
- **現状 unmount cleanup**(:142-149)= `useEffect(()=>()=>{ clearTimeout(timer) }, [])` = **timer clear のみ、commit なし**。→ ここが欠落。
- 補足: enqueue は Dexie に同期 persist 済ゆえ drain 取りこぼしは lost-write でない(:137-141)。が、**commit 自体が呼ばれないと mirror/outbox に何も入らない** = これが Important #1 の本体。

## 2. unmount パターン(view 別)と誤 commit 懸念

### card-view(`inline-card-list.tsx`)
- `<li key={card.id}>`(:281, stable key)。コメント(:171-178)が明記: **滞在中 cell は unmount/remount しない**(reorder は move のみ)。**非仮想化 = scroll-out unmount は起きない**。
- InlineTextField が unmount するのは: ① card 削除(mirror から消え `<li>` 消滅)② InlineCardList 全体 unmount(view 切替 card→table / 画面遷移)。
- 削除フロー(`delete-card-button.tsx`): 2-phase confirm。「削除」click(idle→confirm)は **兄弟要素**(:304-306)への focus 移動 → **focus 中 textarea が blur** → `handleBlur` → commit → **editing=false**。その後「削除する」→ `cards.delete`。→ 削除実行時点で editing=false = **commit-on-unmount は発火しない**(editing gate)。**今日と同じ**(今日も削除 click が blur→commit 済)= card-view 削除の挙動は fix で不変。
- view 切替/画面遷移: トグルボタン/リンク click が blur → commit → editing=false。→ 同上、通常は unmount 時 editing=false。

### table(T2, `exam-card-table.tsx`)
- **scroll-out**(問題): wheel scroll は blur しない。focus 中の行が overscan 外へ→`<tr>` unmount。React は tear-down 中 fiber へ synthetic onBlur を確実には投げない(review 指摘)→ **editing=true のまま unmount** → 現状 commit なしで消失。**← fix の対象ケース**。
- bulk 削除 / filter で行消滅: 削除ボタン・filter UI の click が blur → commit → editing=false → unmount 時 editing=false。card-view と同型で安全。

### 結論: editing gate が「保持したい unmount(scroll-out)」を自動選別する
- **ユーザー操作起因の unmount(削除/切替/filter)は必ず click→blur→commit を先に通す = editing=false** → commit-on-unmount 対象外。
- **editing=true のまま unmount するのは実質 scroll-out(table)と blur を伴わない programmatic/remote 除去のみ**。前者は保存したい、後者(remote delete 中に編集)は稀。

## 3. 安全な fix 設計(commit-on-unmount)

### 発火条件
unmount cleanup で **`editing && value !== initialString`(dirty)** の時だけ `commit(value)`。それ以外は skip。

### 冪等バックストップ(区別不要にする)
「blur を伴わない削除中に editing=true で unmount」の稀ケースで commit しても実害なし:
- `runOptimisticUpdate` の `store.update(rowKey, patch)`(:272)= Dexie `Table.update` は **key 不在で 0 件更新の no-op(throw しない)**。削除済 card の mirror update は無効化。
- enqueue される orphan `update_field` mutation は、先行 `delete` mutation に対し **delete が優先**(server は削除済 entity への update を reject/no-op)= 「delete が勝つなら実害なし」。
→ scroll-out(card 生存)は正しく保存、削除(card 消滅)は no-op で害なし。**unmount 理由を知る必要がない**。

### 実装上の必須点(stale closure 回避)
- `useEffect(()=>()=>commit(value),[])` の **empty-deps cleanup は初回 render の値を capture**(stale)= 誤り。**latest-ref pattern 必須**: 毎 render `latestRef.current = { editing, value, initialString }` を更新し、unmount cleanup は `latestRef.current` を読む。既存 timer-clear cleanup(:142-149)を拡張して同 cleanup 内で latest-ref 経由 commit。
- **StrictMode**: dev の mount→unmount→mount 二重で cleanup が 1 度走るが、その時点 editing=false / not dirty → guard で spurious commit を防止。
- **二重 commit なし**: blur 経路は `setEditing(false)` → 次 render で ref が editing=false → 後続 unmount cleanup は skip。handleBlur の commit と競合しない。

## 4. scope

- **InlineTextField 単一 file のみ**(+ その test)。commit()/value/editing/initialString は component 内に既存 = **呼び出し側の情報不要**。consumer(card-view / table)は無改変。
- 共有部品だが「自己完結の commit-on-unmount 追加」で consumer 契約は不変。

## 5. card-view 非回帰の担保(Edit-2 教訓)

- card-view 削除の挙動は **fix 前後で不変**(削除 click が既に blur→commit させ editing=false、commit-on-unmount は不発)。→ 削除カードへの旧値書き戻し(resurrection)は起きない。
- view 切替/遷移で「編集中に離脱」した場合は fix 後 **保存される**(現状は消失)= 改善であり regression でない。
- gate 案:
  - 既存 InlineTextField / inline-card-list / card 系 test 全 green。
  - 追加 unit test(§6)。
  - **card-view 実機 smoke(Edit-2 教訓, stg DevTools)**: ① card-view で編集→別 card 追加/削除 で誤保存・resurrection が無い ② 編集→view 切替で保存される(任意)。
  - **table 実機 smoke(必須, jsdom 不可)**: 編集→wheel scroll で窓外→戻ると入力保持。

## 6. test 設計(非 vacuous)

jsdom は focus 行の scroll-out を再現できない → **unmount を直接起こして commit 発火を検証**(仮想化非依存):
1. **保存**: InlineTextField を editing で render(click か autoEditOnMount)→ 新値 type(dirty)→ RTL `unmount()` → Dexie mirror が新値 + outbox に update_field が入ることを assert。実装前 red(unmount で書かない)→ 後 green。
2. **guard-1(not editing)**: display のまま(未編集)unmount → 書込なし。
3. **guard-2(editing but clean)**: editing だが value===initial → unmount → 書込なし(no-op short-circuit と同基準)。
4. **冪等 backstop(任意)**: mirror から card を消してから editing+dirty で unmount → `cards.update` が no-op(例外なし・行不変)を assert。
5. 既存 handleBlur commit / dirty-guard / autoEdit の test は不変で green。
- 実機のみで担保する部分(scroll-out 実挙動 / focus tear-down の onBlur 不発)は §5 smoke に明記(単体 test で silent ship しない)。

## 7. リスク / 留意(T1 教訓=共有部品を軽率に触らない)

- 唯一の挙動追加は「editing=true のまま unmount した時に commit」。card-view でこれが起きるのは blur を伴わない離脱のみ(通常起きない)→ 影響最小。
- latest-ref を毎 render 更新するのは純粋な同期代入(副作用なし・re-render 誘発なし)。
- 削除カードへの orphan update mutation は既存 delete 優先で収束(§3 backstop)。outbox に短命 orphan 行が稀に載るが lost-write でも resurrection でもない。

## 8. OT 判断

1. 本設計(InlineTextField 単一 file の commit-on-unmount + latest-ref + editing&&dirty gate + 冪等 backstop)で実装して良いか。
2. gate = unit test(§6)+ **table 実機 smoke(scroll-out 保持)必須** + card-view 実機 smoke(誤保存/ resurrection なし)。この smoke 分担で良いか(CC が DevTools 実走 / 実機依存分は OT)。
