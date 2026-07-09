# Codex plan cross-check — f2-session-aggregate-plan (2026-07-09)

- **作成日**: 2026-07-09
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **2 書込点の整合性**
  - Phase 0 session 行 upsert と Phase 1-2 answer_events/replay が別 tx・別 wire 契約であるため、aggregate 化しても「単一 use-case に統合しない」判断が重要。
  - status clamp が起きても events は通常処理される必要がある。ここを route 側の error / failed[] と混ぜると、確定判断 1 に反する。

- **status 遷移規則の単一定義と SQL 実装の乖離**
  - `canApplyStatusWrite` が domain の正で、実 DB では `ON CONFLICT ... DO UPDATE ... WHERE` が執行点になる。
  - TS の unit test だけでは SQL 述語の実挙動を検証できないため、fake / SQL / stg smoke の責務分担を明確に残す必要がある。
  - `excluded.status` の Drizzle 表現が不安定なら raw SQL を許す、という判断は妥当だが、実装時に型・SQL 方言・alias の誤りが出やすい。

- **`completed_at` の扱い**
  - status ガード不発時に `completed_at` も守る必要がある。
  - same-status 再送では LWW を維持するため、「terminal timestamp を凍結する」仕様と誤読されない test が必要。
  - `abandoned` で `completed_at = null` の現行挙動を、将来の意味づけと混同しない記録が必要。

- **tenant no-op と clamp の観測**
  - `.returning()` 0 行は「status clamp」と「他 user の session_id 衝突」を区別できない。
  - 区別しない設計は単文性維持として妥当だが、log 名・message が clamp 断定に寄りすぎると運用調査を誤誘導する。

- **test fake の信頼性**
  - 現状 fake が upsert merge / returning を模していないため、G1 がこの spec の実効性を左右する。
  - fake が `canApplyStatusWrite` を直接 import する設計は定義のズレを防ぐ一方、SQL 述語のバグは拾えない。この限界を明示したままにする必要がある。
  - 共有 fixture と route.test inline fake の二重管理は、片方だけ強化されるリスクが高い。

- **挙動不変 refactor の検証境界**
  - R では既存 golden / snapshot / G 追加分を更新しないことが重要。
  - ただし「snapshot 更新ゼロ」だけでは SQL where 条件・owner scope・failed[] 順序の維持は十分に証明できないため、専用 assert が必要。

- **domain 純度**
  - domain は zod / drizzle / logger / db / next に依存しない。
  - `replayCard`, JST, FSRS 型など pure sibling の例外は最小化し、lint で将来の逆流を防ぐ必要がある。

- **wire 契約凍結**
  - clamp は 409 や failed[] に出さず、200 `{ok, failed}` のまま。
  - permanent-4xx / transient-503 / Retry-After の既存分類を route 側に残す必要がある。

- **owner scope**
  - repository 抽出時に全 query の `userId` 条件を落とすリスクが最大級。
  - `applyCardFinalStates` の VALUES UPDATE count mismatch は storage 整合性検査として維持されるべき。

- **failed[] の構成順**
  - orphan/A-2 rejected と tx 失敗時 applicable 全滅の順序が wire 契約化している。
  - duplicate event は failed[] に入れない、という冪等契約も維持対象。

- **event admission と session status の非連動**
  - 正当な遅延 flush を通すため、event admission に session status 参照を追加しない。
  - 将来 F3 で status 参照が必要になった場合の拡張点はあるが、F2 では先回りしない。

- **commit 境界**
  - G/R/W を分けることは、挙動不変 refactor と唯一の挙動変更をレビュー可能にするための設計要件。
  - W は test-first で赤確認が必要だが、実際の履歴・ledger にどう残すかが曖昧だと形骸化する。

## plan ドラフトへの抜け・未考慮指摘

- **log event 名が少し断定的**
  - spec は tenant no-op と clamp を 1 warn event に束ねるとしているが、plan の Task 6 は `review_events.session_upsert_blocked` を clamp 文脈で扱っている。
  - warn payload / message は「guarded upsert が適用されなかった」程度にし、status clamp 断定を避ける観点を明記した方がよい。

- **`applied: false` 判定の実装条件が曖昧**
  - `.returning()` 0 行だけで false にする場合、insert 成功・update 成功・tenant mismatch・guard rejection の各戻りをどう fake / repo test で表現するかが plan 上やや薄い。
  - R では `applied: true` 固定、W で実計算に変えるなら、route 側の既存 catch 分岐と混ざらない test が必要。

- **Drizzle raw SQL の安全確認が不足**
  - plan は raw sql fragment 許容まで書いているが、具体的に `excluded.status` 参照、table alias、quoted column 名、`setWhere` の生成 SQL確認をどこで見るかが弱い。
  - `toSQL()` 相当や debug 出力で SQL 断片を確認する step を入れると、stg smoke 前の検出力が上がる。

- **repository unit test の fake 対象が不明確**
  - Task 3 に repository unit test 観点はあるが、既存 fake db でどこまで SQL shape を assert できるかが不明。
  - 特に owner WHERE verbatim、count-mismatch throw、distinct study_days 集計 SELECT は refactor リスクが高いので、assert 方法を明文化した方がよい。

- **G1 の「既存 test に触らない」が現実と矛盾しうる**
  - fake 強化により既存 test の setup が壊れる可能性があり、必要最小限の既存 test setup 修正は発生しうる。
  - 「既存期待値を変えない」「実装コード不触」と表現した方が安全。

- **inline fake と共有 fixture の二重管理リスクが残る**
  - plan は統合しない判断をしているが、W で `canApplyStatusWrite` import を両方に入れるため、将来片方がズレる負債は残る。
  - scope 外なら、最終 docs に「二重 fake 残債」として記録する項目を入れるとよい。

- **W test #6 の FSRS 適用 assert が過剰に脆くなる可能性**
  - clamp 時 events 通常処理を証明する目的なら、answer_events insert と reviews/cards 更新の代表 assert で足りる可能性がある。
  - FSRS の細部値まで見ると F2 外の replay/FSRS 契約に test が密結合するリスクがある。

- **abandoned 系の W test が片側不足**
  - spec の非真空 test は `abandoned→active` はあるが `abandoned→completed` は stg smoke でも机上扱い。
  - plan は対応表で補う構成だが、unit test では #9/#10 を網羅する一方、route-level では #10 がない。terminal 凍結の代表性として許容するか、軽い route test を足すか判断が必要。

- **contract test の置き場は明記されているが責務がやや混ざる**
  - W #8 を contract file に置くのはよい。
  - ただし logger.warn や DB 保存状態 assert は route.test 側に閉じ、contract test は wire だけを見る、と明記すると test の層が保たれる。

- **`processSession` API 不変の型レベル確認が薄い**
  - Global に契約は書かれているが、R2 で関数 signature が accidental に変わった場合の検出が route 経由だけになる。
  - 既存 import 呼出があるなら十分だが、明示的な type-level / direct test があるかは確認論点。

- **client diff ゼロ確認の path が限定的**
  - plan の `git diff --stat <G直前>..HEAD -- lib/sync lib/client-db.ts app/(app)/app/study` は、要件にある Dexie store / runner 系を完全に覆っているか不明。
  - `runner` 系 file の実パスを fact-finding から明示しておく方がよい。

## リスク / 対立しうる設計判断

- **terminal 凍結 vs 訂正可能性**
  - completed↔abandoned 横滑りを拒否する設計は単純だが、将来「誤 abandon の訂正」要求が出ると仕様追加が必要。
  - 現時点では zero users / UI 配線なし / YAGNI なので妥当。

- **application guard vs DB constraint**
  - schema 変更ゼロ方針により CHECK / trigger は使わない。
  - その分、SQL upsert 述語と application domain 定義の二重化リスクを smoke と test で補う設計になる。

- **wire 非表出 vs client 整合性**
  - clamp を client に返さないため UX 改修不要だが、client local session と server session の divergence は残る。
  - fact-finding 上は pull-back 経路なしで無害とされるが、将来 sync が双方向化される場合は再評価が必要。

- **fake unit 方針 vs 実 DB 検証**
  - 既存方針に合わせて実 Postgres integration を作らないのはスコープ制御として妥当。
  - ただし今回の核心は SQL 述語なので、stg smoke が実質的な最終防衛線になる。

- **repository 意図別 API vs task 数増**
  - 汎用 repository にしない設計は DDD 境界として明快。
  - 一方で抽出関数が多く、R2 の blast radius は大きい。R2 review では owner scope・順序・failed[] を重点的に見るべき。

- **domain に `buildCardOptionIndex` を置く判断**
  - malformed options の fail-closed を domain test で見える化できる利点がある。
  - ただし JSON shape 正規化が domain に入るため、domain の structural 型が広がりすぎないよう注意が必要。