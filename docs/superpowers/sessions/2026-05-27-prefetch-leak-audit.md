# Link prefetch={false} 漏れ調査 + 修正 session log

- 実施日: 2026-05-27
- 種別: session log / cache-fix roadmap ④-2 implementation
- 関連 commit: `a261f8e chore(perf): (app) dynamic page への Link 7 箇所に prefetch={false} 追加 [reviewed]`
- 関連 brief: cache-fix roadmap §④-2
- 結論: Step 2 ④-2 invariant (「(app) 配下 dynamic page への `<Link>` には `prefetch={false}` を付ける」) は本 commit で完全 close

---

## 1. 結論サマリ

cache-fix roadmap Step 2 ④-2 (`<Link prefetch={false}>` 漏れ修正) を完了。
phase 1 grep で 6 修正候補確定 → OT touch list 承認 → 実装中 review で
multi-line `<Link>` 1 件追加発覚 → OT 承認のもと fold-in → 6 file 7 箇所 1
commit で完結。 typecheck clean / 818 tests pass / review Critical 0 /
Important 0 / Minor 3 (M-1 fold-in / M-2 + M-3 defer)。

---

## 2. 実装サマリ

### 修正 6 file 7 箇所 (commit `a261f8e`)

| # | file:line | href | 導線 | 経緯 |
|---|---|---|---|---|
| 1 | `app/(app)/app/upload/page.tsx:73` | `/app/exams` | upload 処理中案内 CTA | phase 1 確定 |
| 2 | `app/(app)/app/study/smart/_components/study-session-host.tsx:118` | `/app` | empty UI ダッシュボードへ | phase 1 確定 |
| 3 | `app/(app)/app/exams/page.tsx:53` | `/app/upload` | exam 0 件 empty UI | phase 1 確定 |
| 4 | `app/(app)/app/exams/[id]/page.tsx:65` | `/app/upload` | card 0 件 empty UI | phase 1 確定 |
| 5 | `app/(app)/app/exams/[id]/page.tsx:41` | `/app/exams` | ← 試験一覧 back link | **review M-1 で発覚、 fold-in** |
| 6 | `app/(app)/app/upload/result/[sourceDocumentId]/_components/result-actions.tsx:11` | `/app/exams` | OCR 結果画面 CTA | phase 1 確定 |
| 7 | `components/pricing/pricing-table.tsx:224` | `/app/upgrade` | pricing page アップグレード CTA | phase 1 確定 |

各箇所修正内容: `<Link href="...">` → `<Link href="..." prefetch={false}>` (prop
追加のみ、 className / asChild / 子要素 / 他 prop は touched なし)。

### Phase 1 → Phase 2 移行判定の経緯

brief「(app) 配下 dynamic page への Link で prefetch 未抑制が見つかった場合
→ phase 2 移行」 + 「修正規模 4 file 以上で spec/plan 要否判断」 に対し、
6 file 各 1 行 (= 内容均一 / 機械的 / 設計判断ゼロ) の理由で OT は **案 A
(全 skill skip + chat 議論で実装)** を承認。 brief + chat report (touch list)
を mini-spec として扱う運用 (CLAUDE.md kickoff 規律で OT 明示承認の C-skip
pattern)。

---

## 3. Lessons-learned (roadmap 外、 follow-up 候補として defer)

### M-2. multi-line grep methodology gap

phase 1 で実施した grep は `grep -rn "<Link " --include="*.tsx"` の **単行 line
pattern** で、 multi-line `<Link>\n  href=...` 形式の declaration を **見落と
した**。 review M-1 で `app/(app)/app/exams/[id]/page.tsx:41-46` の back-link が
発覚し fold-in。

将来の同種 audit task では、 multi-line pattern も検出する scan を check list
に含めるべき:

```bash
# 例: ripgrep multi-line scan (改行を超えて <Link> 開始タグを捕捉)
rg -U --multiline '<Link\s' --type=tsx
# あるいは ast-grep / tree-sitter で構造的に Link 要素を抽出
```

cache-fix roadmap の今後の audit task (例: prefetch invariant の継続 audit、
他 prop 整合性 audit、 dead code grep 等) で本 lesson を anchor として参照。

### M-3. ESLint rule で invariant codify

「(app) 配下 dynamic page への `<Link>` は `prefetch={false}` 必須」 という
invariant を `eslint-plugin-local` の custom rule で codify すれば、 新規
コード追加時の人手 audit を不要化できる:

```
no-link-without-prefetch-false-in-app:
- check: <Link href=...> の中で href が "/app/*" で始まり、
  かつ /app/static-page 等の static でないなら、
  prefetch={false} prop の存在を必須化
```

実装コスト中程度 (= ESLint plugin の AST traversal、 href の literal vs
template / 動的 href の判定が必要)。 LocalSync MVP / 他 sprint 完了後の
roadmap 終盤で検討候補。

### 両 lesson の defer 理由

両 lesson とも本 task scope 外 + roadmap brief 明示「やらないこと」 に近い
領域。 ただし lesson 自体は記録に値する (= 将来の audit task で再発防止 +
invariant 強化への anchor)。 本 session log に記録するのみで、 即座の対応は
行わない。

---

## 4. CLAUDE.md kickoff 規律遵守記録

着手前宣言 + phase 2 移行時宣言 + M-1 fold-in 時の OT 確認、 すべて chat
履歴に明示。 「skip ミスに気付いたら即中断 + OT 仰ぐ」 規律準拠で:

- M-1 (review で発覚した 7 件目) は **touch list 拡張**にあたるため、 独断
  fold-in せず OT 確認を経て承認後 fold-in
- M-2 / M-3 は touch list 拡張ではなく lesson 記録のみ、 session log への
  記述で完結

---

## 5. やらないこと (brief 遵守、 実態反映)

- prefetch={true} の意図的復活: 未実施 (= S-perf-1 抑制方針 + S-perf-2 T6
  hover prefetch skip 判定済)
- (app) 配下以外 (public / auth / marketing static、 8 件) の Link 修正:
  **未実施** (= server 負荷影響軽微、 brief 明示の除外対象)
- Link 以外の prefetch 経路 (router.prefetch / pathname-based prefetch) の
  調査: 未実施 (本 task scope は `<Link prefetch>` のみ)
- LocalSync MVP 関連: 未実施 (Step 3 で別途)

---

## 6. cache-fix roadmap Step 2 完了宣言

Step 2 (④-1 PullTrigger 移動 / ④-3 /app/cards/[id] 廃止 / ④-4 notifyOps 404
silent skip / ④-2 prefetch 漏れ修正) すべて完了。 次は roadmap Step 3 (LocalSync
MVP 起草) or cache-fix 系の epilogue (M-2 / M-3 等の lessons-learned を
spec/plan 化するか判断) に進む。
