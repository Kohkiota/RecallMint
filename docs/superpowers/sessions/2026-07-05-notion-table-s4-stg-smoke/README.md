# S4 テキストフィルタ — stg smoke 結果(全7項目 PASS)

- 実施: 2026-07-05 / stg.recallmint.nekotest.net / Playwright MCP(chrome-devtools は Target closed で fallback)
- 対象 exam: `[PERF-SEED] 300-card exam`(fb10b7cf-6044-4155-ae76-a0094800f5f3)= 300 card。テーブルビュー既定。
- seed 特性: title/sort_key/question_text = 全 populated、explanation_text/memo = 全 null(未入力系検証に最適)。sort_key = "0001".."0300" ゼロ埋め。
- 総数 oracle = 全選択 →「N件選択中」(仮想化で DOM 行は最大7ゆえ、大件数は選択件数で確認)。

## 結果: 全 7 項目 PASS / console 0 errors

### ① 5列 header menu からフィルタ追加 + 非 sortable 列の filter-only menu — PASS
- タイトル(sortable): sort 節(昇順/降順)+ filter 節、演算子8種・デフォルト「を含む」。
- ソートキー(sortable・要列表示 ON): sort 節 + filter 節両方。
- 問題文 / 解説 / メモ(非 sortable): **filter-only menu**(昇順/降順ボタンなし・sort glyph なし)・デフォルト「を含む」・値欄あり。Esc で popover 閉(chip=フィルタは保持)。focus 自然。

### ② 8演算子の絞り込み(nullable 列の未入力系含む)— PASS
| 演算子 | 検証 | 結果 |
|---|---|---|
| と一致(eq) | タイトル「PERF-SEED カード 0300」/「0300」 | 1件 / 0件(部分一致でない) |
| と一致しない(neq) | タイトル「PERF-SEED カード 0300」 | 299件 |
| を含む(contains) | タイトル「0300」/ 問題文「No.300」 | 1件 / 1件 |
| を含まない(notContains) | 問題文「No.300」 | 299件 |
| で始まる(startsWith) | タイトル「PERF-SEED カード 02」 | 100件(0200-0299) |
| で終わる(endsWith) | タイトル「00」/ ソートキー「50」 | 3件(0100/0200/0300)/ 3件(0050/0150/0250) |
| 未入力(empty) | メモ / 解説 | 300件 / 300件(全 null) |
| 未入力ではない(notEmpty) | メモ / ソートキー | 0件 / 300件 |

### ③ 大文字小文字非区別 — PASS
- タイトル「perf-seed カード 0300」(小文字)→ 大文字格納「PERF-SEED カード 0300」に 1件マッチ(case-sensitive なら 0)。

### ④ chip 再編集・値なし演算子切替で入力欄消滅 — PASS
- 演算子「未入力」選択 → 値入力欄が非表示・chip「タイトル: 未入力」(値部なし)。
- 「未入力」→「を含む」に戻すと入力欄再表示 + **mount 中の入力値「0300」を復元**(D-5 local 保持)。
- chip 本体クリックで editor 再開・状態復元(op=neq, 値="PERF-SEED カード 0300")、再編集の変更が絞り込みに反映(を含む「0150」→ 1件)。

### ⑤ chip 個別×・クリア全消し — PASS
- sort chip の×で sort のみ除去・text filter chip 残存。
- クリアで全 chip・全 filter dot 消去(chip 0 / dot 0)。

### ⑥ S3ソート・タグフィルタとの併用 — PASS
- テキスト(タイトル で始まる「PERF-SEED カード 01」= 100件)+ 連続正解数 降順ソート共存 → 2 zone chip・streak 降順(10,10,10,9,9)でフィルタ後もソート適用。
- テキスト + タグフィルタ(難易度: 難)共存 → 2 filter chip・AND 絞り込み = 14件。
- S3-2 H-1 nested popover(ColumnHeaderMenu 内 CardTagAddPopover): dialogCount=2 で両開・DismissableLayerBranch 正常(タグ category → option 選択が機能)。

### ⑦ 300-card keystroke 毎の再評価体感 — PASS
- 問題文フィルタ連続入力(N→No→No.→No.2→No.20→No.200)の同期再評価: 6.1 / 8.1 / 5.1 / 20.8 / 16.3 / 2.8 ms(ほぼ 1 フレーム未満・最大 20.8ms)。ラグなし。「No.200」で 1件に即絞り込み。

## console
- 全 smoke 通じ **0 errors**。warning は環境由来のみ(Permissions-Policy 未認識ヘッダ / Clerk dev key)= S4 非関連。

## 証拠
- `s4-smoke-01-title-contains.png`(タイトル を含む 0300 = 1行 + chip + dot)
- `s4-smoke-final-question-filter.png`(問題文 を含む No.200 = 1行)
- Playwright snapshot 群 `.playwright-mcp/`(s4-title-menu.yml / s4-tag-popover.yml 等)

## 結論
全7項目 PASS。Critical/Important 相当の不具合なし。fail による停止・OT 報告事項なし。
