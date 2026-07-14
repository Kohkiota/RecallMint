# 画像参照の正規化(card_asset_refs 導入)追加 fact-finding

- **日付**: 2026-07-13(記録)/ 調査 HEAD = `develop` `3dee567`
- **性質**: read-only 調査のみ。実装 / migration / spec 起草 / 変更なし。
- **背景**: 状態ベース遅延 GC(GPT cross-check + claude.ai 一致)へ方針確定。核心 = 参照を `cards.images` 配列から `card_asset_refs` テーブルへ正規化し、cascade で参照行が消える構造にする。前 spec(`2026-07-13-image-gc-design.md`・配列 scan 前提)は本調査後に superseded 予定。
- **確定前提(anchor・本 doc では検証対象でなく入力)**: client 同期プロトコル不変(images whole-array 全置換)/ refs→cards CASCADE・refs→assets RESTRICT / users→assets 単純 cascade にしない / grace 30 日・手動 mark/sweep 第一版 / dedup 据え置きだが参照は many-to-many / 既確定事実(OCR 非 UUIDv4・R2 DELETE 404=success 等)流用。

---

## A. cards.images の読み書き全箇所の棚卸し

### A-1. server 側 writer(全列挙)

| # | 経路 | 実体 | UUID 参照を書くか | refs 全置換 seam |
|---|---|---|---|---|
| W1 | card 編集(update_field images)| `handleImages`(`lib/cards/card-field-handlers.ts:168-190`、dispatch 登録 `:298`)→ `updateCardField` で wholesale SET | **書く(唯一の経路)** | **あり**。per-mutation tx(`processMutation`)内で実行されるため、SET と同 tx で refs の DELETE→INSERT 全置換を挟める |
| W2 | OCR bulk insert | `saveExtractedCards`(`upload-persistence.ts:15-44`)の `tx.insert(cards).values(cardRows)`。images は `process.ts:376` で `(c.images ?? [])` を構築 | 書かない(キーは `"q{sort_key}-img-{連番}"` 形式 = 非 UUIDv4・`ocr-extract.ts:132-133`)→ `isAssetKey` false = refs 対象外 | 同 tx 内に derive を足せる構造だが**現データフローでは不要** |
| W3 | outbox card create | `applyCardCreateWithId`(`apply-card-mutation.ts:89-104`)| **images を INSERT しない**(values に images 無し → DB default `'[]'`) | 不要 |

**行を消す系**(正規化後は refs が cascade で自動消滅する = 構造改善の核心):
- card 削除: `applyCardDelete`(`apply-card-mutation.ts:162-164`)の `cards DELETE` → refs は cards FK CASCADE で自動消滅。
- exam 削除: `delete-exam.ts:87-89` の `exams DELETE` → cards FK cascade → refs cascade。**apply 非経由でも参照行が消える**(旧 diff 方式の構造的穴が解消)。
- user 削除: §F(assets 行の扱いが論点)。

**結論**: UUID 参照の server write は **W1(handleImages)の実質単一点**。全置換 seam は 1 箇所に集約できる(散在なし)。

### A-2. server 側 reader(全列挙)

| 経路 | 実体 | 正規化後の扱い |
|---|---|---|
| pull(mirror 配信)| `cards-pull.ts:27` → mapper `toClientCard`(`cards-mapper.ts:29` `images: row.images`)| 配列を残すなら無風。配列廃止なら refs から再構築要 |
| 学習ビュー | `get-session-cards.ts:27-31` `select()`(全列 = images 含む)→ `Card[]` | 同上 |
| bulk 送信側 mapper | `toCard`(`cards-mapper.ts:67`)| 同上 |
| ready 検証(新値側)| `handleImages:174-187`(新配列の UUID key を assets へ IN)| 継続(受信検証) |
| upload result 画面 | server 読みなし(grep 0 件・pull 経由 client mirror)| 無風 |

server が images を「解釈」する読者は handleImages の受信検証のみ。他は行全体の pass-through。**resolveAssetUrls は cards を一切読まない**(認可は assets.user_id + status のみ・§D)。

### A-3. 判別の一元性

`isAssetKey`(`lib/validation/card.ts:88-90`・UUIDv4 厳密)の使用箇所: `card.ts:109`(zod)/ `card-field-handlers.ts:174`(ready 検証)/ `deck-download.ts:129` / `card-image-gallery.tsx:167`。refs 行生成(handleImages 内)でも同 helper を import すれば同一判別を通せる(再実装不要)。

## B. field_key / ordinal の実態

- **target の値域**: `'question_text'` または `'option:<optionId>'`。zod 強制 = `card.ts:110`(`entry.target === 'question_text' || /^option:.+/.test(entry.target)`)。option: の中身は **CardOption.id**(`card-editor-fields.tsx:83-84` コメント「per-option gallery(target={'option:' + optionId})」)。
- **ただし現 UI は question_text のみ instantiate**(`card-editor-fields.tsx:85` の 1 箇所。per-option gallery は「後続 task の deferred follow-up(本 task scope 外)」と明記)→ **現存しうる UUID 参照は事実上すべて target='question_text'**(生成経路が存在しない。実 DB の分布は未確認だが zero-user + 経路不在ゆえ確度高)。
- **ordinal**: attach は配列末尾 append(`upload.ts` nextImages)、gallery は「添付順で並べる」設計 → **配列内順序(同 target 内)がそのまま ordinal**。復元可能。
- **結論: (field_key, ordinal) は images 配列から完全復元可能**(field_key = target 文字列 verbatim / ordinal = 同 target 内の配列順)。card 単位(field_key 無し)へ縮める必要はない。なお **GC 用途だけなら (card_id, asset_id) で足りる** — field_key/ordinal が必須になるのは「配列廃止で表示を refs から再構築する」場合のみ(§C)。
- **不明(将来考慮)**: option 削除時に `target='option:<id>'` の images entry を掃除する処理は存在しない(`handleOptions`(`card-field-handlers.ts:145-160`)は images に触らない)。per-option gallery 実装時の要設計事項として記録(現状データが無いため本正規化では非 blocking)。

## C. 二重持ち vs 配列廃止(blast radius)

### 案 1: 二重持ち(cards.images 残置 + card_asset_refs を GC 権威に)

触る面: ① handleImages に refs 全置換(同 tx・DELETE→INSERT)② 既存データの backfill script(cards.images → refs 一括生成)③ reconciler / R2 seam / resolve WHERE(§D)等の GC 本体。
**読者は全て無風**(pull / mapper / session / client / imagesSchema)。client プロトコル不変 anchor と完全整合。
drift リスク = 「同 tx 更新を破る書き手」だが、書き手が W1 単一点ゆえ管理可能(cascade 消滅側は FK が保証)。

### 案 2: 配列廃止(refs 一本化)

追加で触る面: ④ `cards.images` 列 drop ⑤ `toClientCard` / `toCard`(mapper 2 箇所)で refs→配列再構築(JOIN or 二次 query + field_key/ordinal sort)⑥ `get-session-cards` の select 形 ⑦ handleImages の格納先変更(受信配列→refs のみ)⑧ legacy OCR entry(非 UUID・source_ref 付き)の行き場 — refs は asset FK を持つため **legacy passthrough entry を格納できない**(別列 or 別 table or jsonb 残置が必要 = 実質「配列を完全には廃止できない」)。
client は protocol 不変で無風(pull が再構築配列を返す限り)。

### client 側の配列前提箇所(参考・両案とも無風)

`card-image-gallery.tsx` / `card-editor-fields.tsx` / upload saga(`readCardImages` / `commitImages`)/ `sweep.ts` / `deck-download.ts` / `collectBlockedImageMutationIds`(`entity-mutations.ts:209-233`)/ `client-db.ts` 型 / pull mirror。

## D. presigned GET 発行箇所で参照確認を挟めるか

- **発行は単一点**: `presignGetUrl` の呼出は `resolveAssetUrls`(`asset-actions.ts:217`)のみ(定義除く grep 全件)。
- 現認可 WHERE = `inArray(assets.id, validIds) + eq(assets.userId, user.id) + eq(assets.status, 'ready')`(`asset-actions.ts:206-211`)。
- **seam あり**: この WHERE に「`card_asset_refs` 上の有効参照 EXISTS」または「asset.state 条件」を追加するだけ(単一点・契約は「missing ids omitted」なので参照なし asset は黙って省かれ、client は既存の不在扱い経路(placeholder + retry)で処理)。**GPT 推奨(取得権限の即時失効)は実装可能**。
- 設計トレードオフ(不明ではなく記録): refs EXISTS を必須化すると「finalize 済・images mutation 未 flush」の窓で同一端末が Cache miss すると一時的に取得不可(flush 後回復)。通常は attach 直後 Cache hit ゆえ稀。state 条件のみ(deleting/deleted を弾く)なら窓なし。どちらを resolve の条件にするかは spec 論点。

## E. assets の state 拡張余地

- 現 `status`: text・default `'reserved'`(`schema.ts:829` / migration 0023)・**CHECK 制約なし**(0023 実 SQL 確認済)。書込 = reserve `'reserved'`(`asset-actions.ts:112`)→ finalize `'ready'`(`:159`)。
- server reader は 3 箇所のみ、**全て eq 'ready' フィルタ**: finalize 冪等 check(`:147`)/ resolve(`:210`)/ handleImages ready 検証(`card-field-handlers.ts:183`)。→ `pending|ready|deleting|deleted` へ拡張しても既存 reader は追加 state を自動的に除外(挙動影響ほぼゼロ)。`'reserved'`→`'pending'` rename は書込 1 + 分岐 1 + test のみ(rename 自体の要否は spec 論点・既存値のまま `deleting|deleted` を足すだけでも成立)。
- client 側 `client-db.ts:77` の `'uploading' | 'ready' | 'failed'` は **Dexie media_assets(別 table)** — server status と独立・無影響。
- **orphaned_at**: 既存 `unreferenced_at`(timestamptz nullable・0023 既存)と**同型・同義**(参照ゼロ観測時刻)。列名維持で流用可。rename は cosmetic migration(zero-user ゆえ自由だが必須ではない)。

## F. user 削除経路(object_key 退避 / soft-delete)

- **決定的事実: users 行は削除されない**。handler は `tx.update(users).set({ deletedAt, email: null, clerkId: null })`(`handle-clerk-event.ts:187-189`・PII scrub)であり `delete(users)` は存在しない。→ **assets.user_id の FK ON DELETE CASCADE はこの flow で発火しない**。assets 行が消える唯一の経路 = Group I の明示 `tx.delete(assets)`(`:200`)。
- **触る面(anchor「単純 cascade にしない」の実装)は極小**: 明示 DELETE の 1 行を「`status='deleting'` 等の soft-delete UPDATE」or「object_key 退避後に残置」へ変えるだけ。FK 定義の変更は不要(cascade は発火経路が無い)。
- 併せて更新が要るもの: **Group I invariant test**(`app/api/webhooks/clerk/route.test.ts:286, :833` — 「user_id direct cascade を持つ全テーブルが handler の明示 DELETE に含まれる」の機械検証・11 テーブル)。assets を明示 DELETE から外すと期待集合の更新 + 「なぜ assets だけ soft-delete か」のコメントが必要。
- **decouple 規律との整合: 自然に満たせる**。webhook critical path では state を立てるだけ(DB write のみ・外部 mutation なし)→ R2 削除は reconciler が後で回収(既存 deletion_* 台帳 + 手動回収と同型)。同 tx の `exams DELETE` cascade で cards → refs が消えるため、残置 assets は「参照ゼロ + deleting」となり通常 GC ライフサイクルに自然合流する。
- **論点(spec 送り)**: GDPR 観点で user 削除後の画像実体(R2 + assets 行)の残置期間を許容するか(grace 30 日をそのまま適用 vs deletion 由来は優先 sweep)。

---

## 総括(agree / disagree / 不明)

### blast radius: **小**(二重持ち採用時)
新設 = refs table(migration 1 本)+ handleImages の同 tx 全置換 + backfill script + reconciler / R2 seam / catalog entry(前 spec から流用)+ resolve WHERE 1 条件 + user-deletion 1 行 + invariant test 更新。読者・client・sync プロトコルは全て無風。配列廃止を選ぶと**中**(mapper/pull/session 再構築 + legacy entry の行き場問題)。

### 二重持ち vs 配列廃止: **CC 推奨 = 二重持ち**(agree)
根拠: ① client プロトコル不変 anchor と無摩擦 ② 書き手が W1 単一点ゆえ同 tx 更新で drift を構造的に防げる ③ **legacy OCR entry(非 UUID・source_ref)は refs に格納できない**ため配列廃止は実質不完全(jsonb をどのみち残すことになる)④ GC 権威(refs・cascade で消える)と表示/同期 wire(配列)の責務分離が明快。

### field_key 復元可否: **復元可能**(agree)
target('question_text' / 'option:<optionId>')+ 同 target 内配列順で (field_key, ordinal) を完全復元できる。現存 UUID 参照は事実上 question_text のみ(per-option gallery 未実装)。GC 単独なら (card_id, asset_id) で足りる — field_key/ordinal を持つのは将来の表示再構築・並び保証への布石としての判断。

### 新 spec 起草に必要な追加情報: **ほぼ無し**(実装判断レベルの論点のみ)
spec で決める論点として持ち越し: ① resolve の追加条件(refs EXISTS vs state のみ — D のトレードオフ)② user 削除由来 asset の残置期間(grace 30 日一律 vs 優先 sweep)③ `'reserved'`→`'pending'` rename の要否 ④ refs の (field_key, ordinal) を初版から持つか (card_id, asset_id) 最小で始めるか ⑤ backfill の実行タイミング(migration 内 SQL vs 別 script)。

### 不明(残余)
- option 削除時の `option:<id>` target entry 掃除は現状存在しない(per-option gallery 実装時の要設計・本正規化では非 blocking)。
- 実 DB(stg/prod)の images target 分布は未クエリ(zero-user + 生成経路不在ゆえ question_text のみと推定、確認は backfill dry-run で可能)。
