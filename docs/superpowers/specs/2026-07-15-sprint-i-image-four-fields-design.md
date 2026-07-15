# Sprint I(画像 4 欄化)設計 spec

- **日付**: 2026-07-15
- **調査/起草 HEAD**: `develop` `ce60b20`(Sprint F 仮想化 + scroll-top 移植を含む。fact-finding `5f8698d` から drift 済ゆえ全 file:line を本 HEAD で再検証した)
- **fact-finding**: `docs/audit/2026-07-15-b1-scope-reduction-and-cardview-freeze-factfinding.md` §2(記述は無検証で事実としない方針。本 spec §2 に HEAD 再検証結果を明記)
- **前提**: B1 は「本文途中への画像挿入」を諦めた縮小スコープ = 画像は**欄(field)単位**で足りる(OT 確定)。リッチテキスト/block JSON/Tiptap は全て非スコープ。
- **依存**: Sprint F(カードビュー仮想化)完了・prod 反映想定。I は F の上に乗る。

## 1. スコープ

画像添付を **問題文 / 各選択肢 / 解説 / メモ** の 4 面に拡張する。現状は添付 UI が `target='question_text'` 固定(gallery 2 instance)で実データも事実上 question_text 一択。

**In**: ① `imageEntrySchema` の target widen(解説/メモ)② 編集面 gallery 増設(4 面)③ **選択肢削除時の画像 cascade**(データ破損防止・§3)④ 学習面 read-only 表示(question/option/explanation)。
**Out(非スコープ)**: 表描画(Sprint T)/ 本文への inline 挿入 / OCR の画像自動切り出し / dedup 再利用分岐 / 選択肢の並べ替え(**現コードに reorder UI 自体が存在しない** = §2)。

## 2. HEAD 再検証結果(`ce60b20`・fact-finding の無検証転記を避けるため実コードで裏取り)

| 論点 | HEAD 事実(file:line)| 4 面化への含意 |
|---|---|---|
| 選択肢の安定 id | `CardOption = {id,text,is_correct,explanation?}`(`schema.ts:46-50`)。`optionSchema.id: z.string().min(1)`(`validation/card.ts:15`)、`optionsSchema` が **id 一意を強制**(`:69`)| target=`option:<id>` は **id ベース**(序数でない)= 並べ替え/削除に対し原理的に安定 |
| target 器 | `imageEntrySchema.target: z.string()`(無制約)+ refine で **UUIDv4 key のみ** `question_text \| /^option:.+/` を強制(`validation/card.ts:97,106-117`)。legacy(非 UUID)は passthrough | 解説/メモは **refine を 1 箇所 widen** すれば足りる |
| refs 全置換の入力集合 | `handleImages`(`card-field-handlers.ts:170-231`)は `cards.images`(**全 field を 1 本の flat 配列**で保持・target で区別)を丸ごと検証 → refs を **配列全体から全置換**(`for(const entry of images)` → `field_key=entry.target` verbatim・ordinal=同 field 内 0-based `:210-222`)| refs 全置換の入力は**構造的に全 target の union**。解説/メモ entry を配列に入れれば handler は無改修 |
| client commit | attach=`attachImageToCardInner:564` が `readCardImages` で**最新の全配列を fresh read** → append → `commitImages` 全置換(`upload.ts:470-511,682-720`)。remove=`removeImageFromCard` も key 一致 filter で全配列 read/write(`:838-851`)| **全 gallery が既存 attach/remove を通す限り union 保持** = GC 孤児化しない。**部分 commit の新設だけが破壊経路**(不変条件として明記) |
| discovery / GC / reclaim / backfill | 全経路 key/asset_id ベースで **field 非依存**(deck-download `:125-131` / sweep `:76-78` / reclaim callers / get-asset `:65` / GC 反結合は `asset_id` 存在のみ `gc-image-assets.ts:526-528,593` / backfill `:106-131` は `field_key=target` verbatim)| 4 面化で **discovery/GC/backfill は無改修**。GC は「ref が 1 行でもあれば生存」ゆえ zombie ref は asset を延命(§3 の cascade 動機)|
| card_asset_refs schema | `field_key text notNull`・**PK=(card_id, field_key, ordinal)**・`asset_id` FK onDelete restrict(`schema.ts:855-874`)| **migration 不要**(field_key 自由・多 field 併存可。異 field は ordinal 衝突しない)|
| CardImage / ClientCardImage | `{key,target,alt,source_ref?,url?}`・target=string(`schema.ts:53-59` / `client-db.ts:62-68`)| **型変更不要** |
| 選択肢の変更経路 | `use-card-options.ts` の handler = add/cellSave/unmountSave/toggle/**delete** のみ。**reorder は存在しない**。delete は `filter((_,i)=>i!==idx)`(`:296`)で残存 id 保持・`cards.images` を触らない | 画像追随を保証すべき経路は **delete のみ**(§3)|
| OCR 語彙 | OCR は target=`question`/`option_1`/`explanation`・key=`q{sort}-img-N`(**非 UUID**)(`ocr-extract.ts:124-134`)= asset 系と別 namespace・refs に入らない | 4 面の target 語彙(`question_text`/`explanation_text`/`memo`/`option:<id>`)と衝突しない |

## 3. データ整合性の核心(最重要・破損防止)

**選択肢 id は安定だが、`nextOptionId`(`next-option-id.ts`)は削除済 id を再利用しうる**:letter `[a,b,c]`→b削除→追加=**b 再利用**、digit `[1,2]`→2削除→追加=**2 再利用**、`opt-N` も同様(3 方式すべて)。かつ `handleDeleteOption` は `cards.images` を触らないため、**削除された選択肢の `option:<id>` 画像が zombie として残存**(GC も ref 存在ゆえ削除しない)。→ **同 id の新選択肢が追加されると zombie 画像が誤って新選択肢へ紐付く = 静かなデータ破損**(id ベースでも id 再利用で破損が復活する)。

- **確定方針**: **選択肢削除時に、その選択肢の `option:<id>` 画像を `cards.images` から除去する(cascade)**。`handleDeleteOption` が削除対象 id を確定 → `getClientDb().cards.get(cardId)` で現 images を読み `option:<id>` の asset key を抽出 → 各 key を **既存 `removeImageFromCard`**(全配列 fresh read/write + reclaim 内蔵)で除去。zombie を消すことで ①storage リーク解消 ②id 再利用の誤紐付き window を同時に閉じる = 必要十分。
- **不変条件(spec 明記)**: 新規 gallery は必ず既存 `attachImageToCard`/`removeImageFromCard` を経由し、**target 部分集合の独自 commit を新設しない**(§2「client commit」より、部分 commit だけが union を壊し GC 孤児を生む唯一経路)。
- reorder は存在しないため追随保証は不要(将来 reorder を足すなら id ベースゆえ画像は自動追随・別 sprint)。

## 4. 設計

### 4.1 target 命名(OT 確定 = field 名一致)
- 解説 = `'explanation_text'` / メモ = `'memo'`(handler/mirror の field 名と一致・OCR 語彙に寄せない)。選択肢 = 既存 `'option:<id>'`。
- `imageEntrySchema` refine(`validation/card.ts:110`)を widen: `['question_text','explanation_text','memo'].includes(target) || /^option:.+/.test(target)`。**1 箇所のみ**(server handleImages と client 双方がこの共有 schema を経由)。

### 4.2 gallery 表示形態(§9 衝突回避・OT 確定)
Sprint F spec §9(多択行高肥大・現「未検証・監視持ち越し」)を I が悪化させない。
- **問題文 / 解説 / メモ**(各 1 個・card あたり最大 3 gallery)= **現行の常時表示形態を据え置き**(§9 は選択肢数に比例しないため悪化なし)。
- **選択肢**(選択肢数ぶん増える = §9 リスク源)= **compact 形態**:画像がある選択肢のみ thumbnail 表示、無い選択肢は**小さな「+画像」アイコン**のみ(dashed「画像を追加」ボタン + flex container は出さない)。→ `CardImageGallery` に `compact?: boolean` を追加し、empty-edit 時の add affordance をアイコンに切替(thumbnail 描画は不変)。
- **§9 影響(1 行記録)**: 20 択カードでも空選択肢の増分は小アイコン 1 個/選択肢に留まり、§9 の再燃条件(多択 card 前後の scroll jitter)を実質悪化させない(常時 gallery なら add ボタン ×20 で肥大するのを回避)。

### 4.3 gallery 設置
- **編集面(`card-editor-fields.tsx`・list と side-peek が共有)**: 解説/メモ の `InlineTextField` 直下に `CardImageGallery target='explanation_text'|'memo'` を増設。選択肢は `InlineOptionList` に `images`+`userId` を追加透過し、各選択肢行(`inline-option-row.tsx`)に `CardImageGallery target={'option:'+id} compact` を設置。
- **学習面(`session-runner.tsx`・read-only)= W4(必須)**: 現 question_text read-only gallery を、学習が描画する field(question / option / explanation)へ read-only で拡張。memo は学習非表示ゆえ対象外。編集で付けた画像は「解く/答え合わせ」時に見るものゆえ学習面表示は機能の一部(W4 なしでは「付けたのに出ない」= 破綻)。read-only ゆえ attach/remove を通らず §3 の破損経路と無関係で安価。

### 4.4 無改修(§2 再検証で確定)
handleImages / card_asset_refs / GC / discovery(deck DL・sweep・reclaim・get-asset)/ backfill / CardImage 型は **変更不要**。migration 不要。

## 5. Phase 分割(全 phase feat・test-first)

全 phase behavior-changing(feat)ゆえ canonical + Codex review + [reviewed]。**各 phase の完了条件 = 対象 test green**(赤で task 間を連結しない = per-task で full test)。

- **W1(選択肢削除の画像 cascade・test first)**: 破損回帰 test と cascade 実装を**同一 task**で行う(TDD RED→GREEN を 1 commit 内で完結。**RED 状態は commit しない** = 「同一挙動変更に対する test と実装」ゆえ分割すると赤が生まれるだけ)。
  - test(先行): 「`option:b` 画像を持つ選択肢 b を削除 → 新選択肢追加(id が b に再利用される)→ 新 b に旧画像が付かない」。**cascade を neuter(削除時に画像を残す)すると RED になることを commit 前 review 時に確認・報告**(§6・非空振り担保。RED は commit しない)。
  - 実装: §3 の cascade を `handleDeleteOption`(`use-card-options.ts`)に自己完結で実装(削除 idx から option id を確定 → `getClientDb().cards.get(cardId)` で images 読取 → `option:<id>` の asset key を既存 `removeImageFromCard` で除去。server は既存 handleImages の refs 全置換で追随 = server 無改修)。
  - **完了条件**: 上記 test + 既存 option test 回帰なしで **green commit**・Crit0。
- **W2(imageEntrySchema widen)**: 解説/メモ target を refine に追加(§4.1)。**完了条件**: `explanation_text`/`memo` の UUID-key entry が validation を通り、未許容 target が従来どおり reject される test・既存 question_text/option: entry 不変。
- **W3(gallery 増設)**: `CardImageGallery` に `compact` 追加 + 編集面 4 面配線(§4.2/4.3)。**完了条件**: 4 面すべてで attach/remove が既存経路を通る・compact 空選択肢が小 affordance のみ・問題文据え置き・Crit0。
- **W4(学習面 read-only・必須)**: §4.3。学習が描画する question/option/explanation に read-only gallery を拡張(memo は学習非表示ゆえ除外)。**完了条件**: 4 面添付が学習面で read-only 表示される・read-only(attach/remove 経路を通らない)・Crit0。

## 6. test 方針

- **非空振りの破損回帰(W1・最重要)**: §5 W1。**序数ベースの破損は該当しない**(§2 で id ベースと確定)ため、実在する破損ベクタ = **id 再利用**を pin する。cascade を neuter(削除時に画像を残す)すると RED になることを commit 前 review で確認して非空振り担保(RED は commit しない = W1 は green で commit)。
- **W1**: 削除で `option:<id>` 画像が cards.images から消える + 他 target 画像・他選択肢画像は残る(union 非破壊)。reclaim 呼び出し確認。
- **W2**: widen した target の通過 + 未許容 target の reject(既存 refine test に 2 面追加)。
- **W3**: 4 面それぞれ attach→cards.images に正しい target で 1 entry・remove で消える(既存 gallery test を target 別に拡張)。compact 空状態の affordance。
- AI/画像実 I/O は mock(実 R2/実 API 禁止・既存方針)。

## 7. OT smoke checklist(push/deploy 後・人力 or CC DevTools)

既存 stg で:
1. **4 面添付 + 永続**: 問題文/選択肢/解説/メモ すべてに画像添付 → reload → 4 面とも復活表示(消えない)。
2. **削除の非復活**: 各面で画像削除 → reload → 復活しない。
3. **選択肢削除の追随(破損防止)**: 画像付き選択肢を削除 → (同 id 再利用が起きる操作で)新選択肢に旧画像が付かない。
4. **GC 非孤児化**: GC reconciler 実行後、4 面の生存画像が孤児判定・削除されない(§2 で asset_id ベースと確定済のため回帰確認)。
5. **§9 非悪化**: 多択カードで空選択肢が小 affordance のみ・行高が常時 gallery 化で肥大しない。
6. **学習面 read-only 表示**: 学習画面で question/option/explanation の画像が read-only 表示される(編集で付けた画像が「解く/答え合わせ」時に見える)。

## 8. 制約・非機能

- **新 dep なし**(aws4fetch 等導入済)。**DB migration 不要**(§2: field_key 自由・PK 既に多 field 対応)。**schema 型変更なし**。
- 既存データ: zero-user ゆえ移行コード不要。現存 `target='question_text'` 実データは widen(追加のみ)で従来どおり読める(§2)。
- 通常則: review-before-commit / canonical + Codex / commit は CC・push は OT / SQL は OT(本 spec は SQL 不要)。
- spec は実装フェーズで凍結。仕様変更が要れば停止して OT 相談。

## 9. 設計判断の確定(OT レビュー 2026-07-15 反映)

1. **選択肢削除 cascade(§3)= W1 で実装**(承認)。代替 `nextOptionId` 非再利用化は不採用 — **id が UI 語彙を兼ねる**(a/b/c・1/2/3 が正解サマリ表示に露出)ため、非再利用化は穴あき表示(a, b, d)という別問題を作る。cascade は「zombie 除去 + id 再利用 window を同時に閉じる」= 片方では不足(zombie だけ残す = storage リーク継続 / window だけ閉じても zombie 残存)。
2. **学習面 read-only(W4)= 本スプリント必須**(確定・分離案不採用)。W4 なしでは「解説に画像を付けられるのに学習で見えない」= 機能破綻(試験カードの図は解く/答え合わせ時に見るもの)。read-only ゆえ破損経路と無関係・安価。分離すると同一体験の smoke が二度手間。memo 除外は正(学習非表示)。
3. **解説/メモ = 常時表示・選択肢のみ compact**(承認)。§9 リスクは**選択肢数に比例**するため、比例するものだけ compact にするのが必要十分。解説/メモは card あたり 1 個で非比例ゆえ問題文と形態を揃える。
