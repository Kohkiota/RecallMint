# S2.0b-1 試験詳細 Notion 風 inline 編集 sprint 完了

- 日付: 2026-05-24 (前日 S2.2.5 closure 翌日に kickoff、 同日完了)
- branch: `develop` (commit のみ、 push は OT 判断)
- 前提: 直前 commit `add41c5` (session-limit-form 再 fix)、 main は S2.2.2 までで止まっており develop の S2.2.3〜2.2.5 + S2.0b-1 は未 merge
- plan: なし (OT kickoff prompt + 各 task subagent prompt で仕様確定)

## 結論

試験詳細画面 (`/app/exams/[id]`) を read-only + 「編集」 ボタンで `/app/cards/[id]` に
遷移する旧 UX から、 **常時 inline 編集** UX に全面置換。 全 5 task + 1 follow-up
完了。 649/649 test pass / 10 連続 loop 0 flake / tsc clean / build pass。

## Sprint 達成事項

- T1 `1c331a9`: cards に memo text NULL 列追加 + migration 0011 (no-review、 schema only)
- T2 `95997e8`: `updateCardField(cardId, field, value)` server action 新設
  (field union 6 種、 owner-scoped UPDATE、 options 時 correct_answer_ids 再生成、
  revalidatePath 2 path、 各 field zod 検証、 21 test)
- **follow-up `add41c5`**: session-limit-form race を atomic Message + test idle 待ちで完全解消
  (S2.2.5 で 1/15 残った flake が T3 並列負荷増で 1/10 再発 → atomic 化で 1/20 →
  test 側 transition idle 待ち追加で 0/20)
- T3 `ec595a4`: 試験詳細画面の 5 テキスト field を inline 編集化、
  「編集」 ボタン廃止、 memo section 追加。 `inline-text-field.tsx` (171 行 reusable cell) +
  `inline-card-list.tsx` (119 行 一覧) + 20 test
- T4 `ccc34e9`: 選択肢 4 field (id/text/is_correct/explanation) を inline 編集化、
  is_correct のみ checkbox 即時保存、 他は focus out。 options 配列全体を
  `updateCardField('options', ...)` で送信 (該当 index のみ書換)。
  `inline-option-row.tsx` (348 行) + 16 test
- T5 (本 commit): tech-spec §2.5.2 / §3 routes /exams/[id] / §3 actions 更新 +
  session log

## review 結果集計

| Task | Critical | Important (fix 済 or scope 外) | Minor (記録のみ) |
|---|---|---|---|
| T1 | (no-review) | - | - |
| T2 | 0 | 0 | 5 (idiom 重複 / sort_key trim / DRY / test 厳格化 / 型 discriminate) |
| follow-up | 0 | 0 | 3 (コメント不整合 = fix 済 / test reader 補足 / snapshot 意図) |
| T3 | 0 | 2 (I1 blur-during-pending guard fix 済 / I2 concurrent edit sync = TODO 化) | 6 (cosmetic) |
| T4 | 0 | 3 (I1 同 row 並列編集 = header 記録 / I2 explanation クリア payload test = fix 済 / I3 並行 server update = header 記録) | 5 (cosmetic) |
| T5 | (no-review) | - | - |

- 全 feat task で `superpowers:requesting-code-review` skill canonical 経路 (general-purpose
  subagent / template 改変なし)。
- Critical 0、 Important 5 中 3 fix 済 + 2 MVP scope 外で header comment 記録 (握り潰しなし)。
- Minor 19 件は記録のみ (cosmetic / 命名 / DRY 余地 / nice-to-have coverage)。

## 確定した設計判断 (S2.0b-1)

- **inline 編集の保存 timing**: click → input/textarea → focus out (blur) で自動保存。
  is_correct のみ checkbox onChange で即時保存。 値変更なしなら server 呼出 skip
  (`value === committed` 比較)、 失敗時 editing 維持 + retry。
- **server action 分離**: `updateCard` (既存、 全 5 列同時保存、 `/app/cards/[id]` 用) と
  `updateCardField` (新規、 field 単位、 inline 編集用) を分離。 旧 `updateCard` は無変更で
  共存、 v1.x で `/app/cards/[id]` page を retire するなら updateCard も deprecate 候補。
- **options 配列全体送信**: 1 option の 1 field 変更でも options 配列全体を送る (T2 server
  action API は options 配列を受け取る、 partial update なし)。 該当 index のみ書換、
  他 option は touch なし。 correct_answer_ids は server 側で再生成 (client 改竄堅牢)。
- **memo 列追加**: cards.memo text NULL。 試験詳細画面でのみ表示・編集、 `/app/cards/[id]`
  page には未追加 (scope 外、 旧 page は touch しない)。
- **「編集」 ボタン廃止**: 試験詳細画面の `/app/cards/${id}` link 削除。 `/app/cards/[id]`
  page 自体は残置 (deep link / OCR 直後 redirect 等で参照される)、 v1.x で再評価。
- **MVP scope 外 (review I で記録)**: (a) 同 row 内 cell 並列編集 / (b) 並行 server
  update 時の反映遅延 / (c) 別 tab / user 同時編集 sync。 v1.x で OCC / etag 検討。
- **session-limit-form race の根本解決**: S2.1〜S2.2.5 で 4 sprint 越しに reduce のみ
  だった flake を、 「atomic Message ({kind, text, value}) 集約 + test 側 transition idle
  待ち」 で 0/20 完全解消。 React 公式 pattern「related state は 1 つに集約」 に整合。

## 既知の Minor (記録のみ、 将来 work)

- (T2 M2) sort_key trim 余地 (`'  abc  '` がそのまま保存される、 ORDER BY に影響可)
- (T2 M3) optionsArraySchema を `lib/validation/card.ts` から共通 export 余地
- (T3 M1) `/app/cards/[id]` deep edit page と inline 編集の二重存在 (将来統合候補)
- (T4 M1) `InlineOptionCell` が `InlineTextField` と ~50 行構造的 duplication、 3rd consumer
  出現時に base hook 抽出余地
- (T4 M4) checkbox `e.target.checked` vs `!committed.is_correct`、 race-safe には後者
- (T3/T4 共通) aria-pressed / role="radio" 等の a11y polish

## scope 外 (本 sprint 不実施、 後続 sprint 候補)

- 選択肢の追加・削除・並び替え (S2.0b-2 想定)
- タグ編集 (S2.0b-3 以降、 custom_props → tag schema 移行)
- `/app/cards/[id]` page の deprecation / 削除
- OCC / etag / concurrent edit lock
- フィルタ・検索・複数選択・一括操作 (F-009)

## smoke 確認手順 (CLAUDE.md §smoke 規律準拠)

1. **確認 URL**: `/app/exams/[exam_id]` (OCR で card が複数枚生成済の exam を選択)
2. **確認手順**:
   - sort_key cell click → input 表示 → 値変更 → focus out → 値が表示モードで反映
   - title / question_text / explanation_text / memo を順次 click → edit → blur → 自動保存
   - memo は空 (placeholder「メモ (クリックで追加)」 表示) → click → 入力 → blur で保存
   - 選択肢の id / text / explanation を click → edit → blur で自動保存
   - 選択肢の is_correct checkbox を click → 即時保存 (focus out 不要)、 background 色変化
   - 値変更なしで blur → server 呼ばれず即 display 復帰 (Network tab で確認)
   - 「編集」 ボタンが **試験詳細画面に存在しないこと** を確認
3. **期待挙動**: 全 field 編集中 spinner / 保存中 disabled、 失敗時 inline error UI、
   成功で display 復帰。 ページ reload せずに次々編集可能
4. **mobile 要否**: 必須 (Chrome DevTools mobile view、 tap target 44px 確保確認、
   textarea 拡張 / checkbox tap area)

## 判断必要: no

sprint 完了報告のみ。 OT が next sprint kickoff と origin/main push のタイミングを判断。
develop は origin と同期、 main は依然 S2.2.2 で止まっており、 S2.2.3〜2.2.5 + S2.0b-1
分の merge + push が production deploy に必要。

## 詳細 file path

- 関連 sprint session log (前日まで):
  - S2.2.5: `docs/superpowers/sessions/2026-05-23-s2-2-5-rate-fill-bug-and-flake-rootcause.md`
- 本 sprint commit:
  - T1=`1c331a9` (no-review)
  - T2=`95997e8` (reviewed)
  - follow-up=`add41c5` (reviewed、 session-limit-form race 完全解消)
  - T3=`ec595a4` (reviewed)
  - T4=`ccc34e9` (reviewed)
  - T5=本 commit (no-review)
- tech-spec: `docs/02-tech-spec.md` (§2.5.2 cards memo / §3 routes /exams/[id] / §3 actions updateCardField)
