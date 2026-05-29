# 異常 A fix (7f5e8a8) 再 smoke — 手動作成フロー end-to-end

- 日時: 2026-05-29 (14:50〜15:05 GMT)
- 種別: session log / stg smoke (実装変更・commit なし、 結果 doc のみ)
- 対象 stg: `https://stg.recallmint.nekotest.net` (fix deploy **`dpl_5sureeX2vGdTauTtPCn9AdWxXq4H`**、 origin/develop `7f5e8a8` 反映済)
- 対象 fix: `fix(exams): 0 件試験でも「＋ カードを追加」を表示` (7f5e8a8)
- account: `komail9server+001@gmail.com` (既存 Clerk セッション、 2FA hand-off 不要)
- 手段: chrome-devtools MCP + DevTools Network
- **結論: 異常 A は修正確認。 手動作成フロー (空試験作成 → カード追加 → inline で内容を埋める → 複数追加) が end-to-end で成立。 smoke PASS。 1 点 観測注記 (初回追加の in-place 反映が deploy 切替直後の 1 回だけ遅延、 2 回目以降は正常)。**

> 註: smoke 開始直後は cache 由来で旧 deploy `dpl_FEACJ8...` (fix 前) が配信され add ボタンが出なかった。 hard reload で fix deploy `dpl_5sureeX2...` に切替後、 以降の検証を実施。

---

## 検証結果 (主眼: end-to-end 成立)

| # | 観点 | 結果 |
| --- | --- | --- |
| 1 | 空の手動試験作成 | ✅ 「手動で試験を作成」→「Smoke手動フロー検証B」→ `/app/exams/9c5b8ced-...` 詳細遷移、 「カード (0 件)」 |
| 2 | **0 件で「＋ カードを追加」表示 (fix の主眼)** | ✅ 0 件詳細に **「カード (0 件)」 + 空ヒント「この試験にはまだカードがありません。」 + 「アップロードから追加」link + 「＋ カードを追加」ボタン** が共存表示 |
| 3 | 追加 → autoEdit / cardCount | ✅ 追加で card 作成 (createCard `{ok:true, cardId:7afcbf23...}`、 x-vercel-id `hnd1::hnd1`)。 cardCount **0→1→2**。 2 枚目追加時に **問題文セルが autoEdit (focus)** を確認。 placeholder: title「新規カード 1」/ sortKey「1」/「(問題文を入力してください)」/ 選択肢 1 件 |
| 4 | inline 編集で実際に埋める | ✅ 問題文・選択肢本文・正解 (checkbox) を inline 編集 → 「○ 正解: 1」 表示。 **reload 後も全て persist** (問題文「手動作成カードの問題文（smoke検証）…」/「選択肢A（正解）」/「○ 正解: 1」) |
| 5 | 複数枚追加 | ✅ 0→1→2 で 2 枚を手動追加 |
| 6 | 非回帰 (OCR 試験) | ✅ 39 件 OCR 試験: 「カード (39 件)」、 add ボタン present、 問題文セル 39・正解サマリ 31 描画、 **空ヒントは非表示 (0 件時のみ表示の条件が正しい)**。 既存 inline 編集 cell も従来通り |

cleanup: 「Smoke手動フロー検証B」(2 件) を削除 → 一覧から消滅 (差し引きゼロ、 OCR 2 試験のみに復帰)。 多 card (2 件) 試験削除も兼ねた (tombstone exam 1 + card 2 = 3 行が記録されるはず、 OT DB 検証用)。

---

## 観測注記 (非ブロッキング)

### 初回カード追加 (0→1) の in-place 反映遅延 — deploy 切替直後の 1 回のみ

- 事象: 0 件試験で「＋ カードを追加」 → createCard は **`{ok:true, cardId}` 成功** (server で card 作成・永続を reload で確認) したが、 **in-place の `router.refresh()` が UI に反映されず、 詳細が「カード (0 件)」 のまま** (hard reload で「カード (1 件)」 表示)。 この時 autoEdit も in-place で開かなかった。
- 2 回目追加 (1→2) は **in-place で「カード (2 件)」 + autoEdit 正常**。 3 回目以降も同様の想定。
- 状況: 初回追加は **本 session 中に deploy が `dpl_FEACJ8` → `dpl_5sureeX2` に切替わった直後**で、 詳細 route の Full Route Cache 温まり / RSC 取得が旧状態を返した可能性が高い。 createCard は `revalidatePath('/app/exams')` (一覧) は打つが詳細 path は router.refresh 任せのため、 deploy 切替直後の cache miss/stale が重なると初回だけ反映が遅れたと推定。
- 判定: **非ブロッキング (card は確実に作成・永続、 2 回目以降は正常)**。 deploy 切替の transient artifact と見られ、 単独再現せず。 → OT は clean session (deploy 安定後) で「空試験 → 初回追加で即 autoEdit が開くか」 を 1 度確認推奨。 もし安定 deploy でも初回反映が遅れるなら、 createCard に詳細 path の revalidate を足す follow-up を検討 (今回の fix とは別軸)。

判断必要: no (smoke PASS、 上記は注記)。

---

## end-to-end 成立の結論

**異常 A は修正済**: 0 件の手動試験に「＋ カードを追加」 が表示され、 **空試験 → 手動でカード追加 → inline で問題文/選択肢/正解を埋める → 複数枚追加** という手動作成フローが OCR レスで end-to-end 成立することを stg 実機で確認した。 既存 OCR 試験の挙動も非回帰。

## 計測識別子

| 軸 | 値 |
| --- | --- |
| fix deploy | `dpl_5sureeX2vGdTauTtPCn9AdWxXq4H` |
| createCard x-vercel-id | `hnd1::hnd1::pxwpz-1780066671482-3a2d0535e429` |
| smoke 試験 (作成→削除) | `9c5b8ced-e8ab-4ad3-89db-c16cc48b0297` (Smoke手動フロー検証B、 2 card) |
| 1 枚目 cardId | `7afcbf23-1af0-4a1b-bd59-1c4bf2050857` |
| dbUserId | `1231f42d-9c9f-4edb-addd-104890193571` |
