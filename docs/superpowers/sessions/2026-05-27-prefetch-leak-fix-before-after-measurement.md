# prefetch 漏れ修正 前後計測 session log

- 実施日: 2026-05-27
- 種別: session log / stg perf 計測
- 対象 commit: `a261f8e chore(perf): (app) dynamic page への Link 7 箇所に prefetch={false} 追加 [reviewed]`
- 計測 environment: stg.recallmint.nekotest.net、 Playwright MCP、 同一 test user (komail9server+001)、 DevTools Network「Disable cache」 OFF、 各 metric 3 回計測の中央値
- 関連 brief: cache-fix roadmap §④-2 / 前後計測 task
- 結論: **主目的 prefetch 抑制 PASS、 副次 click 時系列に regression なし (= 機能変更ゼロ確認)**

---

## 結論サマリ

`a261f8e` の prefetch={false} 7 箇所追加で、 当該 link の **viewport 並列 prefetch
が期待通り完全抑制された**。 副次 click (dashboard / exams / smart 主要 nav)
の click→URL/content 時系列は baseline と同等 (regression なし、 ノイズ範囲で
軽い改善傾向)、 = 機能変更ゼロ + perf hygiene 達成。

---

## 1. 計測結果 (push 前 vs push 後、 3 回中央値)

### 1.1 prefetch count (主目的 metric)

| metric | push 前 (baseline) | push 後 | 差分 | 判定 |
|---|---|---|---|---|
| #6 `/pricing` 並列 RSC prefetch count | **8** (/, /sign-in, /sign-up, **/app/upgrade**, /contact, /terms, /privacy, /legal) | **7** (= /app/upgrade 消失、 他 7 link は維持) | -1 件 | **PASS** |
| #6 `/app/upgrade` prefetch duration | 1020 ms | n/a (prefetch 発生せず) | -100% | **PASS** |
| #M-1 `/app/exams/[id]` back link prefetch count | **1** (/app/exams) | **0** (空配列) | -1 件 | **PASS** |
| #M-1 `/app/exams` prefetch duration | 519 ms | n/a (prefetch 発生せず) | -100% | **PASS** |

**raw data**:

```
#6 /pricing baseline (3 回):
  1: count=8, /app/upgrade 1133ms
  2: count=8, /app/upgrade 1020ms
  3: count=8, /app/upgrade  944ms
#6 /pricing push 後 (3 回):
  1: count=7, /app/upgrade なし
  2: count=7, /app/upgrade なし
  3: count=7, /app/upgrade なし

#M-1 /app/exams/[id] baseline (3 回):
  1: count=1, /app/exams 364ms
  2: count=1, /app/exams 519ms
  3: count=1, /app/exams 538ms
#M-1 /app/exams/[id] push 後 (3 回):
  1: count=0
  2: count=0
  3: count=0
```

### 1.2 副次 click 時系列 (= 機能変更ゼロ確認 metric)

各 click を 3 回、 click→URL / URL→content / click→content の中央値 (ms):

| click 経路 | push 前 (URL / content / total) | push 後 (URL / content / total) | total 差分 |
|---|---|---|---|
| /app → /app/exams | 433 / 451 / **881** | 391 / 456 / **846** | -35 (-4.0%) |
| /app → /app/study/smart | 543 / 1328 / **1871** | 520 / 1349 / **1868** | -3 (-0.2%) |
| /app/exams → /app/exams/[id] | 534 / 886 / **1419** | 434 / 890 / **1323** | -96 (-6.8%) |

**判定**: 3 経路すべて total 時間が **減少 or 同等 (ノイズ範囲内)**、 **regression なし**。
S-perf-1 時点で header / dashboard CTA 等の主要 click 経路は既に prefetch=false 化
済のため、 今回追加の 7 箇所 (empty UI / 結果画面 / pricing CTA / back link) は
主要 click 自身は touched なし。 軽い改善傾向は viewport 並列 prefetch の
server 負荷削減による副次効果と推察 (ノイズ範囲内、 強い主張ではない)。

**raw data (副次 click)**:

```
/app → /app/exams baseline (3 回): [409/470/879, 433/447/881, 529/451/979]
/app → /app/exams push 後 (3 回): [837/1732/2569(cold), 391/453/844, 390/456/846]

/app → /app/study/smart baseline (3 回): [817/1571/2387, 534/1328/1861, 543/1328/1871]
/app → /app/study/smart push 後 (3 回): [778/1595/2373(cold), 520/1348/1868, 392/1349/1742]

/app/exams → /app/exams/[id] baseline (3 回): [402/883/1285, 541/904/1445, 534/886/1419]
/app/exams → /app/exams/[id] push 後 (3 回): [601/890/1492, 380/903/1284, 434/889/1323]
```

push 後計測の第 1 回は Vercel build 反映直後の **cold start** (Function 初回
warm-up) を含む外れ値、 中央値で吸収済。 これは S-perf-2 計測時と同型の挙動。

---

## 2. 結論判定

| 観点 | 判定 | 根拠 |
|---|---|---|
| 主目的: 7 file の prefetch={false} 追加で並列 prefetch が抑制されたか | **PASS** | #6 /app/upgrade と #M-1 back link、 両方とも prefetch が完全消失 (1 → 0 / 8 → 7) |
| 副次: 機能変更ゼロが維持されたか | **PASS** | 主要 click 3 経路すべて regression なし (ノイズ範囲内で軽い改善傾向) |

= **PASS**、 production deploy 可。 main は既に ff merge + OT push 済、 Vercel
production deploy は OT 手動で実施可能。

---

## 3. Skip した metric (brief 「再現難なら skip 可」)

| # | 対象 | skip 理由 |
|---|---|---|
| 1 | /app/upload isProcessing 状態 (/app/exams CTA) | OCR 実行中 = 課金回避必要、 stg で意図再現困難。 prop 追加は機能変更ゼロのため実機計測 skip でも副作用リスクなし |
| 2 | /app/study/smart empty UI (/app CTA) | test user は exam 1 + card 4 件保有のため Dexie + server 両方 0 件 を意図再現困難 |
| 3 | /app/exams exam 0 件 empty UI (/app/upload CTA) | 既存 exam 全削除 = data 損失、 brief 明示「skip 可」 |
| 4 | /app/exams/[id] card 0 件 empty UI (/app/upload CTA) | 既存 card 全削除 = data 損失、 brief 明示「skip 可」 |
| 5 | /app/upload/result/[sourceDocumentId] (/app/exams CTA) | OCR 直後画面 = 課金 + sourceDocumentId 不明、 brief 明示「skip 可」 |

**skip 妥当性**: prefetch={false} は機能変更ゼロの prop 追加で、 syntax / type
安全性は typecheck で verify 済、 review (Critical 0 / Important 0) も pass
済。 実機計測 skip による regression risk なし。 #6 + #M-1 の代表 2 件で実機
verify、 残り 5 件は code level + typecheck で sufficient と判断。

---

## 4. 計測完了条件 (brief 準拠)

- [x] 差分表 (push 前 vs 後、 prefetch count + click 時系列) を §1 で記載
- [x] PASS/部分 PASS/FAIL 判定 + 根拠を §2 で記載 → **PASS**
- [x] skip 項目 + skip 理由を §3 で記載
- [x] 1 commit (`docs(perf): prefetch leak fix の前後計測 [no-review]`) で本 session log を保存予定 (本 commit で実施)

---

## 5. やらないこと (brief 遵守)

- 計測 fail を理由にした実装 revert: **未実施** (= 計測 PASS、 revert 不要)
- 7 file 以外の link への調査拡大: 未実施 (M-2 / M-3 follow-up は `2026-05-27-prefetch-leak-audit.md` で記録のみ)
- LocalSync MVP / cache-fix Step 3 以降: 未実施
- production 計測: 未実施 (stg only、 brief 遵守)
