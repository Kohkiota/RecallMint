# tag mirror hygiene sprint — 実装記録(at-rest 衛生 + correctness follow-up)

- 日付: 2026-08-17
- spec(凍結): `docs/superpowers/specs/2026-08-17-tag-mirror-hygiene-design.md`(r4・OT 承認 / Codex re-review GO)
- plan(凍結): `docs/superpowers/plans/2026-08-17-tag-mirror-hygiene-sprint.md`(r3・Codex plan review GO)
- 前提 sprint: `2026-08-16-tag-mirror-correctness-sprint.md`(Path C / prod 反映済)
- 実装方式: `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 canonical review + Codex 独立 review)
- **status: 実装完了・全 gate green・未 push。stg smoke 未実施(push 後に OT 指示で実施)**

## 1. commit 一覧

| commit | task | 内容 |
|---|---|---|
| `36e2212` | T1 | `/api/study-days/pull` の owner echo + client 2 段検証(空 payload の vacuous 穴) |
| `7e38b7a` | T2 | pull apply tx 先頭の cursor CAS(3 態 abort + sentinel 正規化) |
| `b8e6eee` | T3 | deck DL の success gate(両成功出口を支配) |
| `6f26482` | T4 | sign-out purge(`local-hygiene` module + 分類表 + `SignOutPurge`) |
| `133d10c` | T5 | sign-in 異 owner sweep + 旧 key 物理削除 + trigger |
| `a48ac9f` | T6 | option-list 一覧 read の owner-scope 化(M-c) |

全 6 commit が `[reviewed]`。docs commit(`3e48132` / `9c95a14` / `2616e7e` / `61a9f83` / `bcfb1f3` / `fe23705`)は各 task の Codex raw findings 永続化。

## 2. sprint 完了 gate(全 exit 0 / 実測値・最終 fix wave 適用後に再測定)

| gate | 結果 |
|---|---|
| whole-repo `pnpm vitest run` | **5344 passed / 301 files** |
| `pnpm lint --max-warnings=0` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm run audit` | exit 0 |
| `pnpm test:iso` | **452 passed / 39 files** |
| `pnpm build` + postbuild | PASS(pdfium packaging 3 点一致) |

**correctness sprint の凍結 pin は全 green を維持**(capture 原則 / validate-before-tx 順序 / owner echo 4 pin / I-1 caller pin)。T2 の canonical が構造的にも確認: `pull.test.ts` の削除行ゼロ・production 側の意味的削除は §4 見出しコメント 1 行のみ。

## 3. 設計の核(なぜこの形か)

**至上命題は「correctness を毀損しないこと」**。表示保証は correctness sprint で完結しており、本 sprint はその下の層(at-rest)を eventual に掃除するだけ。ゆえに 4 条件で自分を縛った:

1. **単一 rw tx**: purge / sweep の Dexie 削除は 11 store を跨ぐ 1 tx。「mirror だけ消えて cursor が残る」部分実行を構造的に禁じる — この状態は同一 owner の再 sign-in で **delta pull が消えた行を取り直さず silent 表示欠落**になる。
2. **cursor CAS**: tx 直列化だけでは「cursor 読取 → network → apply tx」の窓を閉じられない。窓中に purge が挟まると旧 cursor 由来 delta が空 mirror へ apply され、次回以降 delta 継続で欠落が永続化する。apply tx 先頭で snapshot と再読を比較し abort する。
3. **不可侵集合**(owner 不問): pending/syncing/failed outbox・非 `'ready'` assets 行 + blob・`'downloading'` jobs + added blob。
4. **DL success gate**: deck DL の all-or-nothing は blob 集合の完全性を含むため、cleanup との交差を「受容」にできない。両成功出口を支配する gate で閉じた。

**lock / marker / bootstrap / 直列化は一切使っていない**(r1〜r3 で撤回済・再導入禁止)。purge / sweep は best-effort(発火・順序・完了待ち保証なし)で、eventual は「次回実行機会があれば収束する」の条件付き。

## 4. 本 sprint で新たに判明した事実(棚卸し doc に無かったもの)

Appendix B として棚卸し doc に追記済(`2026-08-16-tag-mirror-writer-inventory-factfinding.md`)。

1. **media flush-gate hazard**: `entity-mutations.ts` の flush gate は `media_assets` の `'uploading'` 行の存在を根拠に pending images mutation を保留している。cleanup が行だけ消すと **gate が開き、実体の無い image key を server に確定させる**。棚卸し §4 の 3 分類は**行の owner 列だけを見ており、行が他機構の gate 根拠になっている結合を見ていなかった**。
2. **DL blob 完全性の TOCTOU**: 保護 blob 集合は Dexie tx 後の残存行から算出するため、算出後に開始した DL の blob は cleanup に巻き込まれうる。upload レーンは実害 bound 済(R2 PUT の source は in-memory blob)だが DL レーンは契約違反になるため gate で閉じた。

## 5. review の実績

- **T4 で Important 1 件を検出**: `<SignOutPurge />` の layout mount が**全く pin されていなかった**。mount を削除しても unit / typecheck / lint / build が全 green のまま通る = 成果物が丸ごと死んでも検出できない状態。**repo の教訓「唯一の caller が未 pin」の再演**で、fix round 1 で source-grep pin 2 本(mount + ClerkProvider 配下)+ red 実証を追加。T5 の trigger にも同型 pin を最初から要求した。
- **Codex が T3 で P1 を 1 件**: 「gate 通過後〜return までに cleanup が消せば `ok:true` + 欠け」。**凍結 spec §4.2 が受容済みの残余窓**であり、提案対策(共有 lock)は §0 が再導入を禁じた機構そのもの → 不採用裁定(§6)。canonical は同点を defect として挙げていない。
- **whole-branch review で Important 2 件**(task 単位 review 6 回 + Codex 6 回を通過してもなお残った類): ① **「両成功出口を支配する」完全性主張が未 pin**(3 つ目の `ok:true` を足しても全 gate green)= 教訓「完全性主張は無言で偽になる」の再演。同 sprint が mount で 2 回 source-text pin を使っている以上、不在は判断でなく一貫性の欠如 ② **異 owner の中断 DL 残骸に回収機構が無い**(`sweep.ts:119` が自 owner scope)のに doc の語感が一時的残置と読める。fix wave で両方 close(出口数の source-text pin + red 実証 / doc 1 文追記)。同 wave で mount pin が**コメントアウトを検出しない**穴も塞いだ(判定前に JSX コメントを除去)。
- **red 実証の総計**: T1 3 変異 / T2 5 / T3 2 / T4 19 + 5 / T5 19 / T6 2 / final fix wave 3。いずれも 1 箇所ずつ個別注入(まとめ壊し無効の規律)。
- T5 は API 529(infra 障害)で RED 作成直後に中断 → 状態を実測して同一 agent を resume。canonical が「529 中断による半端な残骸なし」を全変異点の復元確認で保証。

## 6. 実行中に下した裁定(ruling)一覧

| # | 裁定 | 理由 | 誤っていた場合のコスト |
|---|---|---|---|
| 1 | T4 が `HYGIENE_STORE_RULES` の **sweep 列も T4 時点で定義**(消費者は T5) | plan T4 Interfaces の明記 + spec §9-8 が purge/sweep 双方の分類強制 pin を要求 | sweep 列を T5 へ移す小規模 rework |
| 2 | 保護 blob 集合の算出は module-internal 共有関数(export しない) | T4 が作り T5 が同 file から再利用 | 実質なし(export 追加のみ) |
| 3 | implementer に **commit させず** CC 本体が review 収束後に commit | CLAUDE.md「review pass → commit の一方向のみ」が SDD 既定と衝突。project 規律を優先 | review package を commit range でなく working tree diff から生成する手間 |
| 4 | Codex と canonical を **逐次**(Codex 先行) | canonical の変異注入が Codex の git clean detector に偽陽性を出す既知事象(correctness sprint 裁定 3) | review 1 周あたりの wall-clock 増 |
| 5 | **Codex T3 の P1 を不採用** | spec §4.2 が「検証通過後の削除は sign-out による意図的な全消去そのもので契約違反ではない」と受容済 + §0 が lock 再導入を禁止。spec が binding authority | gate 通過直後に消えた blob で offline 表示が欠ける窓が残る(実害 = 再 DL で回復・sign-out 時のみ) |
| 6 | T4 の Minor 4 件のうち 2 件(`never` 網羅 / purge の log 1 行)を **fix round に同梱** | 前者は「構造で閉じる」module の趣旨と一致し 2 行、後者は spec §10 smoke ④ が log 無しでは end-state から判定不能 | fix round がわずかに膨らむ |
| 7 | T2 の ⚠️「実ブラウザで Dexie tx zone が async helper 越しに存続するか」は **gap ではない** | `lib/sync/optimistic-mutation.ts:121-127` に出荷済みの同型前例。破綻時は非 sentinel の `TransactionInactiveError` で全 pull が loud に失敗する | stg smoke で pull 全滅が判明し CAS 実装形の見直し |

## 7. deferred minor(最終 review で triage 済 / 記録のみ)

| # | 内容 | 出所 |
|---|---|---|
| M-1 | CAS の回復分岐②(cursor 前進 → 現在 cursor から delta)が未 pin(分岐①のみ pin) | T2 canonical |
| M-2 | CAS の **ABA 安全性の論拠が未記載**(delete→同値再書込が通るのは「purge 後の pull は cursor 不在 = full pull」ゆえ、という依存が comment に無い) | T2 canonical |
| M-3 | DL success gate が「return 後の永続性」を保証しない旨の bound が code comment に無い(Codex P1 の誤読が起きた事実自体が示す) | T3 |
| M-4 | `local-hygiene.ts` の `typeof row.key === 'string'` guard が到達不能・未 pin(過剰防御) | T5 canonical |
| M-5 | sweep trigger の `.catch(() => {})` gate が**個別変異されていない**(kick 行ごと除去で 4 pin 同時 red = 個別変異規律を満たさない) | T5 canonical |
| M-6 | sweep が全 page load で 11 store の rw lock + 全走査を取り、`PullTrigger` の tx がその後ろに並ぶ(correctness 非影響)| T5 canonical |
| M-7 | `casApplyResponse()` が cards stream のみを exercise(mirror 不変 assert が 5 store 中 1)| T2 canonical |

## 8. spec 準拠だが記録しておく挙動

**異 owner の `'downloading'` job に属する added asset の `media_assets` 行の有無は経由で変わる**(final fix wave で訂正 — 元記述は「常に `'ready'` 行がある」という一方向の前提で、凍結 spec §4.2 の「行は存在しない」と逆に読める書き方だった)。**両方とも起こりうる**: asset 行を**作る**のは `lib/media/upload.ts:711`(`media_assets.put`)の 1 箇所のみ(`:768` は同行の status を `'ready'` へ **update** するもので作成ではない — 最終 re-review の指摘で訂正)のため、別 device で添付された asset を本 device で DL する経路では行は存在しない(**凍結 spec §4.2 の記述はこの別 device 経路について正しい**)。一方、**同一 device で Cache eviction が起きると**、`'ready'` 行を持つ key が cache miss に戻って DL 対象(miss / `added_asset_ids`)に載るため、この経路では `'ready'` 行が存在する。**実装はどちらでも安全**: 不可侵集合の保護は `media_download_jobs` の行 + `job.added_asset_ids` の blob を基準にしており、`media_assets` 行の有無を見ていない — ゆえに行の有無いずれでも sweep / purge は job と blob を温存する。結果として異 owner 側の all-or-nothing DL が orphan blob 付きで着地しうる。purge も同一挙動で **spec 準拠**(凍結 spec の seam)。

## 9. stg smoke 手順(push 後・OT 指示で実施)

correctness sprint の A/B アカウント(`+clerk_test` / `+clerk_test1`・OTP 424242)で CC 自走:

1. A で操作(cursor / prefs / synced outbox 生成)→ **sign-out** → IDB readback: mirror 空 / `sync_meta` 空(**bare legacy key も消える** — correctness smoke §10 手順 2 の「残置が正」の**反転**)/ synced outbox 消 / pending 残存(作れれば)/ Cache の保護外 key 消
2. B で sign-in → sweep 後 readback: fixture で作った異 owner 残骸の消滅 / B namespace 無傷
3. `/api/study-days/pull` 応答 top-level に `owner_user_id`(correctness smoke §10.1 #10 の**反転**)
4. `local_hygiene.purge` の log 出現で purge 発火を確認(**不発でも FAIL にしない** — best-effort・保証外)
5. **M-6 の実地確認**: 大きめのデッキを持つ状態で `/app` 初回 load 時の体感(sweep の rw lock が pull を待たせないか)

競合系(CAS 窓 / Cache TOCTOU / 遅走 purge / 二重並走)は **unit pin が正**で、smoke では交差試験を行わない(spec §10 の分担)。

## 10. 運用上の注意(prod 反映前に必ず読む)

1. **保証開始条件が correctness sprint より厳しい**: 「本 bundle を実行している tab」だけでなく **pre-hygiene writer(旧 bundle tab)が存在しないこと**まで要求する。旧 bundle tab の pull は CAS に参加せず共有 IDB を汚染でき、CAS は開始時点の既存不整合を修復しない。**deploy 後に全 tab の reload が前提**(実質ユーザー 0 の現状では OT の tab 閉じで充足)。
2. **server 単独 rollback 不可の非対称が `/api/study-days/pull` にも増えた**: echo を server だけ戻すと新 client が study_days の全 pull を silent reject し、mirror が更新されなくなる(UI にエラーは出ない)。roll-forward 原則の適用範囲に本 endpoint を追加。
3. **sign-out のたびに次回 sign-in が full pull になり、`exam_view_prefs` が消える**(受容済コスト)。
4. **purge の発火集合は「sign-out」より広い**: 匿名 visitor の marketing page 訪問(`Dexie.exists` guard で Dexie 部 no-op)や auth 初期化境界での一時的 signed-out 観測を含む。
5. **[reviewed] の正記録は本 doc**(データ保全に触れる fix で push→smoke の順ゆえ commit tag の amend 窓が構造的に閉じるため。既存裁定どおり)。
6. **異 owner の `'downloading'` job + added blob は恒久的に残りうる**(final fix wave で追記): 既存 sweeper(`sweepStaleMedia`)は自 owner scope(`lib/media/sweep.ts:119` の `j.user_id === userId` filter)のため、異 owner の `'downloading'` job を触らない。purge も hygiene sweep も不可侵集合として温存するため、当該 owner が再 sign-in しない限り共有ブラウザに残り続ける(一時的な残置ではない — `docs/architecture.md` 残余リスク行に同事実を反映済)。
