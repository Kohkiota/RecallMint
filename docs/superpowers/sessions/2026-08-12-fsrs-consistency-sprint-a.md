# FSRS 整合 Sprint A — 実施記録(2026-08-11〜12)

- **spec(凍結・r5)**: `docs/superpowers/specs/2026-08-11-fsrs-consistency-sprint-a-design.md`
- **plan**: `docs/superpowers/plans/2026-08-11-fsrs-consistency-sprint-a.md`
- **fact-finding 3 本**: `docs/audit/2026-08-11-fsrs-consistency-factfinding.md`(第 1 弾)/ `2026-08-11-review-domain-schema-inventory.md`(第 2 弾)/ `2026-08-11-db-schema-full-inventory.md`(第 3 弾)。commit `1906c71`
- **Codex raw**: `docs/codex/2026-08-11-plan-fsrs-sprint-a-{spec,plan}.md`(plan 段階 cross-check)+ `docs/codex/2026-08-1{1,2}-fsrs-t*.md`(task review 6 本)
- **stg 適用 runbook**: `docs/ops/fsrs-sprint-a-stg-migration-runbook.md`
- 状態: **実装完了・未 push**(OT の push 判断待ち)。stg smoke 未実施

## 1. 何を作ったか

復習イベントの正本を **`answer_events` 1 表**に一本化し、同一 card への FSRS 適用を DB 行ロックで直列化、時系列を逆行する event を順序ガードで隔離した。`reviews` / `study_sessions` は表ごと廃止(23 表構成)。

| commit | 内容 | canonical | Codex |
|---|---|---|---|
| `1906c71` | fact-finding 3 本 | — | — |
| `2799b21` | spec r2(Codex cross-check 反映・OT 承認待ち)+ Codex 論点保存 | — | 1 パス |
| `cbb5435` | spec r3 確定(OT 条件付き承認 3 点 + 付随 2 点) | — | — |
| `31ededf` | plan(Codex plan cross-check 反映済み) | — | 1 パス |
| `8431634` | spec **r4 amend**(study_days の day 行ロック / tx throw の分類) | — | — |
| `0596807` | **T1** answer_events wire schema(rating 必須)+ `jstDayRange` 共有 pure module | C0 / I0 / M1 | 指摘なし |
| `5fcb7cb` | **T2** 初期 FSRS 状態を pure 関数 1 定義へ(now 注入) | C0 / I0 / M3 | 指摘なし |
| `0fdb72a` | spec **r5 amend** + fact-finding 第 2 弾に訂正注記(§4 参照) | — | — |
| `beddcbe` | **T3** cards の FSRS 列を double precision 化 + `state` CHECK + DB default 撤去(migration 0034) | C0 / **I2** / M7 → fix 1 周で all addressed | 指摘なし |
| `52a906c` | **T4** server 全置換(answer_events 新形 + ingest 9 手順 + 退会 Group I 移動 + RLS 配線・migration 0035) | C0 / I0 / M5 Approved | **P1×2 + P2×1 → 全て非欠陥裁定**(§5) |
| `a9108c2` | **T5** client 全置換(Dexie v9 drop → v10 再作成 / flush 一本化 / 24h drop 撤去 / elapsed 計測) | C0 / I0 / M9 | 指摘なし |
| `b3bce91` | **T6** iso 新設(2 接続同時実行 helper + 26 pin)+ study_days ロック postcondition | C0 / **I1** / M9 → fix 1 周で all addressed | 指摘なし |

**未解決の Critical / Important はゼロ**(Important 3 件はいずれも同 task 内の fix round で解消)。

## 2. 設計の芯(実装から読めない裁定)

### 2.1 学習履歴を card から user へ移した

`answer_events.card_id` の **FK を撤去**し dangling を正規状態にした。従来の `ON DELETE CASCADE` は「card を消したら回答履歴も消す」形で、これは **学習実績を card の寿命に従属させていた**。`study_days.distinct_card_count` が card 削除で縮む自己矛盾(第 2 弾 §6-6)も同じ根から出ていた。

帰結として **users CASCADE も効かない**(退会は soft-delete なので発火しない)ため、退会時の実削除は **Group I(handler 明示 DELETE)へ移動**した。architecture §2 / §4 に反映済み。**cascade 設計を意図的に override した唯一の表**であることを台帳に明記した。

### 2.2 「正本」の意味を保証 2 点に限定した(spec §0)

`answer_events` が保証するのは **① 入力の監査可能性** と **② 現行コードによる再計算可能性** の 2 点だけで、**cards の bit-exact な過去再現(決定的 rebuild)は保証しない**。崩れる要因は同時刻 event の適用順だけでなく **ts-fsrs の版・パラメータ**を含むため、同時刻が絡まない普通の履歴でもコード更新で再現不能になる。この限定の上で ReviewLog スナップショット不採用が成立する。rebuild コマンドは非スコープ。

### 2.3 ロック順序を全 tx 共通規約にした(r4)

card 行ロックは**同一 card しか直列化しない**。同一 user・**異なる card**・同一 JST day の 2 flush が並走すると、双方が相手の未 commit event を含まない集計値を作り `study_days` を後勝ちで上書きする — **full 再集計にしても消えない別種の lost update**。r3 の「絶対値だから加算競合が消える」はこのケースで偽だった。

対策として再集計の前に対象 day 行を確保 + `FOR UPDATE` する。2 種のロックを同一 tx で取ることになったので、**`cards`(ID 昇順)→ `study_days`(day 昇順)** を全 tx 共通規約として固定した(architecture §8)。

### 2.4 終端を 2 つに絞った(24h drop 全撤去)

旧実装は「分類は permanent・挙動は無限再送」の不整合を持っていた(`classifyFlushResults` が 'permanent' に分類する一方、行は pending のまま残り毎 trigger 再送)。加えて 24h 超の pending を**黙って捨てて**いた。

新設計では終端 = **synced(200 受理)** か **failed(送信前検証の形式不正 / 応答 `failed[]` の衝突)** の 2 つだけ。時間ベースの drop は無い。残る pending が transient だけになるので、残置しても配送保証を損なわない。

## 3. spec が 3 回 amend された経緯

spec は「凍結して実装中に書き換えない」規律だが、本 sprint は **確定前に 2 回・確定後に 1 回**の amend を経ている。3 回とも性質が違うので分けて記録する。

### r3(2026-08-11・**OT 条件付き承認**)

r2 を OT が条件付き承認し、条件として 3 点の修正 + 付随 2 点を要求した:

- **(i) 再送の内容一致検証**を §2.2 手順 4 に追加。`event_id` の所有権検証だけでは「自分の既存 event_id に別内容を被せる」再送を検出できなかった。比較基準は **`min(再送 raw answered_at, 既存行 created_at)`** — 初回に clamp された event の再送が受信時刻の差で偽陽性 mismatch になる罠を避けるため。
- **(ii) `failed[]` の terminal 化**。r2 は「failed[] を受けても pending 維持」としていたが、所有権・内容不一致は再送で永久に解消しないため、**「残る pending は transient のみ」という設計主張自体が偽になっていた**。
- **(iii) study_days の集計 SQL を VALUES CTE + JOIN + GROUP BY に確定**。r2 の `day_bucket` GROUP BY は `AT TIME ZONE` 全廃方針の下で成立せず、min〜max の連続 range は「event 数で bound」の主張を崩す誤りだった。

### r4(2026-08-11・**plan 段階の Codex cross-check 由来**)

plan ドラフト確定**前**に `codex-plan-review.sh` を 1 パス回し、2 点が真の指摘として通った:

- **study_days の cross-card lost update**(Codex plan 独立 1)= §2.3。**r3 の設計が偽である場所を突いた**もので、plan を CC 単独で固めていたら実装後に出ていた。plan 段階 cross-check の投資が回収された実例。
- **tx throw の分類**(Codex plan 独立 9)。一律 503 は permanent な実装/データ欠陥まで client に永久再送させる。`classifyBulkError` で transient→503+Retry-After / permanent-4xx→400 に分岐する形へ修正。

### r5(2026-08-11・**実装中に fact-finding の事実誤認が発覚**)

**T2 の実装中に、spec §7.2「streak の二重実装を解消する」の前提が偽だと判明した**。詳細は §4。凍結 spec を実装中に書き換えることになるため、停止して OT 裁定を仰ぎ、**§7.2 を撤回**(streak には一切触れない)+ §0 の「二重実装」列挙から streak を除外、という形で amend した。T2 で既に書いた移設は revert した。

## 4. fact-finding 第 2 弾の「streak 二重実装」は誤りだった

**主張**: 第 2 弾 §2.8 / §6-12 が「streak 計算が server(`lib/db/streak.ts`)と client(`lib/client/streak.ts`)で二重実装されている」と判定し、spec r1〜r4 がそれを「解消すべき二重実装」として引き継いだ。

**事実**: `computeStreak` / `addDays` は既に `lib/streak-core.ts` に hoist 済み(commit `c79b1af`「computeStreak+addDays を lib/streak-core.ts へ hoist(P1 Task2)」)で、**server(`lib/db/streak.ts:3`)・client(`lib/client/streak.ts:16`)の両方がそこから import している = 1 定義は既に成立していた**。

**誤りの出所**: fact-finding が `dashboard-stats.tsx` の **stale なコメント**(「同仕様で port した」)だけを根拠に二重実装と判定し、**import 現物を確認しなかった**。コメントは hoist 前の状態を説明したまま更新されていなかった。

**教訓(既存の恒久教訓の再演)**: `feedback_verify_external_review_against_repo` / `lesson_single_point_claims_decay` と同型。**コード内の自然言語(コメント・doc)は「そう書いてある」以上の証拠にならない**。「二重実装がある」「単一点である」の類の**構造に関する主張は、import / 呼出の現物を辿るまで未検証**として扱う。fact-finding は現物確認の場であって、コメントの転記の場ではない。

**波及**: 第 2 弾 doc の冒頭に訂正注記を入れた(`0fdb72a`)。**§5 の JST day 導出の 1 定義化(JS `todayInJst` vs SQL `AT TIME ZONE` の 2 実装)は現物確認済みで有効**であり、スコープに残った — 同じ doc 内の別主張を巻き添えで疑わない。

## 5. Codex が T4 で挙げた Critical 3 件の裁定(いずれも非欠陥・修正不要)

`docs/codex/2026-08-12-fsrs-t4-server-replacement.md`。canonical(C0/I0/M5 Approved)と食い違ったため、1 件ずつ現物で裁定した。

| # | Codex の指摘 | 裁定 | 根拠 |
|---|---|---|---|
| P1#1 | migration 0035 が既存 review データを破棄する | **非欠陥**(承認済みの決定) | **spec §10 で OT 承認済み**(ユーザー 0・stg/prod とも実データ保護不要・互換レイヤーと backfill なしでクリーン形へ直行)。**Codex は spec を参照しない設計**(独立に diff を見させる anchor 防止のため)なので、この前提を知り得ない。**Codex の「知らないことによる誤検出」は構造的に発生する**ので、severity ではなく前提の有無で裁定する |
| P1#2 | rating を持たない legacy pending event が 400 で拒否される | **前提が偽** | 現 client の **production caller は `runSubmit(rating: Rating)` 1 つだけ**で、常に rating を明示送信する(`session-runner.tsx:253,297`)。`rating?:` optional と `:313` の条件 spread は**未使用の防御残骸**。加えて users 0 + T5 の Dexie v9 store 破棄で旧 pending は端末側からも消える |
| P2#3 | event の `session_id` が NULL になる | **T4/T5 の意図的分割による過渡状態** | plan の Global Constraints「T4→T5 間は wire 不整合・中間 deploy しない」。T5(`a9108c2`)で client が session_id を載せて解消。**Codex は task 単位で diff を見るため、複数 task に跨る意図的な過渡状態を欠陥と読む** |

**この 3 件から得た運用知見**: Codex に spec を見せない設計(anchor 防止)は独立性と引き換えに「承認済みの決定」「意図的な過渡状態」を欠陥として上げてくる。**裁定コストは仕様上の想定内**であり、severity を下げる交渉ではなく **前提の真偽**で判断する。

## 6. 実測と red 検証(repo に残らないものはここが唯一の手順書)

### 6.1 1000 event flush = **110ms**

```
[perf] 1000 event flush: 110ms (cards=10, days=3)
```

- 構成: 1000 event / 10 card / JST 3 day 跨ぎ、全件 applied。計測は `processAnswerEvents` 呼び出しのみ(seed / 観測 read を含まない)。
- **gate にしない**(spec §5 の指示どおり log 出力のみ)。**devcontainer 常駐 PG17 / localhost の値**であり、Vercel ↔ Supabase の往復がある本番の値ではない。

### 6.2 red 検証の変異注入位置

**変異は working tree 上でのみ行い repo に残していない**ため、同じ red を再現する人にとって本節が唯一の手順書になる。backup は `scratchpad/red-backup/` に取り md5 一致で復元を確認した。

方針 = **gate を個別に変異させる**(まとめて壊すと、1 つ落ちても他が pin されている証明にならない — `feedback_mutate_gates_individually_in_red_verification`)。

**並行系 2 種は `pg_sleep` の注入で race を決定化した**。これが本節の核心で、注入位置が要点:

| # | 注入位置 | 目的 |
|---|---|---|
| M1-control | `processAnswerEvents` の **card ロック直後**に `SELECT pg_sleep(0.3)` を注入(`FOR UPDATE` は残す) | 遅延を入れても直列化 pin が緑であること = ロックが効いている側の control |
| M1 | 上記 + `lockCardReplayStates` の `.for('update')` 削除 | `直列化 … reps=2` のみ fail(`expected 1 to be 2`)= lost update の実演 |
| M2-control | `recomputeStudyDays` の **再集計 UPDATE 直後**に `pg_sleep(0.3)` を注入(day の `FOR UPDATE` は残す) | cross-card pin が緑であることの control |
| M2 | 上記 + study_days の `.for('update')` 削除 | `cross-card 同一 day 競合` のみ fail |

control を必ず対で走らせているのは、**`pg_sleep` 自体が test を落としていない**ことを示すため(遅延で落ちたのか lock 欠損で落ちたのかを分離する)。

順序系・冪等系は sleep 不要で決定的に落ちる:

| # | 変異 | 結果 |
|---|---|---|
| M3 | `foldSession` の順序ガード条件を `if (false)`(常に適用) | 順序ガード (a)(c) が fail。(b)(d)(e) は緑 = reject 経路を見ていない pin であることの範囲確認も同時に得られる |
| M4 | clamp 撤去(`answeredAt` を raw に) | clamp pin + 衝突(c')が fail。**落ち方は CHECK 違反(23514)による INSERT reject** = DB CHECK が backstop として効いていることも同時に観測 |
| M5 | 所有権検証撤去 | 衝突 (a) 他 user の既存 event_id のみ fail |
| M6 | 内容一致検証撤去(`matchesExisting` 冒頭 `return true`) | 衝突 (b) 自 user・内容不一致のみ fail |
| M7 | `recomputeStudyDays` の postcondition throw ブロック削除 | iso 1 + unit 2 が fail |
| M8 | ロック順序の入れ替え(day 再集計を card ロックの**前**へ移す・ロック回数は 1/1 のまま) | 新 sequence pin が fail。**同 file の `cardLockCalls=1` / `studyDaysLockCalls=1` を見る既存 test は緑のまま通過** = 従来のカウンタ pin では順序を検出できなかったことの実証 |

### 6.3 cross-card test の設計上の罠(実測で設計を変えた)

`cross-card 同一 day 競合` は **day 行を先に作ってから** 2 flush する。行が無い状態だと 2 本目の `INSERT … ON CONFLICT DO NOTHING` が 1 本目の未 commit tuple を待って**偶然直列化してしまい**、day ロックを外しても緑になる(= red が成立しない)。

一方で **day 行未生成の 2 並走こそが本番の主経路**なので、それも別 case として追加した。ただしそれを守っているのは day の `FOR UPDATE` ではなく `INSERT … ON CONFLICT DO NOTHING` の speculative insertion 待ちであり、**手順 1 の INSERT を集計の後ろへ移す refactor で消える**。この分析は推論で終わらせず変異 A / B で実測して裏取りした(T6 report の fix 4)。

## 7. spec 本文とコードが矛盾している箇所(spec は凍結ゆえここに記録)

### 7.1 spec §9.1-1 の barrier は実装で撤回された

spec §9.1-1 は flake 対策として「両接続が同一 snapshot を読んだことを **barrier(advisory lock 等の DB 側同期)** で保証してから解放する構成」を要求している。**実装はこれを採っていない**。

理由: **`FOR UPDATE` 下で「SELECT 完了同期」の barrier を置くと deadlock する**(先にロックを取った tx が barrier で待ち、後続は行ロックで待つ)。plan 段階で既に撤回されていたが、spec は凍結済みで書き換えていない。

代わりに採った形 = **2 event を同一 `answered_at` にする**。順序ガードが `>=` なのでどちらが先に直列化されても両方適用され、**交錯順に依存しない assertion** になる。barrier は行ロックを取らない `pg_backend_pid()` probe(test 0 = 2 接続が別 backend であることの実測)にだけ置き、5s timeout を持たせて serialize 時に無限 hang でなく loud fail させている。

### 7.2 spec §2.1 の 400 分岐は現状**到達不能**

`classifyBulkError` は DB 側の permanent エラー(CHECK 違反等)を 400 に落とす分類を持たず、**すべて transient default(503 + Retry-After)に倒れる**。したがって spec §2.1 が定義する「permanent-4xx → 400」の分岐は、tx throw 経路からは現状到達しない(zod parse 由来の 400 は別経路で生きている)。

実害は限定的(ユーザー 0・CHECK 違反は実装欠陥であり修正すれば消える)だが、**「permanent なバグを client に永久再送させない」という r4 の設計意図は現状コードでは未達**。修正するなら `classifyBulkError` に SQLSTATE 23xxx の permanent 分類を足す。→ follow-up。

### 7.3 Dexie の version は spec の呼称「v9」ではなく **v10 が最終**

spec §4.1 は「Dexie v9 で store 再作成」と書くが、実装は **v9 で `answer_events: null`(drop)→ v10 で再作成**の 2 version に分割した。単一 version 内で「同名 store を drop して作り直す」は Dexie の宣言的 schema では表現できないため。代替案の「v9 単発 + `.upgrade(tx => tx.table('answer_events').clear())`」は store 定義を残したまま中身だけ消す形で、index 定義の変更が反映されない。

### 7.4 spec §4.1 の `event_id` index は非-unique、実装は unique(`&event_id`)

spec §4.1 は v10 の index を `'++local_id, event_id, [user_id+sync_status]'`(非-unique)と書くが、実装(`lib/client-db.ts` v10)は `'++local_id, &event_id, [user_id+sync_status]'` と `&` を付けて unique にしている。**強化方向なので採用**(挙動を弱める逸脱ではない): 同一 `event_id` の二重 `add` が `ConstraintError` で loud に落ちるようになり、冪等キーの一意性が store 側でも構造的に保証される。spec の非-unique 指定は誤りではなく単に厳格化されていない状態だったため、書き換えず本記録のみ残す。

## 8. PG bump 担当への申し送り

`tests/integration/pg/answer-events-serialization.test.ts` の **schema contract readback は CHECK / PK / FK の定義文を PG17.10 の正規化テキストで直書き pin している**:

```
answer_events_answered_at_le_created_at | CHECK ((answered_at <= created_at))
answer_events_elapsed_ms_nonneg         | CHECK (((elapsed_ms IS NULL) OR (elapsed_ms >= 0)))
answer_events_pkey                      | PRIMARY KEY (event_id)
answer_events_rating_range              | CHECK (((rating >= 1) AND (rating <= 4)))
answer_events_user_id_users_id_fk       | FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
```

**PG を bump すると `pg_get_constraintdef` の出力書式が変わって red になりうる**。これは**意図的な pin**(名前を保ったまま述語だけ緩む書き換え — 例 `CHECK (rating <= 4)` — を検出するのが目的)なので、red が出たら「pin を消す」のではなく **新版の正規化テキストへ更新する**こと。

同 file は `pg_constraint` の取得を `contype IN ('p','f','c')` で絞ってある(PG18 が NOT NULL を `contype='n'` で記録しても偽 red にならないようにするため)が、**定義文書式の変化はこの絞りでは防げない**。`rls-drift.test.ts` の `TENANT_PRED` 等の正規化述語 pin も同じ性質を持つ(既知)。

## 9. gate(T7 実走・2026-08-12。**最終 HEAD `5e22faf` で全項目を再実走し同結果を確認済**)

> 下表は T7(`feb2d0c`)時点の実走。その後の最終 fix wave(`5e22faf`・comment/doc のみ)後に **controller が全 gate を再実走**し、すべて同じ結果(lint / typecheck / audit / frozen-lockfile 各 exit 0、unit 278 files 4733 passed、iso 32 files 351 passed、build exit 0)であることを確認した。したがって本表は最終 HEAD の実態と一致する。


| gate | 結果 |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm lint`(whole-repo `--max-warnings=0`) | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test`(全 unit) | **278 files / 4733 passed** |
| `pnpm test:iso` | **32 files / 351 passed**(新規 26 test 込み) |
| `pnpm run audit` | exit 0(prod high/critical 0 / dev は allowlist 受容) |
| `pnpm build` + postbuild pdfium packaging 検証 | exit 0 / PASS |
| `pnpm db:generate` no-diff(T4 時点) | `No schema changes, nothing to migrate` |

## 10. docs 波及(T7)

| file | 変更 |
|---|---|
| `docs/architecture.md` | §1 に review-events flush の形と終端 2 値の行を追加 / §2 cascade 用語分離に「answer_events は Group II から外れた」段落 / §4 Group I 行 / §8 にロック順序規約と正誤 2 本立て / 証明の空白 3 件(1 件更新・2 件追加) |
| `docs/02-tech-spec.md` | 13 節の冒頭に「本節は歴史記述」注記 1 行(§2.1 / §2.2 / §2.3.4 / §2.5.2 / §2.5.4 / §2.8 / §2.10 / Server Actions / §4 / Logic 3 / Logic 6 / §13.14 / §14 全体)。**節の中身は書き換えていない** |
| `docs/ops/fsrs-sprint-a-stg-migration-runbook.md` | **新規**。0034 の後方非互換 / 0035 の policy+grant 同時消失 / 適用前の `state` 確認 / v8 IDB upgrade smoke |
| `docs/ops/rls-p2-stg-runbook.md` | §10 に追随注記(Wave 1 は 8→7 表)/ §12.2 の期待カタログを 19→17 表に訂正 |
| `README.md` | ドメイン表 list から `reviews` / `study_sessions` 削除 + 1 行補足 / ER 図の `reviews` → `answer_events` / contract golden test の件数 77→70(実測) |
| `tests/integration/pg/COVERAGE.md` | 末尾に追随記録 1 節(過去 wave の監査証跡は書き換えない) |

**COVERAGE.md の位置づけ判断(T6 引き継ぎ)**: 同 doc は表題どおり **RLS テナント隔離の棚卸しに特化**しており、iso 全 file の一覧ではない。`answer-events-serialization.test.ts` の主題は直列化と順序で隔離ではないため経路分類表には足さず、**RLS 面の pin(policy / grant の readback)だけを追随記録から辿れる**形にした。「iso 一覧」へ格上げする案は採らない — 目的が違う 2 つの台帳を 1 file に同居させると、どちらの完全性も主張できなくなる。

## 11. follow-up(claude.ai の todo へ渡す)

1. **`classifyBulkError` に permanent 分類が無い**(§7.2)。spec §2.1 の 400 分岐が到達不能で、r4 の「permanent を永久再送させない」意図が未達。SQLSTATE 23xxx を permanent-4xx に落とす。
2. **v8→v10 の実 IDB upgrade path が自動 test で未通過**(architecture 証明の空白に新規追加)。stg smoke で人手確認する形しか無い。恒久化するなら Playwright + 実 IndexedDB で v8 schema を作ってから開く test。
3. **`FlushResult` の `sessionSynced` / `reachable` / `attempted` が死に field**(T5 M-1)。entity 側と共有 shape ゆえ T5 の範囲外だった。
4. **entity_mutations outbox の owner-scope 化**(spec §11 で Sprint B 候補)。review 側と同型の穴。
5. **死列 / 死表 / 死 index の一掃 + CHECK の全表展開**(第 3 弾 §9 → Sprint B)。
6. **同時刻 cross-request の適用順は非決定のまま**(spec §2.4 が明示受容)。pin していない(できない)。
7. **性能値 110ms はローカル PG のみ**。本番の往復コストは未測定。gate 化はしない前提。

## 12. 次の 2 段(brief の完了定義)

1. **本 checkpoint = 実装完了**。Sprint 境界で停止し OT が push。
2. push + stg deploy 後、OT 指示で CC が **stg smoke**(`docs/ops/fsrs-sprint-a-stg-migration-runbook.md` §4)+ RLS 実効検証を実走し、PASS で **sprint close**。

**DB 適用は smoke の前**。順序は runbook §2(code deploy → migrate → grants → wave1-enable → verify-rls-state)を厳守する。

runbook 作成中に確認した非自明な事実を 1 つ: **`drizzle-kit migrate` は未適用 migration を全部まとめて 1 tx で流す**(`drizzle-orm@0.45.2` の `pg-core/dialect.js:60` が `session.transaction()` で全ループを包む・現物確認済)。ゆえに 0034 が `cards_state_range` の CHECK 違反(23514)で失敗しても **0035 ごと rollback** され、「途中まで当たった中間状態」は生じない。**drizzle bump 時にこの前提を再確認すること**(per-migration tx に変わると runbook の「そのまま再実行してよい」が偽になる)。
