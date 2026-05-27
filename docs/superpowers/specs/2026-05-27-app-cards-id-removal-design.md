# /app/cards/[id] 廃止 設計 (design spec)

- 起票日: 2026-05-27
- 種別: design spec (cache-fix roadmap ④-3)
- 関連 roadmap: `docs/cache-fix-roadmap.md` §④-3
- 状態: **実装完了** (commit `b73512b`、 2026-05-27)
- 前 phase: phase 1 経路調査 (chat report、 commit なし) — UI 経路ゼロ + 副次依存 6 area + 部分削除境界を grep ベースで確定済
- 後追い: 実装後の実態整合 (touch list 数値補正 + 進行中追加 scope) は本 doc §10 で反映

---

## 1. 結論サマリ

`/app/cards/[id]` 個別 card 編集 page (S2.0 で導入、 その後 `/app/exams/[id]` 内
の inline 編集が UX 主軸となり dead code 化) を、 自己参照 9 file + 副次依存
4 area + lib 部分削除を含めて 1 commit で一括削除する。 UI 経路 (Link /
router.push / redirect / form action) は phase 1 で **ゼロ確認済**、 削除に伴う
inline 編集の RSC re-render 経路維持も Next.js 15 server action 自動再実行で
担保済 (S-cache-2a 由来)、 代替経路追加不要。

---

## 2. 背景

S2.0 で個別 card 編集 page (`/app/cards/[id]`) を作ったが、 その後 inline
編集 (`/app/exams/[id]` 内で field 単位編集) が UX 主軸となり、 page への UI
経路 (Link / push / redirect / form action) は全て撤去された。 現状の grep
結果は (phase 1 で確認):

- `href="/app/cards` / `router.push.*app/cards` / `redirect.*app/cards` /
  `Link.*app/cards`: **0 件**
- `app/(app)/app/exams/[id]/_components/inline-card-list.test.tsx:65` に
  「『編集』 Link は DOM に存在しない」 を assert する test も既に固定済

dead code 化した page と副次依存を残置すると、 LocalSync MVP 等の後続 sprint
で scope 判定にノイズが入る。 削除は git revert で復活可能なので、 経路ゼロを
確認した段階で削除に踏み切る方針。

---

## 3. Scope

### In (touch list 13 file)

#### (a) 自己参照 9 file (一括 rm)

```
app/(app)/app/cards/[id]/
├── page.tsx                                          ← delete
├── loading.tsx                                       ← delete
├── _actions/update-card.ts            + .test.ts     ← delete
├── _actions/delete-card.ts            + .test.ts     ← delete
├── _components/card-editor.tsx        + .test.tsx    ← delete
└── _components/delete-card-button.tsx + .test.tsx    ← delete
```

#### (b) 副次依存 4 file modify + 1 file delete

| # | file | 変更 |
|---|---|---|
| 1 | `lib/cards/get-card-for-edit.ts` | **file 削除** (使用箇所 = 削除対象 page のみ、 grep 確定) |
| 2 | `lib/validation/card.ts` | **部分削除** (§5 で境界明示) + docstring 更新 |
| 3 | `app/(app)/app/exams/[id]/_actions/update-card-field.ts:159` | `revalidatePath` 行削除 + `:157-158` comment 更新 |
| 4 | `app/(app)/app/exams/[id]/_actions/update-card-field.test.ts:284-289` | revalidatePath assertion 削除 |
| 5 | `app/(app)/app/exams/[id]/page.tsx:15` | comment「`/app/cards/[id]` への遷移は廃止...」 を「page は廃止済、 全 inline で完結」 に書換 |

### Out (YAGNI)

- inline 編集 UI 自体の改修 (本 task は削除可否のみ)
- 他 dead code への調査拡大 (本 task は `/app/cards/[id]` のみ)
- 将来再導入の議論 (経路ゼロ確認済、 必要なら git revert で復活可能)
- `/app/cards/[id]` 以外の `/app/exams/[id]` 内編集 UI の見直し

---

## 4. 残置 (整理しない)

- **`app/(app)/app/exams/[id]/_components/inline-card-list.test.tsx:65`** の
  「『編集』 Link は DOM に存在しない」 test
  - **keep** (将来「うっかり Link 復活」 regression guard、 削除後の状態とも整合)
  - test 名内の文言 (`Link to /app/cards/:id`) も **そのまま keep する** (= 過去
    の経路名を明示することで「なぜこの assertion があるか」 の意図が読みやすい
    まま維持される、 削除済 path を test 名に残すことの不都合は無視可能)

---

## 5. 部分削除境界 (lib/validation/card.ts)

OT 追加指示により、 grep ベースで完全確定。

### 確認 grep

```
grep -rn "from '@/lib/validation/card'" --include="*.ts" --include="*.tsx"
```

### export 別の対処

| export | 唯一の importer | 削除可否 |
|---|---|---|
| `optionSchema` | `app/(app)/app/exams/[id]/_actions/update-card-field.ts:11` (inline 側) | **残す** |
| `updateCardInputSchema` | `app/(app)/app/cards/[id]/_actions/update-card.ts:9` (削除対象) のみ | 削除 |
| `UpdateCardInput` (type) | 同上 | 削除 |
| `ParseUpdateCardResult` (type) | 同上 | 削除 |
| `parseUpdateCardInput` (function) | 同上 | 削除 |

### 残置後の docstring 方針

冒頭 comment 「card 編集 page (/app/cards/[id]) の入力 validation」 を
「inline 編集 (`/app/exams/[id]` 内 option 編集) の選択肢入力 validation」 に
更新。 残置 export が `optionSchema` 1 個のみに narrow される事実を反映。

---

## 6. 削除に伴う代替経路不要の根拠

`update-card-field.ts:159` の `revalidatePath('/app/cards/${cardId}')` を
削除しても、 inline 編集の RSC re-render は **Next.js 15 の server action
自動再実行**で維持される。 代替経路 (e.g. `router.refresh()` / 追加
`revalidatePath`) を追加する必要なし。

### 根拠 (同 file 既存 comment `:152-156` 由来、 S-cache-2a sprint で確立)

> S-cache-2a: revalidatePath('/app/exams/[id]') は撤去。 Next.js 15 は client
> component から呼ばれた server action の完了後、 **呼出元 route segment の
> server component を自動再実行して新 RSC tree を返す** (inline-text-field /
> inline-option-row の `serverOptions` prop 更新が依存する機構)。 同 path への
> revalidatePath はこの自動再実行と重複し redundant。

つまり:

- 呼出元 `/app/exams/[id]` の RSC 再実行は **Next.js 15 server action 完了後
  の組み込み挙動**で trigger (`revalidatePath` 経由ではない)
- `:159` の `revalidatePath('/app/cards/${cardId}')` は「削除対象 page 専用の
  cross-page revalidate」 で、 page 削除と共に意義喪失
- 削除後の inline 編集挙動は S-cache-2a 確立済の自動再実行経路で完全維持

### update-card-field.ts 内の他 `revalidatePath` 呼出

**`:159` のみ**。 他 path への revalidate (例: `/app/exams/${examId}` 等) は
本 file 内で呼んでいない (=最初から S-cache-2a 撤去後の状態)。

---

## 7. Test 影響

### 削除される test (自己参照 4 file)

- `app/(app)/app/cards/[id]/_actions/update-card.test.ts`
- `app/(app)/app/cards/[id]/_actions/delete-card.test.ts`
- `app/(app)/app/cards/[id]/_components/card-editor.test.tsx`
- `app/(app)/app/cards/[id]/_components/delete-card-button.test.tsx`

→ 推定 case 数: 873 → ~860 前後 (具体減数は実 file の case 数で確定、 完了条件
は「全 pass」 が主、 件数減は副)。

### 修正される test (1 file 1 案件)

- `update-card-field.test.ts:284-289` の `mockRevalidatePath` assertion 削除
  (= revalidatePath 自体を呼ばなくなる挙動と整合)

### 追加する test (なし)

- 「revalidatePath が呼ばれない」 ことを assert する case は不要
  (= Next.js server action 自動再実行は仕様、 unit test で verify する対象でない)
- 「Link が DOM に存在しない」 既存 test (inline-card-list.test.tsx:65) は keep
  で regression guard 機能

---

## 8. 完了条件

- `pnpm exec tsc --noEmit` clean
- `pnpm test -- --run` 全 pass (削除後 case 数で全件 green)
- `superpowers:requesting-code-review` skill canonical 経由 review:
  Critical 0 / Important 0
- 1 commit で完結 (brief 指示「同 commit で整理」 準拠)、 commit type は
  `refactor(perf)` + `[reviewed]` tag (実装ロジック変更を含む refactor =
  formal review 必須、 CLAUDE.md 該当条項準拠)

---

## 9. 非該当 (将来 task)

- `/app/cards/[id]` の機能を別 path で再導入する設計 (現状 inline 編集で UX
  完結、 再導入の motivation なし)
- 他の dead code 棚卸し (例: vocab 撤去残骸、 旧 PoC code 等) — 本 task scope 外
- LocalSync MVP の `card_mutations` push API 設計への影響 (削除完了後 LocalSync
  spec の scope を「inline 編集経路のみ」 に絞れる副次効果はあるが、 設計判断は
  LocalSync MVP spec で別途)

---

## 10. 実装結果 (実態整合の後追い反映)

起票時 §1-§9 は起票 snapshot として保持。 実装 (`b73512b`) 完了後に発覚した
spec / 実態の差分を本 section で補正する。 review (Critical 0 / Important 0 /
Minor 5) の minor #3 で reviewer から「spec doc 自体の amend」 を recommend
された範囲を主に反映。

### 10.1 touch list 数値の補正

| section | 起票時記載 | 実態 | 差分の根拠 |
|---|---|---|---|
| §1 結論サマリ | 自己参照 9 + 副次 5 = **13 file** | 自己参照 10 + 副次 7 = **17 file** | 起票時数え誤り (§ (a) 内訳合計 = 1+1+2+2+2+2 = 10) + 進行中追加 2 件 |
| §3 In (a) | 自己参照 9 file | **自己参照 10 file** | 同上 (page+loading+actions(2)+actions test(2)+components(2)+components tests(2)) |
| §3 In (b) | 4 file modify + 1 file delete | **3 file modify + 3 file delete + 2 file 副次 comment fix** | 進行中追加 + review minor 反映 |

### 10.2 進行中追加 scope (OT 承認のもと本 commit に含めた範囲)

brief「削除影響範囲 (関連 import / 関連 test) も同 commit で整理」 の解釈幅で
追加した範囲。 spec 起票時に grep 漏れで未列挙だったもの。

| # | file | 対処 | 根拠 |
|---|---|---|---|
| A | `lib/cards/get-card-for-edit.test.ts` | **delete** | `get-card-for-edit.ts` 削除に伴い import 切れで TS2307 × 3 発生、 helper file 削除に test file が追従するのが自然 |
| B | `lib/validation/card.test.ts` | **全 delete** | 全 24 case が削除対象 export (`updateCardInputSchema` / `parseUpdateCardInput` / `UpdateCardInput`) の test、 `optionSchema` 単独 test は元々 file 内に不在 |
| C | `update-card-field.test.ts` L280-292 case | **case 全体 delete** | spec §3 (b) #4 の「assertion 削除」 を OT 承認のもと「revalidate verify 専用 case の全削除」 に拡張。 残置すると it title (`success → revalidates ...`) が事実と矛盾 |
| D | `update-card-field.ts:3` `revalidatePath` import | **撤去** | revalidate 行削除に伴い unused、 TS6133 警告で発覚 |
| E | `lib/cards/next-option-id.ts` / `.test.ts` の comment | **caller 言及を更新** | 削除済 `card-editor.tsx` を caller として言及していたため、 同 sweep で comment を inline-option-row のみ言及に整理 (review minor #2) |

### 10.3 残置 `optionSchema` の test coverage

`lib/validation/card.test.ts` 全削除に伴い `optionSchema` の unit level test は
喪失するが、 結合 level の coverage は以下で維持される:

- `update-card-field.test.ts:216` `options: 正常 → snake_case 変換 + correct_answer_ids 再生成`
- `update-card-field.test.ts:232` `options: 0 件で zod error`
- `update-card-field.test.ts:240` `options: id 重複で zod error`

これらが `optionsSchema` (`optionSchema` の array wrap) 経由で `optionSchema`
を間接 verify する。 unit level の単独 test 追加は将来必要時に別 task で
行うこととし、 本 task 範囲では coverage 妥当と判断 (OT 承認済)。

### 10.4 §7 test 影響の実数

起票時記載: 「~860 前後」 → 実数: **818 pass** (= baseline 873 − 55 case 減)。
55 case 減の内訳:

- 自己参照 4 test file 内の case 合計
- `lib/validation/card.test.ts` 24 case
- `lib/cards/get-card-for-edit.test.ts` の 3 case
- `update-card-field.test.ts` L280-292 case 1 件

### 10.5 review 結果

- 経路: `superpowers:requesting-code-review` skill canonical (general-purpose
  subagent + 厳格 prompt + template 改変なし)
- Critical 0 / Important 0 / Minor 5 (詳細は commit `b73512b` の message 参照)
- Minor 1 (test docstring stale) と Minor 2 (next-option-id comment stale) は
  同 commit 内で fix、 Minor 4 (commit tag) は遵守、 Minor 5 (.not.toHaveBeenCalled)
  は keep (regression guard)、 本 §10 は Minor 3 への対応

### 10.6 裏取り判定

該当なし (dead code 削除、 reducing side-effect)。 reviewer 明示確認: 「neither
in the "決済 / 認証 / 削除 / 外部副作用" 裏取り category, failure mode = "削除済
page が復活する" not data loss」 → OT 実機観察 gate 不要、 `[reviewed]` tag 即時
付与済。
