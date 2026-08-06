# ②-4a 実装 セッション引き継ぎ(T9 完了時点)

- 日付: 2026-07-31
- 位置付け: context 上限接近のため T9 完了で区切る。T10 以降(crop 実行・publish・GDPR)へ引き継ぐ。
- **書き方の方針**: 「何をしたか」でなく「**なぜそう決めたか**」を優先。実装はコード+spec で分かるが、判断理由は記録がないと失われる。本 sprint は claude.ai の判断が複数回覆っており、その経緯自体が次セッションの再推測防止情報。

---

## 1. 現在地

**全て develop 直・未 push(push は OT 判断。stg smoke は push 後)。** 範囲 `c38ddb0`(sprint 前)..`18da20d`(現 HEAD)。

| task | 内容 | commit | tag |
|---|---|---|---|
| T0 | sharp direct 化 | `b5d86f1` | [no-review] |
| T1-3 | schema 3 表(source_assets/upload_operations/asset_derivations) | `16474a6`/`2e45972`/`359bf46` | [no-review] |
| (改訂) | 検証5列 nullable + input_fingerprint 廃止 | `f2da717` | [no-review] |
| T4 | prepareUpload(prepare 入口・advisory lock・冪等・同時1upload) | `ad91abd` | [reviewed] |
| T5 | source reserve/finalize(temp→server promote・immutable) | `55f0d83` | [reviewed] |
| T6 | expected_source_count 列 + claim/lease CAS/daily cap(単一 tx) | `a4dc416`(schema)+`ad8a7b5`(feat) | [no-review]+[reviewed] |
| T7 | OCR 探索 schema + 図版 suffix prompt + source_id interleave | `8fe10f8` | [reviewed] |
| T8a | normalize-prepared(executable-contract schema SSoT) | `42580d2` | [reviewed] |
| T8b | stagePrepared(OCR→正規化→fenced payload 保存) | `bac5c7e` | [reviewed] |
| T9 | crop-geometry(box_2d→pixel rect・pure) | `63a0244` | [reviewed] |

**残タスク**(Phase D-F):
- **T10** crop + R2 条件付き PUT + asset 行 + provenance → **stg-smoke gate**(外部副作用=crop R2 書込)。
- **T11** publisher 純関数抽出(projectCardAssetRefs / assertReadyOwnedAssets / camel↔snake 変換)→ feat [reviewed](test 増=red+簡易 review)。
- **T12** publishPreparedUploadTx → **stg-smoke gate + fencing/prepared-takeover checkpoint**(本 sprint 最難所・§4)。
- **T13** applyOcrTags deterministic 化 → feat [reviewed]。
- **T14** deadline/retry 保持/source_assets GC/stale 統合 → **stg-smoke gate**(破壊操作)。
- **T15** GDPR Group I(退会経路に upload_operations/source_assets)→ **stg-smoke gate**(削除経路)。
- **T16** 提示(除外理由別)+ 回転除外(EXIF≠1)→ feat [reviewed]。

**正本 path**:
- spec: `docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md`(**凍結・実装中改訂は OT 確定分のみ反映済**)
- plan: `docs/superpowers/plans/2026-07-30-ocr-2-4a-image-figure-crop.md`
- Codex 記録: `docs/codex/2026-07-31-ocr-2-4a-*.md`(task ごと)
- SDD ledger(running record): `.superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/progress.md`(gitignored)
- 判断 doc: T5 checkpoint=`2026-07-31-ocr-2-4a-t5-checkpoint.md` / T6 fencing checkpoint=`2026-07-31-ocr-2-4a-t6-fencing-checkpoint.md` / T8a 配置=`2026-07-31-ocr-2-4a-t8a-normalize-placement.md`

---

## 2. 文脈再構築の読む順(spec 全文を最初から読まない)

1. **本 doc §3(原則)+ §4(T12 要件)** — 最優先。踏んだ失敗の要約。
2. **spec §2 / §2.1 / §2.2** — 状態機械・lease/fencing・claim atomicity・prepared takeover。fencing モデルの核。
3. **spec §5.4** — prepared schema executable-contract SSoT(T8 収束設計)。T12 が同 schema を parse する契約。
4. **spec §8** — publish(T12)設計。
5. **plan の該当 task**(T10 なら Task 10 のみ)。plan は 10-20 行/task の設計判断記録。
6. **architecture.md §8** — executable-contract 原則(本 sprint で確立)。
7. **T6 fencing checkpoint doc** — fencing の権利取得 vs 最終防衛の分離。
8. 必要時 ledger `progress.md`(各 task の findings・fix ループ経緯)。

---

## 3. 今日確立した原則(最重要・理由とセット)

### 原則 1: 既存の契約は再現せず再利用する。再利用できない形なら、まず再利用できる形を作る。

- **踏んだ実例**(いずれも repo 現物確認で訂正された):
  - **UUIDv5**: 当初 crop asset ID を決定的にするため UUIDv5 案。だが既存 `isAssetKey`(`lib/validation/card.ts`)が **v4 のみ** asset 判定する契約を確認せず採用しかけた → v5 だと ready 検証・ギャラリー・refs 射影の全対象外=画像が一切表示されない。UUIDv4 stage 発行+retry 再利用へ撤回(spec §7.2/§D)。
  - **handleImages の refs 射影**: publisher が既存 card 前提の `handleImages` を呼べないため、射影ロジックを純関数 `projectCardAssetRefs` に抽出して再利用(T11)。
  - **`PreparedCard` の部分模倣**(最重要): normalize が publisher の card 検証を **field ごとに部分模倣**したため、抜けが出るたび新 Critical(uid→cardId/assetId→option bounds→sort_key の **4 周 whack-a-mole**)。
- **3 つ目が最重要な理由**: `PreparedCard` が **TS 型で手書き**され実行時 schema という**器が無かった**ため、normalize も publisher も個別 schema を当てるしかなく一致保証がどこにも無かった。**器(単一 `preparedCardSchema`)を作って** normalize/publisher が同一 schema を共有 → drift を構造排除して収束(spec §5.4)。**「個別 import せよ」では列挙漏れが構造的に残る**(claude.ai は当初これを指示したが不十分だった)。

### 原則 2: 同一の業務不変条件を複数経路で強制する場合、同一の executable contract を再利用する。

- 表現や信頼境界が異なる場合は別 schema を許容するが、**変換後の共通契約を定義し、部分的な再実装で模倣しない**。
- `architecture.md` §8 に明文化済(本 sprint 3 回目の再発ゆえ原則化)。
- 統一しないものの線引き: OCR raw schema(Gemini 出力形状)/ manual card schema(UI 入力)/ DB schema は目的が異なり統一しない。DB 文脈検証(owner/ready/hash・存在・fencing)は publisher 専用(element isolation とは別不変条件)。

### 原則 3: plan の記述は spec の要件ではない。

- plan は spec から降ろした**実装計画**であり、それ自体は権威ではない。確立した原則と衝突したら**独断で plan に従わず停止して相談**する。
- **踏んだ実例**: `normalize-prepared` の配置。plan は `lib/ocr/domain/` を指定していたが、domain zod-free 原則(F3 spec §3.4「zod bounds は domain 外の `lib/validation/` へ」)と衝突。raw Gemini JSON を zod で境界検証する module は domain に置けない → `lib/ocr/`(non-domain)へ relocate(判断 doc あり)。**lint 未強制でも原則は適用される**(`lib/ocr/domain/` は zod ban 対象外だったが、原則としては全 domain に及ぶ)。

---

## 4. T12 checkpoint 要件(次セッションの主要な難所)

T12(publish)は本 sprint で最も判断が集中する。**完了時に別 stop checkpoint(OT + claude.ai)**。

- **fencing は「権利取得側(T6)」と「最終防衛側(T12)」で別物**。T6 の claim CAS が正しくても、T12 の検証が抜ければ **lease を奪われた旧実行が publish できてカード二重作成**。
- publish 冒頭で operation を **`SELECT … FOR UPDATE` + `status='prepared' AND lease_version = :mine` を検証**、不一致は旧実行として **reject**。
- **prepared takeover の経路が未実装**(現在 claim は `already_prepared` を返すだけ)。以下を満たすこと: lease 期限切れの `prepared` を **新 lease_version で takeover** でき、旧 worker が fencing で prepared 更新/publish を拒否され、**Gemini 再実行がないため daily cap を適用しない**(spec §2.2)。
- **asset は `SELECT FOR UPDATE` だけでは不十分**。**条件付き保護 UPDATE**(`SET unreferenced_at=NULL WHERE user_id AND id IN(...) AND status='ready' RETURNING id`)で**期待件数の全件が返った**ことを確認してから refs を張る(GC が ready→deleting に promote する競合を閉じる・spec §8.1)。
- **publisher は `normalizePreparedCard` を呼ばない**(ID の再発行・再正規化をしてはならない。payload は T8b が唯一の producer)。
- publisher は保存 payload を `preparedPayloadSchema.parse()` し、**`parse` の戻り値だけを使う**(元 candidate を後続処理で使わない)。parse 失敗は loud(payload は normalize 済ゆえ通るはず=通らなければ bug)。
- **ロック順序**: `operation → source_document → source_assets(ID 順) → derived assets(ID 順)`(全処理統一・デッドロック回避・spec §2.1/§8.1)。
- **cards に `ON CONFLICT DO NOTHING` 不使用**(同一 tx 内のため重複は設計破綻・loud に失敗させる)。
- 既存 helper 再利用可否(spec §8.2): `saveExtractedCards`=要改修(RETURNING 順依存→card ID 対応付け)/ `applyOcrTags`=§T13 の determinism 版 / `completeUploadTx`=不可(開始 status 非検証)/ `bumpExamCardCount`=affected row 検証追加。

---

## 5. 未解決・持ち越し

### follow-up 台帳(claude.ai 管理の todo・全て trigger 付き)
- **旧 flow 共存チェックの撤去**(T16 で UI が新 flow 切替 + 旧 `runUploadGuardTx` 削除時)。
- **②-5 R2 staging aggregate budget**(下記 residual risk)。
- **`lib/ocr/domain/` への zod ban 追加**(実 pure 関数を置く時に機械強制へ昇格)。
- **②-4a drift seam 4 件**: T7 `ImageCropExtractedCard` 手書き複製 / `FigureRegion` 3 表現(parity test)/ 画像 10 上限重複(T12 で 3 つ目の `10` を作らない)/ 除外理由型分岐(T16 で別 union を作らない)。
- **source manifest 検証の重複**(T6 claim + T8b stage が各実装・共有 pure helper 抽出・T6/T8b 次 touch 時)。

### 明示的に受容した residual risk
- **R2 staging に最大 40×5MiB=200MB**: claim の 4MB は **OCR admission limit** であって R2 staging 上限ではない(spec §6.5)。**受容条件**: 40 件・各 5MiB のサーバー強制 / 同一 user active upload 1 件 / rejected・abandoned の短 GC / operation 作成 rate limit。→ **②-5** で GC/rate limit/quota 対処。
- **daily cap の非原子性**: 原子的枠確保(`INSERT…ON CONFLICT WHERE count<limit`)は非実装。**受容理由**: 実ユーザー 0・超過してもサービス上限を 1〜2 回超える程度・実ユーザー増加後に再判断(spec §3)。

### ②-4b / ②-5 送り
- **②-4b**: PDF 選択的 rasterize / Files API / page 固有メタ / exp7(回転 JPEG 座標裏取り→ §4.5 回転除外を外す)/ bbox 保持のパディング再調整 / ambiguous target 許容 / prompt 画像 3 件。probe script `scripts/ai/_ocr-*.ts` は残置(exp7 再利用)。
- **②-5**: account quota(月次ページ)/ R2 staging aggregate budget。

---

## 6. stg-smoke gate の扱い

T10 / T12 / T14 / T15 は **push→stg smoke 後に [reviewed] 確定**(破壊/外部副作用ゆえ・plan「Commit 分離方針」)。push は OT 判断、smoke は push 後。**実 API・実機確認は OT の合図が必要**(丸投げ禁止・URL/手順/期待/mobile 要否を整理)。

- **T10**(crop 保存): 実 crop → R2 条件付き PUT(`If-None-Match:*`)の 412 分岐 / hash 照合 / 決定 ID 再現。
- **T12**(publish): cards/tags/refs 同一 tx 確定 / fencing 拒否 / 保護 UPDATE 期待件数 / 冪等再 publish で増えない。
- **T14**(GC): source_assets 参照ゼロ→deleting→R2 delete / stale が live operation 除外(reconciler は W1 deploy 後・dry-run 先行)。
- **T15**(GDPR): 退会後 upload_operations/source_assets count0 + R2 delete 呼出。
- smoke は Playwright MCP(唯一のブラウザ MCP)。stg=stg.recallmint.nekotest.net。

---

## 7. 覆った claude.ai 判断の記録(再推測防止)

本 sprint で claude.ai の当初判断が repo 現物確認で複数回訂正された。**同じ推測を繰り返さないための情報**:

| 覆った判断 | 訂正後 | 理由 |
|---|---|---|
| 3-ゲート方式(読取経路に除外条件) | prepare→publish(未完成 card は DB 非存在) | 3 ゲートは「新読取経路ごとに除外を書き忘れない」人間規律に永続依存。publish 方式は未完成 card が DB に無く**構造的に漏れない** |
| UUIDv5(決定的 crop ID) | UUIDv4 stage 発行 + retry 再利用 | `isAssetKey` が v4 のみ→v5 は画像が一切表示されない(契約未確認) |
| schema を個別 import | 単一 `preparedCardSchema` SSoT | 個別 import では import 対象の列挙漏れが構造的に残る(sortKey が漏れた) |
| normalize を `lib/ocr/domain/` | `lib/ocr/`(non-domain) | domain zod-free 原則(lint 未強制でも適用) |
| 「eslint 機械強制の違反」(relocate 理由) | 取り下げ(ban 対象外) | 調査で `lib/ocr` は ban スコープ外と判明。relocate 理由は F3 原則側に置換 |
| client 側 size/mime を DB 永続化 | 非永続(署名ヒントのみ)+ 検証済列は finalize | client 申告は信用せず server 実測(T5) |

**教訓**: claude.ai は判断材料整理担当。実装可否・契約は **repo 現物(コード/既存 schema/lint scope)を CC が確認**して裁定する。plan/kickoff の記述を鵜呑みにしない。

---

## 8. 次セッション冒頭に貼る引き継ぎプロンプト(CC 視点)

(本 doc の下に別途出力)
