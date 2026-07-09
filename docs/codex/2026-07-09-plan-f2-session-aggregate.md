# Codex plan cross-check — f2-session-aggregate (2026-07-09)

- **作成日**: 2026-07-09
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **status 後退の定義を全域で固定する必要**
  - `completed -> active` は明確に後退。
  - `abandoned -> active` も後退。
  - `completed <-> abandoned` を「後退」とみなすか、「terminal 間の訂正」とみなすかは設計判断が必要。
  - 「状態後退のみ拒否」という固定判断だけでは、terminal 間横滑りの扱いがまだ曖昧になりうる。

- **正当な遅延 flush と status upsert の分離**
  - completed/abandoned 済み session に answer_events が遅延到着することは正当。
  - したがって guard は event admission ではなく session row の status write に限定する必要がある。
  - clamp されても event/replay/read model 処理を続けるか、session phase 失敗扱いにするかは wire 契約維持上の重要点。

- **wire 非変更の具体化**
  - D-2 により 409 や failed[] 追加などは不可。
  - status 後退拒否を response に出さないなら、client は成功と見る。
  - その場合、server/client Dexie の session status divergence は意図的に許容する設計になる。

- **2 書込点を aggregate 経由に寄せる際の tx 境界**
  - route Phase 0 は events tx 外。
  - processSession は answer_events/replay/study_days を tx 内で処理。
  - aggregate 経由に寄せても、1 tx に統合すると現 wire/失敗順序が変わるため避ける必要がある。

- **status guard の実装方式**
  - read-modify-write は TOCTOU と round-trip 増。
  - 単文 upsert の `setWhere` に guard を埋めるなら、既存の tenant guard と合成する必要がある。
  - ただし SQL predicate と domain pure 関数の二重表現が発生するため、等価性の検証方針が必要。

- **tenant guard と status guard の失敗原因が混ざる**
  - `setWhere` が不発になる理由は「他 user session_id 衝突」か「status 後退」。
  - 両方を同じ 0 rows として扱うなら observability 上の分類が難しい。
  - ただし wire には出せないため、log の粒度設計が必要。

- **completed_at の保護**
  - status だけでなく `completed_at` の巻き戻し/null 上書きも同時に防ぐ必要がある。
  - 後退 payload が `status: active, completed_at: null` を送るケースを非真空 test に含めるべき。

- **card_ids insert-only 不変条件**
  - Phase 0 を repo 化すると、`card_ids` が conflict update に混入する regression risk がある。
  - schema 変更ゼロでも upsert set 節の変更で I-1 を壊せるため behavioral pin が必要。

- **owner-scope / tenant 分離**
  - route Phase 0 の `setWhere: userId` と ingest 側の owner-scoped card SELECT は不変条件。
  - fake/mock が SQL where を実際に模さないなら、unit test だけでは保証が弱い。

- **event_id 冪等と replay 対象の境界**
  - insert された event のみ replay する現仕様は強く守る必要がある。
  - refactor で `payload events` と `inserted events` の区別が曖昧になると、duplicate replay regression が起きる。

- **payload 順 replay**
  - `answered_at` sort ではなく payload 順が仕様。
  - aggregate 抽出時に Map/grouping の順序が崩れるリスクがある。

- **A-2 selected_answer_ids 存在検証の保持**
  - malformed options の fail-closed 挙動、cross-card option rejection、multi-select 許容を移植時に落としやすい。
  - F2 で is_correct 再計算に踏み込まないことと、存在検証を維持することは別論点。

- **deriveRating 契約の不可侵**
  - `rating ?? (is_correct ? 3 : 1)` と `correct_count = rating >= 2` は P0 凍結。
  - domain 抽出時に「より自然」な命名や型整理で意味を変えない注意が必要。

- **JST 集計の責務分割**
  - day key の算出は pure domain に寄せられる。
  - 既存 study_days との distinct 集計 SQL は repository 責務。
  - ここを混ぜると domain 純度か SQL 挙動のどちらかが崩れる。

- **domain import 境界**
  - `lib/reviews/domain/*` は runtime/db/logger/zod/next 依存禁止。
  - `replayCard` や JST helper を pure sibling として許すなら lint ルールで例外を具体化する必要がある。

- **client mirror は触らない判断の明文化**
  - Dexie は write-only buffer で pull-back 不在。
  - server が status clamp しても client local session が stale のまま残る。
  - それを「問題なし」とする根拠を spec に残す必要がある。

- **golden 先張りの分割**
  - F2 の W は挙動変更なので、後退許容という現挙動 pin は置かない。
  - ただし R の安全網として、W 後も不変な status 挙動、I-1、C-1、permanent-4xx は先に pin する必要がある。

- **実 DB でしか見えない risk**
  - unit fake で `ON CONFLICT ... WHERE` の完全再現は難しい。
  - SQL predicate の実挙動は staging smoke または integration 相当で確認する必要がある。

## plan ドラフトへの抜け・未考慮指摘

- **terminal 間横滑りの扱いは書かれているが、固定判断「状態後退のみ拒否」との整合説明が弱い**
  - plan は `completed <-> abandoned` も拒否している。
  - これは妥当寄りだが、「後退のみ」より強い「terminal immutable」ルールである。
  - OT 確定判断の拡張に見えるため、spec 本文で「後退の定義に terminal 間変更を含める」と明示するだけでなく、固定判断との整合をもう少し強く説明した方がよい。

- **`completed_at` の遷移ルールが status ほど明示されていない**
  - W test で completed_at 維持は触れているが、domain/VO の規則としては status 中心。
  - `active -> completed` で completed_at が入る、`completed -> active` clamp で null 上書きされない、`completed -> completed` 再送で completed_at を更新してよい/いけない、の規則が曖昧。
  - 現行は conflict set に `completedAt` があるため、同 status 再送時に completed_at が変わりうる。そこを許すか固定するか要明記。

- **abandoned の timestamp 相当がない問題への言及が薄い**
  - schema は `completed_at` だけで `abandoned_at` がない。
  - `active -> abandoned` を許す場合、completed_at をどう扱うか、既存 payload が何を送るか、test で何を assert するかが必要。

- **`upsertSessionGuarded` の返り値 `{ applied: boolean }` と wire 非表出の関係がやや未整理**
  - applied=false を route がどう扱うか、logger 以外に使わないのかを明示した方がよい。
  - permanent/transient error 分類と混同しないことも書くべき。

- **tenant 不一致 no-op と status clamp の log 分類が曖昧**
  - plan は conflict かつ 0 行を「guard 不発または tenant 不一致」として同一 warn にする。
  - C-1 は意図的 no-op であり、status clamp とは意味が違う。
  - sessionId/userId/incoming status だけで十分か、current status なしで診断可能かは未考慮。

- **SQL predicate の具体表現に注意点が足りない**
  - `existing status = 'active' OR existing status = excluded.status` は Drizzle の `excluded` 参照がどう書けるかが実装上の肝。
  - Drizzle API で安全に表現できない場合に raw sql を使うのか、その場合 import/lint/typing をどう扱うかが未記載。

- **returning 追加による既存 fake/test 影響が過小評価されている可能性**
  - Phase 0 upsert が `.returning()` になると、既存 mock chain の形が変わる。
  - G1 で fake 強化するとあるが、route Phase 0 の DB mock 全体への影響範囲をもう少し明示した方がよい。

- **G2 の「completed -> completed 冪等再送(値不変)」が現行挙動と一致するか要確認**
  - 現行 conflict set は `completedAt` と `status`。
  - 再送 payload の completed_at が異なれば値は変わる可能性がある。
  - 「値不変」を pin するなら現行挙動変更になりうるため、G に置けるか要再確認。

- **G の位置づけがやや複雑**
  - 確定判断では「②期待値筆頭 + 現挙動固定」とある。
  - plan では「②期待値は W、G には置かない」としている。
  - 実務的には妥当だが、主入力の表現とズレて見えるため、「W commit 内で期待値 golden を先に赤にしてから実装する」など、手順を明確化するとよい。

- **contract test 側に status guard を置かない判断が明示されていない**
  - W test は route.test 中心に見える。
  - wire 契約維持を直接 pin するなら contract test にも 1 本置くか、route.test で十分とする理由が必要。

- **processSession の public API/責務変化が未記載**
  - ingest が orchestrator に縮退すると、既存 route から見た関数名・戻り値・error behavior を保つ必要がある。
  - failed[] の順序、duplicate の扱い、tx rollback 時の failed[] 構成をどう保持するかが plan では少し抽象的。

- **logger の import 境界**
  - repository が logger を持つのか、route が applied=false を受けて logger を呼ぶのかが曖昧。
  - repository に logger を入れると infra と observability が密になる。domain ではないので禁止ではないが、責務は明示した方がよい。

- **`admitEvents` の rejected 型が不足気味**
  - plan は `rejected: eventId[]` としている。
  - 現 wire failed[] には理由や event_id など既存 shape があるはずで、orphan/A-2 の failure detail を落とさない設計が必要。
  - domain は reason enum を返し、ingest が wire failed[] に変換する形の方が安全かもしれない。

- **`knownCards: Map<cardId, Set<optionId>>` だけでは replay に必要な card state と option malformed 情報が足りるか要注意**
  - A-2 は malformed options を element 単位で握り潰す。
  - その処理を repository 側で Set 化してしまうと、domain test で malformed handling が見えにくくなる。
  - raw option rows を domain に渡すか、repo で正規化するならその責務を明記すべき。

- **full test/build 完了条件はよいが、read-only spec と実装 plan の境界が混ざっている**
  - design spec としては commit message や TAG なし運用まで踏み込んでいる。
  - 悪くはないが、設計判断と運用手順が同じ章にあるため、レビュー時に論点が埋もれやすい。

## リスク / 対立しうる設計判断

- **terminal immutable vs 後退のみ拒否**
  - terminal 間変更も拒否する設計は単純で安全。
  - 一方で「completed を abandon に訂正したい」などを将来許す余地はなくなる。
  - 現状 zero users かつ abandon UI が薄いなら terminal immutable が妥当だが、これは明示的な仕様化が必要。

- **wire 非表出 vs client/server divergence**
  - wire 非表出は D-2 と client 無変更に合う。
  - 代わりに client Dexie の status と server status がズレても回復経路がない。
  - pull-back 不在を前提に「server aggregate が正」と割り切る判断。

- **SQL guard 単文性 vs domain 規則の二重化**
  - 単文 upsert は race に強い。
  - ただし domain pure 関数と SQL predicate の二重管理になる。
  - fake が domain 関数を使うだけでは SQL predicate の誤りを完全には検出できない。

- **repository に太らせる vs orchestrator に残す**
  - count mismatch や distinct 集計を repo に入れると SQL 整合性は閉じる。
  - ただし repository が use-case 的に太る。
  - F1 型の「意図別 repository」を維持するなら許容範囲だが、責務名は慎重に切るべき。

- **domain に replayCard を import する vs replay を外に残す**
  - domain に寄せると aggregate として読みやすい。
  - ただし reviews domain が cards の replay logic に依存する。
  - pure sibling 許容で進めるなら lint 例外を最小化する必要がある。

- **G で fake を強化する risk**
  - fake 強化は golden の信頼性を上げる。
  - 一方で fake の実装誤りが新しい正になりうる。
  - SQL 実挙動との差分は staging smoke だけでなく、可能なら狭い integration test も検討余地がある。

- **observability の粒度**
  - clamp を warn するのは有用。
  - ただし tenant no-op と同じ warn にするとノイズ化する。
  - current status を読むために追加 SELECT するか、単文性を優先して粗い log に留めるかは対立点。

- **completed_at 冪等性**
  - completed 再送で completed_at を payload 値に更新する LWW にするか、初回 terminal timestamp を凍結するか。
  - status guard だけなら前者が現行維持。
  - 「session の帰結は一度確定したら不変」と言うなら後者も自然で、plan 内で思想が衝突しうる。