# iOS/WebKit 画像圧縮破損 修正 実装セッション記録

- **日付**: 2026-07-13
- **範囲**: 6 task(subagent-driven-development)、range `f626798..HEAD`(develop)
- **spec**: `docs/superpowers/specs/2026-07-13-ios-webkit-compression-fix-design.md`(凍結)
- **plan**: `docs/superpowers/plans/2026-07-13-ios-webkit-compression-fix.md`
- **原因記録**: `docs/superpowers/sessions/2026-07-12-ios-webkit-compression-corruption-debug.md`
- **SDD ledger**: `.superpowers/sdd/progress.md`
- **状態**: **全 6 task 完了・[reviewed] commit 済 / 未 push**。push + iPad smoke + R2 破損掃除 = OT。

---

## 1. 実装サマリ(task → feat commit)

| Task | 内容 | commit |
|---|---|---|
| 1 | `isWebKitImagePipeline`(iOS 全 browser + desktop Safari + desktop-class iPad 判定) | 98bbab4 |
| 2 | `image-validation`(出力妥当性検証・誤検知回避優先・純関数判定) | 2ce0999 |
| 3 | `compress-image-safe`(WebKit-safe pipeline・最終寸法 canvas のみ) | 0cf4c39 |
| 4 | `compressForAttach` 分岐 + 共通検証 + WebKit-only single-flight(risk) | 150ee9f |
| 5 | fallback(元画像 direct PUT)+ reserve に image/jpeg 追加 | ec4b2b5 |
| 6 | telemetry(1 添付 1 image_attach レコード・全転帰) | dbf250c |

各 task の Codex 生ログ: `docs/codex/2026-07-13-ios-webkit-t{1..6}-*.md`。

---

## 2. レビュー収束(canonical + Codex 二経路・全 task Crit0/Imp0)

- **T1**(1 周)/ **T2**(1 周・canonical opus が全 pass case を trace し誤検知 0 を検証)。
- **T3**(canonical Imp1 → Codex 2 周): error path の canvas leak を try/finally で修正。
- **T4**(risk・canonical opus が Blink 抽出を git-diff で verbatim 検証・single-flight release-on-rejection・nested lock 順 deadlock なし確認)。
- **T5**(canonical 初回 No = Crit1 + Codex 2 周): **元 jpeg fallback が reserve enum {webp,png} で RESERVE_FAILED に落ちる**(主要 iOS ケース破綻・mock reserve が隠蔽)→ reserve enum に image/jpeg + objectKey ext jpg + jpeg 契約 test。tryFallback の unguarded await(Imp)を try/catch guard。
- **T6**(canonical Minor1 + Codex 3 周): r1 decode_failed が validation_failed に潰れて surface 不能 → ValidationFailedError.reason + tryFallback で surface。r2 fallback 成功後の終端失敗が古い trigger reason を残す → 失敗時は終端 code の reason 優先。

> **多周収束の判断**: T3/T5/T6 は各 round が**新規の実 finding**(false-positive の再掲でなく)ゆえ productive convergence として継続。全 fix 済み。特に T5 の Critical は「client の fallback 適格 type と server reserve enum の連動」を unit mock が隠していた = whole-branch 級の contract 齟齬を per-task Codex が捕捉した価値。

---

## 3. whole-branch 最終レビュー(range f626798..HEAD・code のみ)

- **canonical(general-purpose / opus・read-only)**: **Ready to merge / Critical 0 / Important 0**。end-to-end trace で確認: (i) 根本原因(フル解像度 canvas)を構造的に排除 (ii) 誤検知保証(各 reject 節が入力 signal に AND-gate)(iii) **jpeg contract が reserve→objectKey→presign→PUT→finalize→display→DB→card 検証まで一貫**(webp/png 前提の consumer 不在)(iv) never-throw / concurrency deadlock-free / 1-record telemetry / Blink 無回帰。Minor2(下記)。
- **Codex 独立(`--base f626798`・detector PASS)**: **Crit0/Imp0/Minor0**。生ログ `docs/codex/2026-07-13-ios-webkit-whole-branch.md`。

**Minor(記録のみ・非 blocking)**:
1. `lib/db/schema.ts` の assets objectKey コメントが `.{webp|png}` で古い(jpg fallback で `.jpg` も出る)→ **本 session で `.{webp|png|jpg}` に修正**。
2. `validateCompressionOutput` の**入力再 decode 失敗が正常 output を reject しうる**(input を再 decode するため)。実害なし(fallback〔jpg/png は元画像 PUT〕or COMPRESS_FAILED の安全 end-state に落ちる・同 file が 2 度目の decode で失敗する稀ケース)。→ smoke で telemetry 分布を確認(iPad で正常表示なのに decode_failed/validation_failed が出るなら本経路・follow-up 候補)。
3. `sha256Hex` の 2 copy(循環 import 回避・rule-of-three 未満・意図的)。

---

## 4. スコープ拡張(記録)

**T5 の Critical 修正で `asset-actions.ts`(server reserve mime enum + objectKey ext)を変更**。fallback(元 jpeg direct PUT)機能の必須部分ゆえ sprint scope 内。jpeg は presign が mime をそのまま署名するため自動整合。DB `mime` は自由 text(CHECK なし)ゆえ jpeg 保存可。

---

## 5. 検証状況

- **unit を正**(全 task 完了条件)。**reject/fallback の正しさは unit が authority**(良品画像では実機で誘発困難)。誤検知テスト(T2)= 正当な白/低分散/透過/icon/線画/黒板を pass、が最重要で厚い。
- **sprint 完了 gate 全 exit 0**: whole-repo `pnpm lint --max-warnings=0` **exit 0 確認済** / `pnpm typecheck` / `pnpm build` / `pnpm test` **3480 green**。

## 6. iPad 実機 smoke(OT・Mac なし → telemetry 構造化ログ〔`event:'image_attach'`〕を stg 確認 or 画面表示)

- [ ] iPad で **長いスクショ / 大画像 / 通常画像 / 透過画像** 添付 → 健全な webp/jpeg/png が R2 着地(**≈856B 破損が出ない**)+ 表示 + telemetry `compressionPath:"webkit-safe"` / `outcome:"success"` / 健全な `validationMetrics`。
- [ ] **EXIF orientation**(代表 = iPhone orientation 6 横持ち):正立表示 + 保存寸法一致。
- [ ] **PC(Blink)回帰**: `compressionPath:"lib"` で従来どおり正常(44KB webp)。
- [ ] telemetry 分布に **decode_failed/validation_failed が正常表示画像で頻出しないか**(whole-branch Minor#2 の監視)。
- [ ] fallback(元 jpeg direct PUT):誘発できれば `compressionPath:"fallback"` / R2 に元 jpeg が着地・表示。困難なら unit を正とする。

## 7. Ops(OT 手動)

1. **push**: develop → origin。
2. **R2 破損 test データ掃除**: 本バグ期間に着地した **≈856B 極小 webp を `users/{user_id}/` prefix で**特定(§画像フェーズ A session doc §8 の掃除素材参照)→ 件数確認後 R2 コンソールで削除。
3. migration 追加なし(schema コメント修正のみ・DB 変更なし)。R2 env / CORS は画像フェーズ A で設定済(jpeg も同 CORS で通る)。

## 8. process 教訓

- **content-based git-clean detector を使う background codex-review の実行中は working tree に file を書かない**(画像フェーズ A で誤検出済)。今回 whole-branch Codex は file を書かず実行 → detector PASS。session doc は Codex 完走後に執筆。
- **per-task Codex が whole-branch 級の contract 齟齬(T5 jpeg enum)を捕捉**: unit mock(reserve が any mime を受ける)が隠す server 契約の乖離を、Codex の「real diff を独立に見る」姿勢が拾った。mock は契約を隠しうる = 契約 test(jpeg-accepted reserve)を足して連動を pin。
