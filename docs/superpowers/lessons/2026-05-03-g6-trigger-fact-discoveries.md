# G-6 trigger fact discoveries: spec / plan 記述誤り + Discord URL invalid 化方法 + AI input cap violation 簡便性

**作成日**: 2026-05-03
**source sprint**: Phase 1 G-6 (構造化ログ logger interface + 7 callsite swap、impl `2819cfb [reviewed]`)
**source spec**: `docs/superpowers/specs/2026-05-03-phase1-g-6-structured-logger.md` (commit `77f65a7`)
**source plan**: `docs/superpowers/plans/2026-05-03-phase1-g-6-structured-logger.md` (commit `2b40830`)
**discovery 経緯**: G-6 Y' 経路の Production 実機確認 (#1-#7 callsite trigger 試験) で OT が #5 / #7 trigger に苦戦、Claude Code 側 fact 調査で発覚した 3 件の事実 (うち 1 件は spec / plan の記述誤り)。

---

## Lesson 1: notifyOps fallback callsite (#5 / #7) は排他関係、spec / plan の「同時 trigger 可能」記述は誤り

### 当初記述 (誤り)

spec §4.8 + plan 全体ルール:
> #5 / #7 同時 trigger 可能 (Discord URL invalid 化 1 操作で 2 callsite verify 可能)

### 実際の挙動 (code 経路 trace で発覚)

`lib/ai-usage.ts:113-129` の構造:
```typescript
try {
  await notifyOps('AI daily limit reached', { ... })       // ← #7 trigger 試行
} catch (notifyErr) {
  logger.warn({ event: 'ops.notify.failed_in_daily_limit', err: notifyErr })  // ← #5
}
```

`lib/ops.ts:38-55` の `notifyOps` 内部:
```typescript
try {
  await fetch(url, { ..., signal: AbortSignal.timeout(3000) })
  // non-2xx も escalate しない (4xx/5xx は throw しない)
} catch (err) {
  logger.warn({ event: 'ops.notify.fetch_failed', err })   // ← #7 trigger 経路
}
```

呼出 trace (Discord URL fail 経路):
1. `lib/ai-usage.ts` → `notifyOps` call
2. `notifyOps` 内部で `fetch` fail → catch → `logger.warn({event: 'ops.notify.fetch_failed'})` = **#7 trigger**
3. `notifyOps` は **throw しない** (silent return、`lib/ops.ts:11` 設計コメント保証)
4. `lib/ai-usage.ts` の catch (#5) には **到達しない**

→ **#5 と #7 は排他**:
- #7 trigger 条件下では notifyOps は内部で吸収して return、#5 は trigger されない
- #5 trigger には notifyOps が throw する必要 → 現状の `lib/ops.ts` 設計では発生不可 (defensive only)

### 教訓

brainstorming Step 1 (project context exploration) で callsite ごとの実 trigger 可能性を **code 経路 trace まで確認** する。catch 経路の throw 仕様 (関数が throw するか、silent return するか) を spec assertion として明示。「fallback としての console.* call」は「呼び元が throw した場合のみ trigger」の semantic を spec で明記し、その throw 条件が現状到達可能か (production code path で発火し得るか) を verify する。

本件では Step 1 で「#5 = notifyOps fail fallback」「#7 = notifyOps 内部 fetch fail」と認識したが、両者の trigger 条件が排他であることを spec / plan に反映しなかった。Q6 (notifyOps fallback callsite を logger 化) の議論で「循環 risk 排除」に focus し、trigger 関係の精査が不足。

### 影響

- 実装: 影響なし (logger 経由化は完了、callsite swap も正しい)
- 試験: OT が #5 を trigger できず混乱、Claude Code 側 fact 調査で判明
- spec / plan 記述: 本 lessons で記録、次回類似 sprint で precedent として参照

### Phase 2 フォロー枠 (memory `project_phase_status.md` 参照)

#5 (`ops.notify.failed_in_daily_limit`) は defensive only として残置、Phase 2 で notifyOps の throw 条件を再評価 (将来 Sentry 連携で notifyOps が throw し得る形に変わる場合の備え)。

---

## Lesson 2: Discord URL invalid 化方法 — fetch reject 経路は network layer のみ

### 発見の経緯

OT が #7 trigger のため `OPS_DISCORD_WEBHOOK_URL` を「invalid 化」したが、Vercel logs に warn 0 件。Claude Code 側 fact 調査で `fetch` 仕様再確認。

### 事実

`fetch` 仕様 (Web Fetch standard、Node.js / Vercel runtime 両方):
- HTTP **4xx / 5xx は throw しない** (resolve する、`response.ok = false` で判定するが本 code は chk なし)
- catch 経路に入る = fetch promise が **reject** する条件のみ:
  - **DNS lookup fail** (host 不存在)
  - **TCP connection fail** (port refuse / 到達不能)
  - **TLS handshake fail** (cert error 等)
  - **timeout** (`AbortSignal.timeout(3000)` 超過)
  - **network unreachable**

`lib/ops.ts:51-52` のコメント:
```typescript
// Discord は 204 を返す。non-2xx も escalate しない:
// notifyOps 自身の失敗が呼び出し元を巻き込んではならない。
```

→ **non-2xx も resolve として扱う** 設計、`response.ok` chk は **無し**。

### invalid 化方法ごとの挙動 (G-6 試験で実測)

| 方法 | fetch 挙動 | #7 trigger |
|---|---|---|
| (A) Discord host + 無効 webhook id (例: `https://discord.com/api/webhooks/INVALID/INVALID`) | Discord 側 401 / 404 return、**fetch resolve** | **❌ trigger されない** |
| (B) 空文字 (`OPS_DISCORD_WEBHOOK_URL=`) | `lib/ops.ts:21` `if (!url) return` で no-op、fetch 呼ばない | **❌ trigger されない** |
| (C) **`.invalid` TLD** (例: `https://discord-test.invalid/`、RFC 6761 予約 = DNS resolver が必ず NXDOMAIN return) | **DNS lookup fail → fetch reject** | **✓ trigger される** |
| (D) 到達不能 host:port (例: `https://255.255.255.255:1/`) | TCP refuse → fetch reject | ✓ trigger される (ただし production env 経路の不可達性は環境依存) |

OT は当初 (A) を試して trigger できず、Claude Code 側 fact 提示後 (C) で trigger 成功。

### 教訓

`fetch` の reject 条件を test trigger 設計時の **必須前提** として spec / plan に明示。HTTP 4xx / 5xx で error path に入ると誤認しないこと (これは `axios` 等の wrapper library と挙動が異なる、Web Fetch standard 整合)。

production env で fetch reject を artificial 化したい場合の **canonical 手段**:
- **`.invalid` TLD** = RFC 6761 で IANA 予約、DNS resolver が必ず NXDOMAIN return、production env / preview env / local 全環境で同挙動
- 例: `https://discord-test.invalid/`、`https://anyhost.invalid/`

`response.ok` chk を logger / notifyOps 内部で追加する設計 (4xx / 5xx も catch 経路化) も Phase 2 検討候補だが、本 sprint scope 外。

---

## Lesson 3: AI 経路の test trigger は Layer 1 boundary defense が最 deterministic

### 発見の経緯

#7 trigger 候補として AI 経路の notifyOps callsite を全件調査:
- `lib/ai-usage.ts:115` (AI daily limit reach、`reserveAiGenSlot` 経由)
- `lib/gemini.ts:82 / :99` (output schema violation)
- `lib/gemini.ts:115 / :128` (output cap violation)
- `lib/gemini.ts:167` (5xx exhausted)
- `app/app/words/actions.ts:213` (**AI input cap violation**, Layer 1 boundary defense)

各経路の trigger 難易度比較で、`app/app/words/actions.ts:213` (Layer 1) が圧倒的に簡便と判明。

### Layer 1 boundary defense の特徴

`app/app/words/actions.ts:200-226`:
```typescript
const storedParse = wordSchema.pick({ word: true, meaning: true }).safeParse({
  word: w.word,
  meaning: w.meaning,
})
if (!storedParse.success) {
  ...
  await notifyOps('AI input cap violation (stored data)', { ... })
  return { ok: false, error: 'AI 例文生成に失敗しました...' }
}
```

特徴:
- **AI usage daily counter 消費なし** (Layer 1 で reserveAiGenSlot 前 reject、`lib/ai-usage.ts` 経路に到達しない)
- **Gemini API call なし** (生成しない、コストゼロ)
- **毎回確実に発火** (DB row 状態依存、UI 操作 1 回で trigger、Gemini 応答に依存しない)
- **production user 影響ゼロ** (本物の word 値を変更するのみ、後で戻す)

### Trigger 手順 (G-6 で実証)

1. test user で単語 1 個作成 (UI 経由、cap 内の値、例: word=`test`, meaning=`テスト`)
2. Neon SQL Editor で当該 row の word を 65 char に拡張 (`words.word` cap = 64):
   ```sql
   UPDATE words SET word = REPEAT('a', 65) WHERE id = '<wordId>';
   ```
3. 単語編集画面 (`/app/words/<wordId>`) で「AI 例文生成」 button 1 回 push
4. Layer 1 boundary defense → `notifyOps('AI input cap violation (stored data)', ...)` 発火
5. (Discord URL を `.invalid` TLD で fail 経路に設定済なら) fetch reject → catch → **#7 trigger**
6. 完了後 word を元に戻す (`UPDATE words SET word = 'test' WHERE id = '<wordId>';`)

### 他経路との比較

| 経路 | trigger 難易度 | 理由 |
|---|---|---|
| `app/app/words/actions.ts:213` (Layer 1) | **最楽** | DB UPDATE + button 1 click、deterministic |
| `lib/ai-usage.ts:115` (daily limit) | 中 | 11 回 (free) or 101 回 (pro) button 連打、毎 click で 1-3 秒 Gemini 呼出、コスト発生 |
| `lib/gemini.ts:82 / :99` (output schema) | 困難 | Gemini が異常応答返す確率的、artificial 化不可能 |
| `lib/gemini.ts:115 / :128` (output cap) | 困難 | 同上 |
| `lib/gemini.ts:167` (5xx exhausted) | 困難 | Gemini 5xx 連発自然発生待ち、強制 trigger 不可 |

### 教訓

AI 経路の test trigger 設計時は **Layer 1 boundary defense (zod schema check) を最優先** で選択。Gemini 応答依存経路 (output schema/cap violation / 5xx exhausted) は **artificial trigger 不可能** に近く、production 試験では使えない。daily limit 経路はコスト発生 + 時間がかかる + 副作用あり (DB row INSERT, Gemini API 利用枠消費) で次善。

DB 直接 UPDATE で artificial state を作る手法は production user 影響ゼロ (本物の word 値を一時変更、後で戻す) で安全、reset 手順 (元値復元) を spec / plan に必ず含める。

---

## まとめ (3 lessons)

1. **#5 #7 排他関係**: notifyOps が throw しない設計のため #5 (defensive only) は現状到達不能、#7 のみ trigger 可。spec / plan で「同時 trigger 可能」と書いたのは fact 誤り。brainstorming で callsite ごとの実 trigger 可能性を code 経路 trace まで確認する原則。
2. **Discord URL invalid 化**: `fetch` 4xx/5xx は throw しない (Web Fetch standard)、reject 経路は network layer のみ。`.invalid` TLD (RFC 6761) が production env での canonical fetch fail 化手段。
3. **AI 経路 trigger**: Layer 1 boundary defense (zod schema check) が最 deterministic、DB UPDATE で artificial state 化、daily counter 消費 / Gemini call ゼロ。Gemini 応答依存経路は artificial 不可能。

これらは Phase 2 以降の sprint で test trigger 設計時 / spec / plan drafting 時に precedent として参照する。
