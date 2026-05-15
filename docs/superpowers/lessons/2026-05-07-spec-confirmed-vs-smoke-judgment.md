# Spec で確定済の意図的設計を smoke で覆さない判断軸

**作成日**: 2026-05-07
**抽出元 sprint**: Phase 1 I-K (3 layer chrome 整備 + Route Group 全統合)
**関連 session**: `docs/superpowers/sessions/2026-05-06-phase1-i-k-close.md` §9
**関連 spec / plan**: `docs/superpowers/specs/2026-05-06-phase1-i-k-marketing-auth-app-route-groups.md` §確定方針 §placeholder 拡張方針

---

## TL;DR

spec / plan で OT が確定した意図的設計 (例: placeholder の生表示 / hero skeleton 維持 / 法務 page 内容不変) を、 OT smoke 観察段階で「見た目が悪い」 「user に意味不明」 等の理由で claude / claude.ai が NG 判定するのは**判断越権**。 smoke 観察の役割は「確定設計が production で動作するか」 であり、 「確定設計の妥当性そのもの」 を再評価する場ではない。 設計妥当性は spec / plan 段階で OT が確定済、 smoke で覆らない。

---

## 起きたこと (Phase 1 I-K commit 1 OT smoke 段階)

### 経緯

1. spec / plan §確定方針 で OT 確定:
   - Logo (chrome 上端) / MarketingFooter © 表記 / top page hero h1 の text を `{{SERVICE_NAME}}` placeholder で表記 (生 text「Vocab App」 ではない)
   - 既存 legal-placeholders.md sed system 相乗り、 sed 1 発で app 名差し替え (Phase 2 template 抽出時)
   - plan00 production user 0、 placeholder 生表示の被害ゼロ
2. commit 1 (`08abfe8` → `9f9f94e [reviewed]`) production deploy 後、 OT が S1-S7 smoke 実施
3. claude.ai 側で「placeholder `{{SERVICE_NAME}}` が production page に生表示されてる、 これは smoke NG では?」 と一時報告 (本 thread を介さず claude.ai 側経路)
4. OT 指摘: 「placeholder 生表示は spec / plan §確定方針 通りの意図的設計、 smoke NG ではない」 と訂正、 claude.ai 側で誤判断と認識し撤回
5. 結果: smoke 全 pass 確定、 commit 1 amend `[reviewed]` で sprint 進行

### 何が起きていたか

claude.ai 側が smoke 観察時に **spec / plan §確定方針 を参照せずに**「production user 視点の見栄え」 で評価し、 確定済の意図的設計を NG 判定しようとした。 OT が「これは spec で意図的設計と確定済、 smoke で覆さない」 と即訂正したことで誤判断は無害化、 sprint 進行に影響なし。

---

## 判断軸 (next time 同様の場面で適用)

### smoke 観察の本来の役割

- **OK 検証**: 確定設計が production で **動作するか** (URL 解決 / chrome 表示 / form 送信 / Discord 着信 / DB 同期 / 認証フロー / etc.)
- **NG 検出**: 確定設計に対する **実装の不具合** (logic bug / 環境依存 fail / race condition / external service integration error / etc.)

### smoke 観察の **対象外**

- **設計妥当性そのもの**: 「placeholder 生表示は user に親切か」 「hero h1 が短すぎないか」 「LP 文言が冷たくないか」 等の評価軸
- これらは **spec / plan 段階で OT が確定済**、 smoke で再評価しない

### 判断 path

smoke 観察中に「これは NG では?」 と感じた場合の確認順序:

1. **spec / plan §確定方針 を参照** — OT が意図的に確定した設計かどうかを確認
2. **§Non-goals / §Risks を参照** — 同事項が「scope 外」 「許容 risk」 として明記されているかを確認
3. spec / plan で明記なしの場合のみ、 OT に「smoke 観察で X が気になる、 設計判断を仰ぐ」 と報告
4. spec / plan で明記ありの場合は smoke pass 判定、 設計妥当性は不問

### 例 (本 sprint の場合)

- placeholder `{{SERVICE_NAME}}` 生表示 → spec §placeholder 拡張方針 で確定済 (sed system 相乗り、 plan00 production user 0、 Phase 2 template 抽出時に sed 1 発で差し替え) → **smoke pass**
- hero h1 が「Vocab App」 から `{{SERVICE_NAME}}` に変わって殺風景 → spec §LP 本体方針 で「skeleton 維持、 個別案件で作り込み」 と確定済 (plan00 自身の LP UI 大幅改善は §スキップ判断) → **smoke pass**
- 法務 page max-w-3xl wrapper が `<article>` 自身に直結 (`<div>` 新設ではない) → plan Task 3 文言から逸脱だが review で「semantic improvement」 と認定済 → **smoke 範疇外** (review で justified deviation 確定済)

---

## なぜ起きたか (root cause 推定)

- claude.ai 側 thread は **本 thread の spec / plan 履歴を直接参照しない** (別 session、 知識共有限定)
- smoke 観察は production URL を見る = 「user 視点」 にスイッチしやすく、 「設計確定事項」 の参照を忘れがち
- placeholder 生表示は **user 視点では明らか「壊れた表示」** に見える、 ただし plan00 は user 0 / 量産テンプレ前提の特殊状況

---

## 再発防止 (future sprint で適用)

### 1. smoke 観察前に spec / plan §確定方針 + §Non-goals を読み直す

OT が smoke 依頼時に「spec §X / plan §Y 通り確定済」 と明示する場合は、 該当 section を smoke 中も参照し続ける。 spec が長い (500 行+) sprint では `grep "確定方針\|Non-goals"` で要点を予め抽出しておく。

### 2. claude.ai 側で smoke 観察する場合は spec / plan を share する

claude.ai は本 thread の文脈を共有しないので、 smoke 観察時に「spec / plan の要点」 (確定設計の意図 / Non-goals / placeholder 戦略 等) を最低限 brief しないと user 視点に偏った誤判断が起きやすい。

### 3. 「user 視点で気になる」 ≠ 「smoke NG」

production URL の見栄えで違和感を感じても、 即 NG 判定せず「これは spec で確定済か?」 を確認する。 確定済なら **意図的設計** であり smoke pass、 未確定なら OT に判断仰ぐ (claude が単独で NG 判定しない)。

### 4. plan00 特有の判断軸 (template 抽出前提)

plan00 は **量産テンプレ抽出 prep** の MVP、 production user 0 / 未配備 placeholder / skeleton LP 等は **意図的に template default 状態** で残している。 user 視点の「壊れた表示」 は本 project では「sed 置換待ち」 「個別案件で作り込み待ち」 の正常状態。 同 plan00 を題材に smoke するときは「template 抽出前提」 を頭に入れる。

---

## 関連参照

- spec / plan: `docs/superpowers/specs/2026-05-06-phase1-i-k-marketing-auth-app-route-groups.md` §確定方針 §6 + placeholder 拡張方針
- legal-placeholders.md: `docs/legal-placeholders.md` (sed system 本体)
- session log: `docs/superpowers/sessions/2026-05-06-phase1-i-k-close.md` §9
- TODO.md §スキップ判断: 「トップページ UI 大幅改善」 は plan00 では実装しない、 量産方針で template 側 base UI で吸収 (本 lesson と整合)
