# tag mirror correctness sprint — 実装記録(Path C / owner による空間的分離)

- 日付: 2026-08-16
- spec(凍結): `docs/superpowers/specs/2026-08-16-tag-mirror-owner-scope-and-signout-purge-design.md`(r5)
- plan: `docs/superpowers/plans/2026-08-16-tag-mirror-correctness-sprint.md`
- 事実基盤: `docs/superpowers/sessions/2026-08-16-tag-mirror-writer-inventory-factfinding.md`(全書込点の棚卸し + Appendix A)
- 実装方式: `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 canonical review + Codex 独立 review)
- **status: 実装完了・未 push**(stg smoke 未実施)。最終 whole-branch review 収束済(§7a)

## 1. commit 一覧(実装のみ・全て `[reviewed]`)

| commit | task | 内容 |
|---|---|---|
| `84f9e82` | T1 | タグ mirror 読みの owner スコープ化(lib 層)+ mutation 入口 owner guard 4 箇所 |
| `5033348` | T2 | 同(component 層)5 component / 8 read + deps 4 site を `[userId]` 化 |
| `e4d4878` | T3 | `sync_meta` key の userId 名前空間化(基盤 + `exam_view_prefs`)+ 限定 audit test。**Critical fix 込**(`page.tsx` の `key={userId}`) |
| `4c3dac9` | T4 | pull cursor の namespace 化 + capture 原則 + **owner echo 検証** + userId 伝播一式 |
| `644931b` | T5 | `study_days` を owner 限定置換(repo 唯一の store 全消しを解消) |
| `d6f890a` | T6 | `docs/architecture.md` に不変条件 4 行 + 残余リスク行の正確化(docs・`[no-review]`) |

docs commit(`5e58420` / `dc60fb0` / `8d55818` / `877fa8b` / `fee7535`)は各 task の Codex raw findings の永続化。

## 2. sprint 完了 gate(全 exit 0 / 実測値)

| gate | 結果 |
|---|---|
| whole-repo `pnpm vitest run` | **5253 passed / 298 files**(最終 fix `092d9de` 適用後・HEAD `de66e11` の clean tree で再実測)|
| `pnpm lint --max-warnings=0` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm run audit` | exit 0(prod high/critical 0) |
| `pnpm test:iso` | **452 passed / 39 files** |
| `pnpm build` + postbuild | PASS(pdfium packaging 3 点一致) |

## 3. 設計の核(なぜこの形か)

**時間的排他 → 空間的分離への転換**。r1〜r3 は lock(bootstrap + queued lock + owner marker)で解こうとして独立レビューで 3 周連続 NO-GO になった。反例が出るたびに lock 参加者が増え続けたためで、根本原因は**時間的排他が「race 参加者の完全列挙」という完全性主張を要求する**ことにある。

方法を転換して全書込点を棚卸しした結果、**要保護対象は 2 点で閉じる**と判明した:

1. **`sync_meta`** — owner 列を持たない(cursor 6 本 + `exam_view_prefs`)
2. **`study_days` の `clear()` + `bulkPut`** — repo 唯一の store 全消し writer

棚卸しで新たに見つかった 40 件超の「直列化なし writer」は 1 件残らず「回収可能(owner 列あり)/ 無害(owner 由来 UUID 選択)/ 名前空間済(Cache API)」に落ちた。**棚卸しは保護対象集合を増やさなかった** — これが転換の根拠。

## 4. 実装で確立した性質(pin で保護されているもの)

- **capture 原則**: `pullDelta` は開始時の userId を cursor の read/write 両方に使う。「現在の user」を完了時に参照する実装形は pin が red にする(module 変数を足した変異で実証済)。
- **validate-before-tx の順序**: owner 検証は tx を開く前。**これは「FAIL が返ること」ではなく「順序そのもの」が pin されている** — canonical reviewer が「検証は残したまま `return FAIL` を tx の後ろへ移す」変異を独自に考案して実行し、owner-echo pin 8 本すべてが mirror/cursor の assertion で red になることを確認した。本 sprint で最も強い性質だが test 名からは自明でないため、ここに明記する。
- **cursor namespace**: 6 stream 全ての read/write が table-driven で pin。
- **study_days の owner 限定置換**: 異 owner 行の生存 / mixed payload の全体 reject / 検証配列と bulkPut 配列の同一性。

## 5. review の実績(この sprint で機械が実際に効いた事例)

- **Task 3 で本物の Critical を検出**。`sync_meta` の namespace 化により mount-load effect(deps `[]`)と persist effect(deps に `userId`)が非対称になり、**userId が remount なしに変わると前 user の state を新 user の key に書く**経路が生まれていた(改修前は単一 key ゆえ存在しなかった漏れ)。Codex と canonical が独立に同じ root cause に到達し、canonical は rerender 実験で再現。修正は `page.tsx` の `<ExamDetailView key={userId}>`。
- **vacuous pin の自己検出が計 3 回**(Task 3)。`waitFor` 下で空振りする pin を実装者自身が気づいて再設計した。
- **canonical が実装者未実行の変異を考案**(Task 4 の validate-before-tx、上記)。
- **red 実証の総計**: T1 6 変異 / T2 8 / T3 3+ / T4 25 / T5 6。いずれも 1 箇所ずつ個別注入。

## 6. 運用上の注意(prod 反映前に必ず読む)

1. **roll-forward が load-bearing**(spec §7a)。本改修の rollback は、旧版が **別 user 由来でありうる legacy unscoped cursor** を読み直すため、解消した cursor 汚染と under-fetch を再開させる。「over-fetch 方向で冪等だから安全」ではない。rollback する場合は**旧版が読む前に legacy unscoped cursor 6 本を削除して full pull を強制する互換 patch が必須**(patch は事前に作らない)。
2. **server のみの rollback は不可**。`/api/pull` の `owner_user_id` を戻すと、新 client は field 欠落で**全 pull を silent reject** する(mirror が更新されなくなるが UI にはエラーが出ない)。
3. **保証開始点は本 sprint 以降の bundle を実行している tab のみ**(spec §7)。deploy 前から開いたままの旧 tab は unscoped cursor 書込 / `study_days.clear()` を続けるため保証外。旧 tab による一時的な study_days 消失は新 tab の次 pull で自然回復する。
4. **rollout の一回コスト**: 全 device で新 key が不在のため、改修後の初回 pull は一度だけ full になる(+ 保存済み view prefs が一度リセットされる)。

## 7. stg smoke 手順(push 後・OT 指示で実施)

1. user A で sign-in → タグ操作 + 試験表の列表示変更(cursor / prefs を生成)
2. **IDB readback**: `cards_cursor:<A の内部 id>` が存在すること。**bare な legacy key(`cards_cursor` など userId なし)は absent でも残存でもよい** — 旧 unscoped key は設計上掃除せず残置する(物理削除は hygiene sprint)。残存していた場合は、それが **request の `since_*` に使われないこと**と **書き換えられないこと**(値が改修前のまま不変)を確認する
3. user B へ切替(OTP 424242)
4. **Network**: B の初回 `/api/pull` に **`since_*` param が 1 本も無い**(= full pull)/ 応答 top-level の `owner_user_id` が **B の内部 id**
5. **UI**: B の画面に **A のタグが出ない**(タグ管理 / カスタム演習の絞込候補 / 試験表のタグ列 / card popover)
6. **IDB**: `cards_cursor:<A>` と `cards_cursor:<B>` が**併存**し、`study_days` に A/B 両方の行が**共存**する(**A の残骸の IDB 残存は仕様** — 確認対象は「表示されないこと」)
7. **liveness の実測**: 切替直後に mirror が空に見える場合、**visibilitychange(タブを離れて戻る)/ online 相当の再 trigger で hydration されること**を確認(OT 裁定で受容した gap の実挙動確認)
8. 既知の観測ノイズ: owner 変化時の再 kick は `reason:'mount'` で記録される(通常 mount と区別できない)。`exam-status-live` が owner 変化時に spurious refresh を 1 回撃つ(非漏洩・bounded)

## 7a. 最終 whole-branch review の結果(Important 1 件を修正)

結果: **Critical 0 / Important 1 / Minor 5**。fix wave 後に scoped re-review + Codex で **全 ADDRESSED / Critical 0 / Important 0** に収束(commit `092d9de`)。

### I-1(修正済)— capture 原則が production 入口で未固定だった

`lib/sync/pull.ts` の `deps.pull ?? (() => pullDelta(deps.userId))` は **`pullDelta` の唯一の production caller**(11 箇所の `runGuardedPull` が全て通る)なのに **pin がゼロ**だった。reviewer が `pullDelta('MUTANT-WRONG-OWNER')` に変異させて whole-repo 5252 tests(**本 pin 追加前の件数** — §2 の 5253 はこの pin を足した後の値)を回し、**全 green のまま**であることを実証。

原因: `runGuardedPull` の既存 test は全て `deps.pull` を注入するため **default 分岐が一度も実行されず**、`pull-trigger.test` は `runGuardedPull` を丸ごと mock。typecheck は arity と `string` 性しか見ず「どの string か」は守らない。

**これは repo の教訓 `lesson_red_verification_cannot_find_missing_pins` の実例**。T4 で 25 変異を注入して全件 red を確認したが、**その 25 件は全て `pullDelta` の内部に着弾し caller には 1 件も無かった** — 「他でカバー済み」と信じた要求に pin 漏れが集中する、という当の失敗形。task 単位 review 3 回(canonical + Codex + CC 本体)を通過してもなお残り、**whole-branch review で初めて発見された**。

修正 = pin 1 本追加。`deps.pull` を注入せず `defaultClient`(global fetch)経由で走らせ、read 側(B の namespace に cursor 無し → 素の `/api/pull`)と write 側(B の namespace に着地・A の値は不変)の両方を固定。red は 2 変異で実証(`'MUTANT-WRONG-OWNER'` → write 側が捕捉 / 実在する別 owner `'user-1'` → read 側が捕捉)。CC 本体と re-reviewer が独立に再現。

### Minor の triage

| # | 内容 | 判定 |
|---|---|---|
| M-a | `study_days` の空 payload で行検証が vacuous(異 session の空応答が自 owner 行を削除)| **OT 裁定へ**(§7b)|
| M-b | `category-list.tsx` / `option-list.tsx` の header コメントが実装と矛盾 | **修正済**(`092d9de`)|
| M-e | `page.test.ts` の pin が source-text マッチである旨の注記 | **修正済**(`092d9de`)|
| M-c | `option-list.tsx:123` だけ owner 無スコープ(§3.3 裁定下で挙動は正しいが、他 3 component の pin が assert する状態と surface が不一致)| 記録のみ → hygiene sprint |
| M-d | `exam-detail-pull-gate` に userId 変化 pin なし | 記録のみ(非漏洩)|
| 既存 deferred 6 件 | Task 1〜4 で記録した minor | **全て「後続で良い」**と triage |

**reviewer が明示的に否定した案**: 「`exam-status-live` にも Task 3 と同じ `key` を付ける」— `<ExamStatusProvider>` は `/app` subtree 全体を包むため `key={user.id}` は `PullTrigger`・全 flush trigger・children を remount させ、`ExamDetailView` とは blast radius が桁違い。**同型に見える修正を反射的に適用してはいけない**。独自の判断を要する。

同じく triage で覆った認識: `git ls-files` ベースの audit は **index を読むので `git add` 済み file は対象内**。盲点は「一度も stage されていない file」だけで、それは定義上 commit もできない。`architecture.md` の限界記述は**安全側に保守的**。

## 7b. 既知の correctness hardening(OT 裁定済 = deferred 採用)

**分類**: hygiene sprint の中の **correctness follow-up** であり、単なる衛生項目ではない。**hygiene sprint の先頭タスクに固定**する。本 sprint では deferred(OT 承認済)。

**`study_days` の空 payload で owner 行検証が vacuous になる**(`lib/sync/study-days.ts` の `studyDays.some(row => row.user_id !== userId)` は `[]` に対して `false`)。

- 具体例: tab が A として render 済 → `pullAllStudyDays(A)` 発火 → session は既に B → server は B の snapshot を返す → **B の study_days が 0 件なら `{studyDays: []}`** → 検証を素通り → `where('user_id').equals(A).delete()` で **A のローカル行が消える**。`/api/study-days/pull` の sign-up race `emptyBody: { studyDays: [] }` も同型。
- **severity は Minor**: 異 owner データの露出は無い(非空の異 owner payload は正しく reject される)、失うのは再 pull 可能な server mirror、改修前の `clear()` は厳密により多くを壊していた。本 sprint の保証を弱めない。
- **ただし spec §5.1a の根拠が不正確**: 「study_days は owner echo 不要 … §6 の全行 `user_id` 検証で完結する」と書いたが、**`/api/pull` に echo を導入した理由(行検証だけでは空 payload を検証できない)と同じ class の穴**を、もう一方の endpoint に持ち越していなかった。
- **spec は凍結ゆえ本 sprint では patch しない**。**裁定(OT 承認済)= deferred 採用**。対応は hygiene sprint の**先頭タスク**として `/api/study-days/pull` にも `owner_user_id` echo を追加し、`/api/pull` と同じ「echo + 行検証」の 2 段にそろえる(空 payload / 全行が owner を持たない応答を echo が単独で捕まえる形)。
- 併せて hygiene sprint 側の spec で **§5.1a の「study_days は owner echo 不要」という根拠の訂正**を明記する(本 doc がその訂正の正記録)。

## 8. 後続へ

- **hygiene sprint**(別 spec)の入力:
  1. **先頭タスク(correctness follow-up・§7b)**: `/api/study-days/pull` への `owner_user_id` echo 追加 + spec §5.1a の根拠訂正。衛生項目より先に置く。
  2. sign-out purge / 異 owner sweep / Cache API cleanup
  3. **旧 key(userId なし)と旧 `exam_view_prefs` の物理削除**(それまでは残置が正 — smoke でも absent / 残存どちらも許容。§7 手順 2)
  4. outbox synced 削除
  5. §7a の M-c(`option-list.tsx:123` の scope 非対称)
  
  本 sprint の非スコープ列挙(spec §2)も併せて入力とする。
- **pending / failed outbox の at-rest 残置**と flush-before-signout は別裁定(claude.ai todo)。
- deferred minor の triage 結果は §7a に記録済(ledger は scratch のため破棄)。

## 9. 実行中に下した裁定(ruling)一覧

| # | 裁定 | 理由 | 誤っていた場合のコスト |
|---|---|---|---|
| 1 | 実装 subagent には **commit させず**、CC 本体が review pass 後に commit | CLAUDE.md「review pass → commit の一方向のみ」が SDD 既定(implementer が commit)と衝突。project 規律を優先 | review package を commit range でなく working tree diff から生成する手間 |
| 2 | task review は SDD の template でなく **CLAUDE.md の canonical 経路**(`code-reviewer.md` 文言 + general-purpose subagent)で回す | user instruction は skill に優先。SDD が要求する 2 verdict は canonical template で満たされる | SDD 固有の re-review 様式と少しズレる |
| 3 | Codex と canonical の **並列起動をやめ逐次化** | canonical は pin 検証で変異注入を行い、その間に Codex の git clean detector が走ると **read-only 違反の偽陽性**(T3 fix1 で実際に発生)。CLAUDE.md が並列を許すのは anchor 防止が目的で、逐次でも Codex に canonical の結論を見せなければ目的は満たされる | review 1 周あたりの wall-clock が伸びる(Codex は 1-2 分で影響小) |
| 4 | T3 Critical の修正は **`key={userId}`**(reviewer 提示の選択肢 1)を採用 | state と ref を**列挙せず構造的に**全リセットできる。選択肢 2(手動リセット)は「リセット対象の列挙」に依存し、r1〜r3 で繰り返し破綻した完全性主張と同型 | アカウント切替時に in-flight な UI state が破棄されるが、切替時はそれが望ましい |
| 5 | Codex T4 の P1 を **park** | OT が plan 段階で明示裁定した liveness 受容事項と範囲が完全一致。Codex の対策案は Path C 転換時に撤回した bootstrap + queued lock 機構そのもの。correctness は毀損しない(旧 pull は owner echo で reject) | 切替直後に mirror が空に見える窓が残るが、次 trigger で回復し smoke で実測 |
| 6 | 最終 review の **I-1 は fix / M-b・M-e は同 dispatch で同梱 / M-a は OT 裁定へ / M-c・M-d は記録のみ** | I-1 は sprint 中心的主張の未固定で最優先。M-a は spec 凍結事項ゆえ独断で patch しない。M-c・M-d は §3.3 裁定下で挙動が正しく scope 拡大に見合わない | M-a を放置した場合、異 session の空応答で自 owner の study_days が消える窓が残る(再 pull で回復) |

---

## 10. stg smoke 実施結果(2026-08-16・**PARTIAL PASS / 中核未実施**)

- 環境: `https://stg.recallmint.nekotest.net`(deploy 反映済)/ Playwright MCP
- user A = `komail9server+clerk_test@gmail.com` → **内部 id `66fb6d00-526f-4264-9691-e2e036c656f7`**(cards 1209 / exams 4 / tag_categories 4 / tag_options 19 / study_days 2)
- **総合判定: 実施できた 10 項目は全て PASS。ただし中核の A→B 切替は credential 不足で未実施**(§10.3)。

### 10.1 PASS した項目(実測値付き)

| # | 確認項目 | 結果 |
|---|---|---|
| 1 | namespace key の生成 | テーブル表示に切替(user 操作)→ `exam_view_prefs:66fb6d00-…` が **新規作成**(`{"version":4,"view":"table",…}`)。同時に bare `exam_view_prefs` は **`{"version":3,"view":"card",…}` のまま不変** |
| 2 | bare legacy key と scoped key の併存 | cursor 6 本すべてで併存を確認(`cards_cursor` と `cards_cursor:66fb6d00-…` 等)|
| 3 | **legacy key が `since_*` に使われない** | scoped cursor 6 本のみ削除(bare は残置)→ reload → **`GET /api/pull`(query string なし)** = full pull。bare `cards_cursor` は `2026-08-16T12:19:12.611Z` を保持していたのに **since_\* は 1 本も送られていない** |
| 4 | **legacy key が書き換えられない** | 上記 full pull 後に bare 7 key を baseline と byte 比較 → **drift 0**(`BARE_KEYS_UNCHANGED: true`)|
| 5 | scoped cursor の再生成 | full pull 後に scoped cursor が **6/6 再生成** |
| 6 | **`owner_user_id` echo** | `/api/pull` 応答 top-level に `owner_user_id` が存在し、値は **`66fb6d00-…` = 認証主体の内部 id と一致**。top-level keys = `[owner_user_id, cards, exams, tombstones, tag_categories, tag_options, card_tags, cursors]` |
| 7 | scoped 値からの増分 pull | 再生成後の pull は `?since_cards=2026-08-16T12%3A19%3A12.611Z&…` の 6 本を送る(= scoped 値が read 元)|
| 8 | **liveness 再 trigger** | `visibilitychange`(hidden→visible)で pull 1 本、`online` でさらに 1 本発火(累計 2→3→4)。OT 裁定で受容した gap の回復経路が実挙動で成立 |
| 9 | sign-out 後の残骸 | sign-out 直後も cards 1209 / tag_categories 4 / cursor 全 key が残存 = **purge 不在の仕様どおり**(hygiene sprint 範囲)|
| 10 | `/api/study-days/pull` の owner echo 不在 | 応答 top-level keys = `["studyDays"]` のみで **`owner_user_id` を持たない** → §7b の既知 correctness hardening 項目を実測で裏付け |

**#3 が本 smoke で最も強い証拠**: bare legacy key が存在する状態で scoped だけを消すと `since_*` がゼロになる。もし legacy が read 元なら since が乗るはずで、乗らなかった以上 **read 元は scoped のみ**と結論できる。

### 10.2 実測の生出力(抜粋)

full pull 直前の IDB(scoped cursor 削除後・bare 残置):
```
remaining_keys: [card_tags_cursor, cards_cursor, exam_view_prefs,
                 exam_view_prefs:66fb6d00-…, exams_cursor,
                 tag_categories_cursor, tag_options_cursor, tombstone_cursor]
```
Network(reload 直後):
```
30. [GET] /api/study-days/pull => [200]
31. [GET] /api/pull            => [200]     ← query string なし = full pull
```
再 trigger 後の URL 履歴:
```
/api/pull
/api/pull
/api/pull?since_cards=2026-08-16T12%3A19%3A12.611Z&since_exams=…&since_tombstone=…
          &since_tag_categories=…&since_tag_options=…&since_card_tags=…
/api/pull?since_… (同上)
```
bare key の baseline 比較: `BARE_KEYS_UNCHANGED: true` / `drift: []`

### 10.3 未実施(**blocker**): A→B 切替の中核 4 項目

**原因**: 提供された credential が **1 アカウント分のみ**。`komail9server+clerk_test@gmail.com` / password `komail8server` / OTP 424242 は全て **user A** のもので、2 つ目のアカウントが無い。`komail8server+clerk_test@gmail.com` で sign-in を試行したが **"Couldn't find your account."**(存在しない)。Clerk sign-up は Turnstile で自動化不能のため **CC 側でアカウント B を作成できない**。

未実施項目:

1. B の初回 pull の **`owner_user_id === B の内部 id`**(A については実測済 = #6)
2. `cards_cursor:<A>` と `cards_cursor:<B>` の**併存**
3. `study_days` に **A/B 両方の行が共存**
4. **A のデータが B の UI のどこにも出ない**(タグ管理 / カスタム演習の絞込候補 / 試験表のタグ列 / dashboard)← **本 sprint の中心的主張**

なお 1〜3 の機構は §10.1 #1〜#7 で「namespace が owner ごとに分離し、他 owner の key を読まない」ことまで実証できている。**残る未検証は「実際に別 owner が sign-in したときの end-to-end の表示分離」**で、これは unit pin(`lib/sync/pull.test.ts` / 各 component の owner-scope pin)では green だが実機では未確認。

### 10.4 smoke で生じた副作用(記録)

- user A の `exam_view_prefs:<A>` が `view: "table"` / `hiddenColumns: ["question_label"]` に変わった(手順 1 の操作そのもの)。無害・UI から戻せる。
- A の scoped cursor を一度削除したため full pull が 1 回走った(1209 cards 再取得)。cursor は再生成済で定常状態に復帰。
