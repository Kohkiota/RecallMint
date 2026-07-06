# Codex plan cross-check — ddd-refactor-investigation (2026-07-06)

- **作成日**: 2026-07-06
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. DDD の主問題は「domain が無い」より「use-case と presentation/API が混ざっている」こと。  
   `app/api/review-events/bulk/route.ts` は FSRS replay、review insert、card update、study_days 集計まで持つ。`app/(app)/app/upload/_actions/process.ts` は quota、advisory lock、OCR、DB 永続化、失敗補償、文言生成が単一 use-case に同居。`card-tags-section.tsx` は UI component だがタグ CRUD application service として振る舞っている。

2. bounded context は `cards` テーブルを中心に重なっている。  
   Card は Content の問題本文・選択肢であり、Learning の FSRS 状態でもあり、Sync の mutation 対象でもある。DDD 化では「Card aggregate」を単純に 1 クラスにまとめるより、同一 row の content fields / scheduling fields / sync metadata をどの use-case が所有するかを明確にする必要がある。

3. local-first 同期は独立した支援サブドメインとして扱うべき。  
   Dexie mirror、`entity_mutations` outbox、`answer_events` outbox、pull cursor、tombstone、Web Locks、in-flight guard は業務ドメインではないが、挙動維持上は最重要の application/infrastructure 境界。ここを「repository」に押し込めすぎると coalesce、rollback、retry、pull-back の意味が見えなくなる。

4. wire format 凍結は payload shape だけでは足りない。  
   API response shape、HTTP status、error code、user-facing 日本語文言、cache header、`revalidatePath` 対象、Dexie cursor key、tombstone entity_type、mutation op 名、ログ/ops 通知イベント名まで、挙動同一の観点では契約扱いにすべき。

5. aggregate 候補は pragmatic に絞るべき。  
   候補は `Exam`, `CardContent`, `TagCategory/TagOption/CardTag`, `ReviewSession/AnswerEvent`, `SourceDocument/UploadRecord`, `Subscription/UserPlan`。ただし全てに entity class/repository を機械的に置くと、既存の関数型 pure helper や Drizzle/Dexie seam より複雑になる。

6. tenant isolation / auth は横断不変条件。  
   server query の `userId` scoped WHERE、API での 401/空 users 行 race、Dexie の `user_id` filter/index は DDD 層整理で埋もれやすい。repository 抽象化時に「呼び出し側が userId を忘れない」設計が必要。

7. client/server 共有ルールは単一 source 化の優先度が高い。  
   streak、due 判定、tag comparator、validation schema、plan rank、correct_answer_ids 派生、cascade/UNIQUE pre-check は drift すると仕様差になる。shared pure module に寄せる対象と、意図的に client pre-check + server authoritative check の二段構えにする対象を分ける必要がある。

8. 抽出時の最大リスクは transaction / timing / subscription の暗黙契約。  
   upload の advisory lock と in-flight row、review flush の fire-and-forget、Dexie transaction auto-rollback、card_tags 空集合同期、single subscription、inline edit debounce/commit-on-unmount は、ファイル移動だけでも壊れうる。

9. import 境界は現在機械的に守られていない。  
   `lib/cards/get-custom-session-cards.ts` が app 配下 predicate に依存し、`components/marketing/contact-form.tsx` が app action を import している。DDD 後は lint/dep rule がないと再汚染する。

10. 安全網は「unit test がある」だけでは不足。  
   大リファクタ前に、pull/mutation/review-events/upload/webhook の contract/golden tests、主要 UI smoke、import boundary test を用意しないと、behavior-preserving の判定が主観化する。

## plan ドラフトへの抜け・未考慮指摘

1. plan は payload/Dexie/entity_mutations の wire 凍結を強調しているが、error code・日本語文言・HTTP status・cache/revalidate・ops/log event を契約として扱う記述が薄い。特に upload と webhook 抽出ではここが回帰しやすい。

2. `cards` が Content と Learning の両方に属する問題への設計判断がまだ浅い。context 分割案には出ているが、同一 table / 同一 Card 型をどう split ownership するか、どの use-case がどの列を更新できるかのルールが必要。

3. repository 化の粒度が未確定。  
   `CardRepository・TagRepository = Dexie mirror + outbox を隠蔽` とあるが、Dexie mirror 更新 + outbox enqueue + flush trigger は単なる persistence ではなく application transaction。repository に隠すと同期挙動が見えなくなるリスクがある。

4. flush orchestrator generic 化は注意が必要。  
   review flush には retry controller、`pullBack` hook、session grouping、threshold flush があり、entity mutation flush とは完全同型ではない。共通化するなら Web Lock guard / result classify 程度に限定する設計判断が要る。

5. pull server-side factory 化の注意点が不足。  
   `card_tags` は created_at cursor だけでは削除を表せず、cards.updated_at bump と client 側旧 card_tags 全削除に依存している。generic factory にするとこの例外的意味論を落としやすい。

6. external service の anti-corruption layer が薄い。  
   Clerk、Stripe、Gemini、ts-fsrs は DDD 的には infrastructure adapter / domain service 境界を明確にすべき。plan は context 名として触れるが、port 化対象・失敗分類・idempotency 境界の論点が不足。

7. dead code 除去のリスク管理が不足。  
   「参照が test のみ」「常に override」は削除候補だが、export 互換・story/test helper・将来 sprint の合流を考えると、削除フェーズには public import grep と段階的 re-export 方針が必要。

8. P0 の安全網に contract snapshot が欲しい。  
   E2E/smoke だけでなく、`/api/pull` response、entity mutation envelope、review-events bulk result、upload result union、webhook state transition の golden/contract tests を先に固定するのが有効。

9. import boundary lint は「同時に導入」より段階導入が安全。  
   まず現状違反を allowlist 化し、移設ごとに allowlist を削る形にしないと、大量移動と lint failure が絡んでレビュー不能になる。

10. plan の調査基準 commit と現在 HEAD の差分確認が必要。  
   ドラフトは 2026-07-05 / develop 6592323 前提。実施計画に落とす前に、現 HEAD で再スキャンして stale 指摘を除去するべき。

## リスク / 対立しうる設計判断

1. **pragmatic DDD vs full DDD**  
   full DDD は構造は綺麗になるが、90k 行規模の local-first アプリでは repository/entity class が過剰になりやすい。既存 pure helper + use-case function + adapter seam 昇格が妥当寄り。

2. **DRY 化 vs 意味の違う同型コードの温存**  
   pull modules や flush は見た目が似ているが、cursor 意味論・retry・pull-back が違う。重複削減を優先しすぎると hidden branching の抽象になる。

3. **client pre-check の共通化 vs server authoritative validation**  
   UNIQUE/cascade/quota は client UX のための事前判定と server 真値判定の両方が必要。単一 source 化しても、client を authoritative にしてはいけない。

4. **wire 凍結 vs bounded context 整理**  
   context 境界を綺麗にすると payload や Dexie schema を変えたくなるが、今回の前提では同時 deploy 回避が優先。wire 変更系は別 sprint 判断が妥当。

5. **UI use-case 抽出 vs React 挙動維持**  
   exams UI は subscription、memo、virtualizer、debounce、unmount commit が load-bearing。抽出の正しさより、まず既存 interaction の characterization が必要。

6. **早期 lint 強制 vs 移行速度**  
   lint なしでは再汚染するが、強すぎる boundary rule を先に入れると移行が詰まる。allowlist 付き段階導入が現実的。