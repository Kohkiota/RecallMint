# ②-4a S-4 着手前提: Vercel Dashboard 確認結果(OT 実施・2026-08-05)

plan `docs/superpowers/plans/2026-08-04-ocr-2-4a-single-invocation.md` の Task S-4 は「OT の Vercel Dashboard 確認結果を受領していること」を着手 gate としていた(spec §7 冒頭・値は spec に書かない方針)。本 doc がその受領記録。

## 確認結果

| 項目 | 値 |
|---|---|
| Fluid Compute | **Enabled** |
| メモリ / CPU | **2 GB / 1 vCPU**(Function CPU: Standard) |
| Default Max Duration(project 既定) | **800s** |
| **`/app/upload` の実効 Max Duration** | **720s** |
| runtime | Node.js 24.x |

## 判定

1. **メモリ前提は成立**。spec §4.7 のメモリ見積り(原本 ≤4MB + base64 ≈5.5MB + 逐次 decode 1 枚 ≈16.8MB / guard 上限でも ≈160MB = peak 数十〜200MB)は **2 GB 割当**に対し十分な余裕がある。S-2 の実測(decode 7.2ms/枚・40 枚で 289ms)と合わせ、逐次 decode 方針を変える理由はない。

2. **route segment config による上書きが実機で実証された**。他ルートが全て ≤800s(project 既定)である中、`/app/upload` のみ **≤720s** で Functions 一覧に出ている。これは plan の設計決着「Dashboard 値は既定であり route segment config が上書きする / Server Action は呼出元 page の config を継承する」(公式 doc 準拠)が**実際にその通り効いている**ことの確認であり、S-1 で入れた drift pin test(値 720 + 行の存在 + `maxDuration*1000 + 180_000 <= LEASE_TTL_MS`)が守っている対象が実在することを意味する。

3. **`after()` の実行余地**: `after()` の実行時間上限は route の maxDuration に従う(公式 doc・追加枠なし)ため、S-4 の pipeline は **720s 枠内**で完了する必要がある。統合予算 `UPLOAD_PIPELINE_BUDGET_MS = 660_000`(暫定)は 60s の margin を残す設計で、S-2 で入れた retry 打ち切り(残余 < `GEMINI_TIMEOUT_MS` で次 attempt を開始しない)がこの枠を保証する。

## 付随所見(記録のみ・本 task の作業ではない)

**~300 秒で関数が消えた未解明事象**(`docs/superpowers/sessions/2026-08-02-ocr-2-4a-cutover-review.md:97` / observe-close 済)について、**Fluid Compute が有効かつ maxDuration が設定済み**であることが確認できたため、根因の候補から「**設定由来**(Fluid 無効 / Default Max Duration が短い)」は外れる。

→ **S-4 の stg 実測で再観測されたら停止して OT に上げる**(自走継続条件の「不変の停止理由」ではないが、根因が設定外にある以上、再観測は新規事象として扱う)。
