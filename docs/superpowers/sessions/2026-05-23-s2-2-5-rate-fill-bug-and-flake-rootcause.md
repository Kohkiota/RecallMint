# S2.2.5 FSRS rate ボタン fill bug fix + session-limit-form 真因 flake 解消 sprint 完了

- 日付: 2026-05-23 (S2.2.4 closure 同日 follow-up)
- branch: `develop` (commit のみ、 push は OT 判断)
- 前提: S2.2.4 sprint 完了済 (commit `5adeb97`)
- plan: なし (bug fix 規模、 OT kickoff prompt + flake 発見対応で進行)

## 結論

OT が S2.2.4 で実装した FSRS rate ボタン押下ハイライトが実機で fill されない bug を
報告、 fix kickoff。 verify 中に **長期残存 flake** (session-limit-form、 S2.1 T5 由来、
複数 sprint で reduce 試行も完全解消できず) を再発見、 OT 承認のうえ同 sprint 内で
真因 fix。 全 2 主 task + 1 follow-up fix 完了。 590/590 test pass / 10〜20 連続 loop
全 pass / tsc clean / build pass。

## Sprint 達成事項

- **follow-up fix `5031157`** (session-limit-form 真因 flake 解消、 review pass):
  derived rendering (`value === savedValue && message`) + `flushSync` で urgent update
  sync commit 化。 useEffect / useLayoutEffect 経由の reset が React 19 transition と
  setState の interleave race で完全解消できず、 pure derived + flushSync で構造的に解消。
  20 連続 loop 0 flake。
- **T1 `1c2c23d`**: FSRS rate ボタン selected fill bug fix
  - selected 色: `bg-{c}-100 text-{c}-900 border-{c}-400` → `bg-{c}-600 text-white border-{c}-600 hover:bg-{c}-700`
  - Button `variant` 動的切替 (`lastRating === N ? 'default' : 'outline'`) で `bg-background` 衝突回避
  - test に `text-white` assert 追加で「class 含有のみ assert で実 CSS verify できなかった」 教訓を反映
- T2 (本 commit): tech-spec §3 routes に S2.2.5 fix 記載 + session log + retro

## review 結果集計

| Task | Critical | Important (fix 済) | Minor (記録のみ) |
|---|---|---|---|
| follow-up `5031157` | 0 | 0 | 3 (flushSync 入力毎 perf 微 / submittedValue 命名 / 初期 render コメント) |
| T1 `1c2c23d` | 0 | 0 | 4 (M-1 自己撤回 / M-2 DRY scope 外 / M-3 aria-pressed 引継ぎ / M-4 OK) |
| T2 | (no-review) | - | - |

review canonical 経路 (`superpowers:requesting-code-review` / general-purpose / template 改変なし)。
Critical / Important 0 件、 Minor は記録のみ、 握り潰しなし。

## 確定した設計判断 (S2.2.5)

- **selected 色 = 濃色 fill + 白文字**: bg-{c}-600 + text-white + border-{c}-600 +
  hover:bg-{c}-700。 WCAG AAA レベル contrast、 OT 仕様 (明確に分かる) と整合。
- **`variant` 動的切替**: selected 時 `variant="default"` で `bg-primary` を override 対象に、
  idle 時 `variant="outline"` 維持。 S2.2.4 の bg-background 衝突を構造的に回避。
  twMerge は同 utility group (bg-*) を後勝ち解決するので bg-{c}-600 が確実に勝つ。
- **test 強化**: class 含有 assert に加え `text-white` assert を追加、 実 CSS verify を
  間接補強 (jsdom は実 CSS computeStyle まで verify しないが、 token 検出は確度向上)。
- **session-limit-form 真因 fix = derived rendering + flushSync**:
  - 旧: `useEffect([value]) で setMessage(null)` (1/6 flake、 S2.2 T2 fix 試行)
  - S2.2.3: test waitFor 化 (1/10 reduce、 真因未解消)
  - S2.2.5 試行 1: `useLayoutEffect` (2/15 残)
  - S2.2.5 試行 2: derived rendering (`value === savedValue && message`) で表示制御 (1/15 残)
  - S2.2.5 最終: + `flushSync(() => setValue(...))` で urgent update を sync commit 化 (20/20 0 flake)
  - 結論: React 19 useTransition + setState の interleave race は post-commit hook (useEffect/useLayoutEffect) では完全に同期できない。 pure derived + 同期 commit が正解 pattern

## Retrospective (smoke 規律振り返り)

- **教訓 1**: S2.2.4 で「class 含有 assert で実機 fill 確認」 を test 段階で verify できなかった。
  Tailwind + cn() (twMerge) + cva の合成は jsdom では完全 verify 不可、 OT 実機 smoke が
  最後の砦。 → CLAUDE.md `### smoke 確認が必要な時` (S2.2.3 で追加済) に従い、 色付け系 UI
  変更時は smoke 手順を必ず chat に並記すべき (S2.2.4 closure では smoke 手順を出していたが、
  bug 自体は OT 実機で初めて顕在化、 報告ループが回った)。
- **教訓 2**: session-limit-form の race は複数 sprint で「reduce のみで真因未解消」 が
  続いた。 1/10 程度の flake を「許容範囲」 と扱わず、 真因 fix まで pursue すべき (CLAUDE.md
  完了条件「pnpm test 全 pass」 を緩めない)。 今回は S2.2.5 で 4 段階の試行を経て構造解消。
- **教訓 3**: React 19 useTransition と setState の interleave race は post-commit hook では
  完全 sync できない。 derived rendering / flushSync が信頼できる解決手段。 同種 pattern が
  他にも存在する可能性、 follow-up で監視 (例: fsrs-mode-form は optimistic update で類似
  race risk あるが現状 flake なし)。

## 既知の Minor (記録のみ、 将来 work)

- (T1 M-2) 4 rate Button JSX duplication → `.map()` でループ化余地 (S2.2.6 候補)
- (T1 M-3) `aria-pressed` 未設定 (S2.2.4 M-1 引継ぎ)
- (follow-up Minor) flushSync の入力毎 commit による微 perf cost (入力 1 文字毎 1 commit、 体感影響なし)
- (follow-up Minor) submittedValue 命名 / 初期 render 保証コメントの追加余地

## scope 外 (本 sprint 不実施)

- aria-pressed / role="radio" 化 (S2.2.4 引継ぎ、 future polish)
- 4 rate Button JSX の DRY 化 (T1 review M-2、 別 sprint 候補)
- 他 form の race パターン監査 (fsrs-mode-form 等、 現状 flake なしで保留)

## smoke 確認手順 (新 CLAUDE.md 規律準拠)

1. **確認 URL**: `/app/study/smart` (FSRS モード on、 due card あり)
2. **確認手順**:
   - 選択 → 「回答する」 → judged で 4 rate 表示
   - Hard 押下 → Hard が **明確な橙色 fill + 白文字** に変化 (薄色ではない)
   - Good 押下 (切替) → Good が緑 fill + 白文字、 Hard が outline に戻る
   - 「リトライ」 → selecting reset → 再 judged で 4 ボタンとも outline
3. **期待挙動**: selected は濃色 fill (bg-600) + 白文字で「押した」 ことが一目で分かる、
   idle は outline + 文字色のみ。 別 rate 押下で前 highlight 確実解除
4. **mobile 要否**: 必須 (Chrome DevTools mobile view、 2x2 grid、 tap target h-14 維持)

## 判断必要: no

sprint 完了報告のみ。 OT が next sprint kickoff と origin/main push のタイミングを判断。

## 詳細 file path

- 関連 sprint session logs:
  - S2.2: `docs/superpowers/sessions/2026-05-23-s2-2-fsrs-mode-and-s2-1-bugfix.md`
  - S2.2.1〜S2.2.4: 各 `docs/superpowers/sessions/2026-05-23-s2-2-{1,2,3,4}-*.md`
- 本 sprint commit:
  - follow-up = `5031157` (session-limit-form 真因 fix)
  - T1 = `1c2c23d` (rate ボタン fill bug fix)
  - T2 = (本 commit)
- tech-spec: `docs/02-tech-spec.md` (§3 routes /study/smart FSRS judged footer に S2.2.5 fill bug fix 追記)
