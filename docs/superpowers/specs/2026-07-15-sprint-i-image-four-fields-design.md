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

> **改訂 rev2(2026-07-16・OT 承認)**: W3 実装レビュー(canonical + Codex の 2 独立)で、初版 §3 の **delete-only cascade が取りこぼす孤児化経路 2 件**が検出された — ① **option id rename**(id cell は user 編集可。a→b で `option:a` 画像が UI から消え孤児化)② **blank-text 除去**(text を空にして blur → sanitize が payload から drop → server が option 削除・`handleDeleteOption` 非経由ゆえ cascade 不発)。root cause = 紐付けキー `option:<id>` の id が**ユーザー編集可能な表示ラベルを兼ねる**こと(rename か delete+add かの判別情報がデータに存在せず、migrate 案はヒューリスティックにならざるを得ない)。fact-finding `docs/audit/2026-07-16-option-internal-id-feasibility.md` で **(A'-min) = 内部 id(uid)導入**の成立を確認し、本改訂で確定方針を差し替えた(**W5** として実装)。あわせて初版の「`removeImageFromCard` は reclaim 内蔵」という事実誤認(2026-07-15 訂正済)の正記述も本節に統合。

**確定方針(rev2)**:

1. **紐付けキー = `option:<uid>`**。`CardOption` に **`uid`(UUID v4・不変・ユーザー不可視)**を追加し、画像 target は uid を参照する。現 `id`(a/b/c・1/2/3)は**表示ラベルへ降格**(正解サマリ・学習面表示・OCR 採番・`nextOptionId` は従来どおり id を使う。`selected_answer_ids`/`correct_answer_ids` も id のまま = 学習系は同時点自己整合ゆえ不変)。
   - rename は「ラベル変更」となり画像は uid で自動追随(**rename という概念が画像系から消滅**)。
   - **uid は UUID ゆえ再利用されない → 孤児画像が新選択肢へ誤紐付く(mis-attach)ことが構造的に不可能**。初版の破損ベクタ(`nextOptionId` の削除済 id 再利用 × zombie 残存)は確率的対処でなく不変条件として消える。
2. **cascade = 永続集合の set-diff の単一機構(衛生機構)**。options commit の **diff は「実際に永続する集合」に対して取る** — 直近永続(commit 前の確定 options)と今回永続(sanitize 後 = mirror/server に書かれる集合)の **uid 差分**で「消えた uid」を検出し、その `option:<uid>` 画像を除去する。**working-set(表示用・blank row を保持)を diff 対象にしない**(blank-text 除去は working-set に blank が残り diff が検出漏れするため。実装点は plan W5 参照)。これで delete / blank-text 除去の両経路を commit 時点で同一機構がカバーする(pull-back 非依存)。delete-only の W1 実装は W5 で**一般化**する — revert しない。W1 commit は当時の spec に忠実で履歴として正しい。
   - **cascade は正確性機構ではなく衛生機構**: 失敗しても mis-attach は起こりえず(上記 1)、残るのは storage リーク(GC は ref 存在で保持 = 安全側)のみ。ゆえに best-effort + warn 記録で足り、self-heal / 再試行は作らない(初版判断を「稀さへの賭け」から「構造的不可能」へ格上げ)。
   - 除去は **`removeImageFromCard`(images 配列除去のみ)+ 成功分を別途 `reclaimLocalAssetBlobs`(ローカル Cache blob 掃除)の 2 段**(gallery `handleDelete` `card-image-gallery.tsx:194-198` と同型)。`removeImageFromCard` は reclaim を**内蔵しない**(初版の事実誤認の正記述)。
3. **uid の mint は全 option 生成経路で必須**(1 経路でも漏れると validation reject)。現 HEAD で確認済の生成経路 = **4 つ**: ①「+選択肢を追加」(`use-card-options.ts` handleAddOption・client `newId()`)②「+カードを追加」の既定 option(`lib/cards/empty-card.ts` buildEmptyCard・create patch 経路)③ **OCR は server 写像点(`process.ts:373`)でのみ mint**(Gemini prompt / `ocr-extract.ts` / response schema は**一切触らない** — LLM は表示ラベルのみ返し uid はアプリが振る。OCR 画像自動切り出しは従来どおり非スコープ・今回は受け皿のみ)④ seed script(`scripts/seed-perf-exam.ts`)。加えて server 側の**詰め替え透過** 2 箇所(`card-field-handlers.ts` handleOptions / `entity-mutation-registry.ts` create handler)で uid を落とさない。
4. **既存データ**: prod = zero-user(空)。**stg PERF-SEED は uid 無し options** → lazy 付与は作らず(複雑化のみ)、**W5 実装 → OT push → OT 再 seed → smoke** の順で洗い替える。

- **不変条件(継続)**: 新規 gallery は必ず既存 `attachImageToCard`/`removeImageFromCard` を経由し、**target 部分集合の独自 commit を新設しない**(§2「client commit」より、部分 commit だけが union を壊し GC 孤児を生む唯一経路)。
- reorder は存在しない(将来足しても uid ベースゆえ画像は自動追随)。
- §2 表の「選択肢の安定 id」行は初版時点の検証事実として正だが、紐付けキーの結論は本節 rev2 が supersede する。

## 4. 設計

### 4.1 target 命名(OT 確定 = field 名一致)
- 解説 = `'explanation_text'` / メモ = `'memo'`(handler/mirror の field 名と一致・OCR 語彙に寄せない)。選択肢 = `'option:<uid>'`(**§3 rev2**: 内部不変 UUID。初版の `option:<id>` から改訂)。
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
**実行順(§3 rev2 で改訂)**: W1(実装済)→ W2(実装済)→ **W5(uid 導入)→ W3(gallery)→ W4(学習面)→ F**。

- **W1(選択肢削除の画像 cascade・test first)**: 破損回帰 test と cascade 実装を**同一 task**で行う(TDD RED→GREEN を 1 commit 内で完結。**RED 状態は commit しない** = 「同一挙動変更に対する test と実装」ゆえ分割すると赤が生まれるだけ)。
  - test(先行): 「`option:b` 画像を持つ選択肢 b を削除 → 新選択肢追加(id が b に再利用される)→ 新 b に旧画像が付かない」。**cascade を neuter(削除時に画像を残す)すると RED になることを commit 前 review 時に確認・報告**(§6・非空振り担保。RED は commit しない)。
  - 実装: §3 の cascade を `handleDeleteOption`(`use-card-options.ts`)に自己完結で実装(削除 idx から option id を確定 → `getClientDb().cards.get(cardId)` で images 読取 → `option:<id>` の asset key を既存 `removeImageFromCard` で除去。server は既存 handleImages の refs 全置換で追随 = server 無改修)。
  - **完了条件**: 上記 test + 既存 option test 回帰なしで **green commit**・Crit0。
  - 註(rev2): W1 は初版 §3(delete-only・`option:<表示id>`)に忠実な実装として**完了・[reviewed] 済**(commit `b35fae6`)。W5 が uid + set-diff に**一般化**する(revert しない — W1 commit は当時の spec に忠実で履歴として正しい)。
- **W5(option 内部 id 導入 + target uid 化 + set-diff cascade・§3 rev2・W3 の前提)**: G→W の型。
  - G = 現 delete cascade の挙動 pin(既存 W1 test を流用可・green のまま)。
  - W = ① `CardOption.uid` 導入(型 + `optionSchema.uid: z.uuid()` + uid 一意 refine。DDL/migration 不要 = jsonb)② **全 4 生成経路で mint**: 「+選択肢を追加」(`use-card-options.ts` handleAddOption)/「+カードを追加」既定 option(`empty-card.ts` buildEmptyCard)/ OCR server 写像点(`process.ts:373`)/ seed script(`seed-perf-exam.ts`)+ **詰め替え透過 2 箇所**で uid を落とさない(`card-field-handlers.ts` handleOptions / `entity-mutation-registry.ts` create handler)③ 画像 target を `option:<uid>` 化 ④ cascade を uid ベース **set-diff** に一般化(§3 rev2-2・衛生機構)。
  - **境界(OT 明示)**: Gemini prompt / `ocr-extract.ts` / OCR response schema は**一切触らない**(LLM は表示ラベルのみ返し uid はアプリが振る。OCR 画像自動切り出しは非スコープ・今回は受け皿のみ)。
  - **完了条件**: 「**全 option 生成経路が uid を mint する**」を test で担保(4 経路 + 透過 2 箇所)+ **rename / blank-text / delete の 3 経路で画像が mis-attach しない**回帰 test + 既存 test 回帰なし・Crit0/Imp0・`[reviewed]`。
- **W2(imageEntrySchema widen)**: 解説/メモ target を refine に追加(§4.1)。**完了条件**: `explanation_text`/`memo` の UUID-key entry が validation を通り、未許容 target が従来どおり reject される test・既存 question_text/option: entry 不変。
- **W3(gallery 増設・W5 後)**: `CardImageGallery` に `compact` 追加 + 編集面 4 面配線(§4.2/4.3)。選択肢 gallery の target は `option:<uid>`(§3 rev2。W3 実装済 diff は working tree 保持中 → W5 完了後に target 参照を uid へ修正して commit)。**完了条件**: 4 面すべてで attach/remove が既存経路を通る・compact 空選択肢が小 affordance のみ・問題文据え置き・Crit0。
- **W4(学習面 read-only・必須)**: §4.3。学習が描画する question/option/explanation に read-only gallery を拡張(memo は学習非表示ゆえ除外)。**完了条件**: 4 面添付が学習面で read-only 表示される・read-only(attach/remove 経路を通らない)・Crit0。

## 6. test 方針

- **非空振りの破損回帰(W1・最重要)**: §5 W1。**序数ベースの破損は該当しない**(§2 で id ベースと確定)ため、実在する破損ベクタ = **id 再利用**を pin する。cascade を neuter(削除時に画像を残す)すると RED になることを commit 前 review で確認して非空振り担保(RED は commit しない = W1 は green で commit)。
- **W1**: 削除で `option:<id>` 画像が cards.images から消える + 他 target 画像・他選択肢画像は残る(union 非破壊)。reclaim 呼び出し確認。
- **W2**: widen した target の通過 + 未許容 target の reject(既存 refine test に 2 面追加)。
- **W5(§3 rev2)**: ① 全 4 生成経路の uid mint + 透過 2 箇所 ② **rename / blank-text / delete の 3 経路で画像が mis-attach しない**(rename = target 不変で追随・blank-text/delete = set-diff cascade で除去)③ uid 一意 + uid 無し option の reject。
- **W3**: 4 面それぞれ attach→cards.images に正しい target(選択肢 = `option:<uid>`)で 1 entry・remove で消える(既存 gallery test を target 別に拡張)。compact 空状態の affordance。
- AI/画像実 I/O は mock(実 R2/実 API 禁止・既存方針)。

## 7. OT smoke checklist(push/deploy 後・人力 or CC DevTools)

**前提(§3 rev2)**: W5 は `optionSchema.uid` 必須化を含むため、**OT push → 再 seed(uid 付き)→ smoke** の順(既存 seed card は uid 無しで options 編集が reject されるため)。

再 seed 後の stg で:
1. **4 面添付 + 永続**: 問題文/選択肢/解説/メモ すべてに画像添付 → reload → 4 面とも復活表示(消えない)。
2. **削除の非復活**: 各面で画像削除 → reload → 復活しない。
3. **選択肢削除の追随(破損防止)**: 画像付き選択肢を削除 → (同 id 再利用が起きる操作で)新選択肢に旧画像が付かない。
3b. **rename 追随(§3 rev2)**: 画像付き選択肢の id を編集(a→x 等)→ 画像がその選択肢に付いたまま(消えない・他選択肢に付かない)。
3c. **blank-text の非対称(W5 設計判断・OT 実物許容判断)**: 画像付き選択肢の text を空にする → 画像が消える → **同じ行に打ち直す → 画像は戻らない**(仕様どおり = 「空 = option 消滅」)。行は UI に残るが画像は消える非対称を OT が実物で許容判断。許容不可なら別 task 起票(確認ダイアログ / blank 行即時除去で行も消す)。
4. **GC 非孤児化**: GC reconciler 実行後、4 面の生存画像が孤児判定・削除されない(§2 で asset_id ベースと確定済のため回帰確認)。
5. **§9 非悪化(compact)**: 多択カードで空選択肢が小 affordance のみ・行高が常時 gallery 化で肥大しない。
5b. **§9 再燃検証(Sprint F 持ち越し解消・W5 seed 多択で今回検証)**: 再 seed 後、**20 択カード前後を scroll** し、目視できる gap / 行の飛び / カクつき(scroll jitter)が無いか。観測されたら別 task 起票(対策候補 = explanation トグル化 / estimateSize 精緻化 / overscan 調整)。session doc に「§9 検証済(持ち越し解消)」or「観測 → 別 task 起票」を記録。
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
