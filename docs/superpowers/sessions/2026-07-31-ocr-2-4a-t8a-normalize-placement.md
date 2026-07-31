# ②-4a T8a: normalize-prepared.ts の配置判断(domain 外へ relocate)

- 日付: 2026-07-31
- 判断者: OT + claude.ai(CC は事実調査のみ readonly 実施)
- 決定: **`lib/ocr/domain/normalize-prepared.ts` → `lib/ocr/normalize-prepared.ts`(non-domain)へ relocate**。logic / test 不変、path + import のみ。plan の path 指定を修正済(Task 8)。

## 背景

T8a(pure normalize)の canonical review が「domain 内 zod は DDD 慣習違反」と指摘。plan は `lib/ocr/domain/` を指定していたため、plan-vs-convention の対立として OT 判断に上げた。

## 調査結果(readonly・CC 実施)

1. **eslint zod ban の適用**: 5 block が `lib/{stripe,reviews,cards,tags,media}/domain/**` に scoped(eslint.config.mjs:369/393/418/442/466)。**`lib/ocr` は eslint.config.mjs に一切登場せず** → `lib/ocr/domain/` は **ban 対象外 = 機械強制の違反ではない**。
2. **carve-out**: 前例ゼロ。zod を runtime import する domain file は新 T8a file のみ。他 5 domain は zod-free、eslint-disable 例外もなし。
3. **domain 定義**: CLAUDE.md 設計方針 L211 = domain は pure(I/O なし)。**F3 spec §3.4** が「zod bounds を `lib/validation/` に集約するのは **domain zod-free 原則の帰結**」と明示。**F3 §3.2** = domain は検証済み入力前提・未検証入力の防御は handler 責務。precedent = `lib/validation/card.ts` / `lib/cards/card-field-handlers.ts`(いずれも domain 外の zod consumer)。`lib/ocr/ocr.ts` も既に zod 使用(boundary 層は `lib/ocr/` non-domain 側)。

## 決定理由(OT)

「eslint 機械強制の違反」という当初理由は**取り下げ**(調査で ban 対象外と判明)。そのうえで relocate と判断:

1. **F3 spec §3.4 が domain zod-free を意図的に文書化**。lint はその原則の一部を機械強制しているに過ぎず、**原則自体は全 domain に及ぶ**。`lib/ocr/domain/` に ban が無いのは「まだ書かれていなかっただけ」。
2. **domain 内 zod の前例ゼロ**。初例を作る根拠が「plan にそう書いてある」のみでは不足。
3. **F3 §3.2 が本ケースを直接排除**。normalize-prepared は未検証入力(raw Gemini JSON)の防御 = domain に置くのは設計意図と逆。
4. **OCR の実態が既にそう**。`lib/ocr/ocr.ts` が zod 使用 = boundary 層は `lib/ocr/` non-domain 側。新 file もそこに置けば実態と揃い、`lib/ocr/domain/` は純粋層用に空けておける。

## 重要な明記事項

**`lib/ocr/domain/` は現状 eslint の zod ban 対象外だが、domain zod-free 原則(F3 spec §3.4)は適用される。** lint 未強制と原則不適用は別。将来 `lib/ocr/domain/` に実際の pure 関数を置く際、ban を追加して機械強制へ昇格する(follow-up 台帳・todo-v47 §残件記録に trigger 付き記録済)。

## 併せて修正した Critical(cardId / assetId 検証欠落)

relocate 先で修正: `option uid` のみ v4 検証され `cardId` / `assetId` が未検証の非対称は設計の抜け。v4 + 横断 unique を検証し違反は該当 card / figure を isolate + tally(keep-first / drop-later の決定的 isolation・§5.3 element isolation 原則)。
