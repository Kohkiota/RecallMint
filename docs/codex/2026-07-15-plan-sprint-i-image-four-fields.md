# Codex plan cross-check — sprint-i-image-four-fields (2026-07-15)

- **作成日**: 2026-07-15
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **target 語彙の境界**
  - 4 面の正式 target は `question_text` / `option:<id>` / `explanation_text` / `memo` に固定する必要がある。
  - OCR 側の `question` / `option_1` / `explanation` は別 namespace として扱い、混在・自動変換しない前提を明確にすべき。

- **`cards.images` は card 全体の union**
  - 画像配列は field ごとの独立状態ではなく、card 単位の flat 配列。
  - したがって gallery 追加時に field subset だけを commit する実装が入ると、他 field の画像を落とす破壊経路になる。
  - 既存 `attachImageToCard` / `removeImageFromCard` 経由の徹底が設計上の不変条件。

- **選択肢削除時の cascade は必須**
  - `option:<id>` は id ベースで安定だが、`nextOptionId` が削除済 id を再利用するため、削除済 option の画像が zombie として残ると新 option に誤紐付きする。
  - これは単なる storage leak ではなく、静かな意味破損。
  - 削除対象 option id を削除前に捕捉し、該当 target の画像を除去する必要がある。

- **cascade の失敗時 semantics**
  - 選択肢削除と画像削除のどちらを主操作とみなすかを決める必要がある。
  - 画像削除失敗で option 削除を rollback するのか、option 削除を確定して zombie リスクを warning として残すのか。
  - 非同期・best-effort にするなら、失敗時の再試行・検知・ユーザー影響を設計上認識すべき。

- **GC と zombie ref の関係**
  - GC は `asset_id` の ref 存在で生存判定するため、zombie ref がある限り asset は消えない。
  - cascade は UI 表示破損だけでなく GC 延命も閉じるために必要。
  - 逆に ref 削除後の blob / remote asset reclaim がどこまで同期的に保証されるかは分けて考える必要がある。

- **学習面表示は機能要件**
  - 編集で question / option / explanation に画像を付けられても、学習面に出ないならユーザー体験として破綻する。
  - memo は学習非表示でよいが、question / option / explanation は read-only 表示対象。
  - explanation は「テキストなし・画像あり」でも section を表示する条件が必要。

- **選択肢 UI の行高・仮想化影響**
  - option 数に比例して gallery が増えるため、空状態 UI の高さが Sprint F の仮想化・scroll jitter に影響しうる。
  - 選択肢のみ compact にし、画像がある行だけ thumbnail 高を持つ設計は妥当だが、測定更新・レイアウト安定性の確認が必要。

- **上限数の解釈**
  - 既存 `MAX_IMAGES_PER_CARD = 10` が card 全体上限なら、4 面化後も field ごとではなく合計上限であることを UI / test / エラー表示で一貫させる必要がある。
  - 4 面化により「各欄に数枚ずつ」の期待と衝突する可能性はある。

- **validation widen の範囲**
  - 共有 schema の refine widen だけで server/client 双方に効く前提は重要。
  - legacy passthrough の扱い、UUID key のみ strict validation される境界を壊さないこと。

- **read-only gallery の安全性**
  - 学習面では attach/remove UI が出ないこと。
  - option の選択 button 内に interactive gallery を入れないこと。
  - 画像だけで explanation section が表示される場合のアクセシビリティ・余白・答え合わせ状態との関係も確認対象。

- **既存データ・migration**
  - `field_key` が自由 text で migration 不要という判断は妥当。
  - zero-user 前提で移行不要だが、既存 `question_text` 実データの互換は維持する必要がある。

- **テストで pin すべき破損ベクタ**
  - 序数ずれではなく、id 再利用による zombie 誤紐付きが実在ベクタ。
  - cascade neuter で red になるテストが必要。
  - union 非破壊、他 target 温存、legacy 非 UUID entry 温存も重要。

## plan ドラフトへの抜け・未考慮指摘

- **cascade の失敗後に残る破損 window の扱いが弱い**
  - plan は best-effort + warn としているが、失敗した場合は zombie が残り、同 id 再利用時の誤紐付き window が残る。
  - 「残置 zombie は次回同 id 削除時の再 cascade または手動削除」とあるが、新 option 追加時点で誤表示されうる点への対策がない。
  - 少なくとも失敗時に UI 上の再試行、対象 key の記録、次回 card load 時の self-heal、または add option 前の stale target cleanup を検討対象にすべき。

- **cascade 実装の二重 reclaim が曖昧**
  - spec では既存 `removeImageFromCard` は reclaim 内蔵とされている。
  - plan W1 では `removeImageFromCard` 後に `reclaimLocalAssetBlobs(userId, keys)` を fire-and-forget すると書いており、責務重複の可能性がある。
  - 既存関数の reclaim semantics を前提に、追加 reclaim が必要かを明確化すべき。

- **W1 で `userId` 透過が必要になる設計の副作用**
  - hook 引数に `userId` を追加するため、呼び出し元すべての追随が必要。
  - plan は主要 files を挙げているが、他 caller の有無、test wrapper、mock 更新の確認観点が不足している。

- **fire-and-forget async と test determinism**
  - option 削除 commit 後に cascade を非同期実行する設計だが、テストでどの await point をもって cascade 完了とみなすかが未記載。
  - fake timers / promise flush / Dexie transaction 完了待ちなど、非同期安定化の方針が必要。

- **複数画像 cascade の部分失敗**
  - `option:<id>` に複数画像がある場合、1 件成功・1 件失敗の状態がありうる。
  - plan は reject の warn 継続を述べるが、直列処理か `Promise.allSettled` か、部分成功時のログ粒度・再試行可能性が未整理。

- **競合更新の扱い**
  - 削除直後に別 UI 操作で画像 attach/remove が走る場合、`removeImageFromCard` の fresh read/write と per-card 直列化に依存する。
  - plan は per-card 直列化に触れているが、option delete commit と image remove commit の順序・競合時の最終状態の期待が明文化されていない。

- **`MAX_IMAGES_PER_CARD = 10` の UX**
  - 全体上限維持は記載されているが、4 面化後に option 画像を追加しようとして上限に当たる場合の表示や affordance の期待が未記載。
  - field ごと上限を作らない判断自体はあり得るが、ユーザーにどの単位の上限なのか伝わるかは未考慮。

- **compact UI のアクセシビリティ確認が薄い**
  - `aria-label` はあるが、複数 option に同じ「画像を追加」ボタンが並ぶ。
  - スクリーンリーダー上で「どの選択肢の画像追加か」が区別できるかは未検討。
  - 例: `aria-label={`選択肢 ${label} に画像を追加`}` のような文脈付けを検討。

- **read-only option gallery の配置による選択肢クリック領域**
  - button 外に置く判断は正しいが、画像クリックが選択動作と独立するのか、選択肢行全体の見た目と操作期待がどうなるかは plan では浅い。
  - 画像が選択肢の一部に見えるなら、クリック時の選択挙動との整合を確認すべき。

- **学習面での option 画像表示タイミング**
  - 「解く」時から option 画像を表示するのは要件上妥当だが、正誤表示後の layout shift、選択状態、disabled 状態との相互作用が未記載。
  - 仮に answer reveal 前後で DOM が変わるなら snapshot / interaction test が必要。

- **session doc / review / commit 手順が実装計画に強く混入**
  - 実装 worker 向けには必要かもしれないが、設計 plan としてはプロセス記述が多く、設計上の invariant や failure mode が埋もれやすい。
  - 特に W1 の失敗時 semantics はプロセスより重要なので、設計判断として前面に出した方がよい。

## リスク / 対立しうる設計判断

- **cascade best-effort vs 強整合**
  - best-effort は option 削除 UX を止めない一方、失敗時に zombie 誤紐付きリスクが残る。
  - 強整合にすると破損 window は閉じやすいが、画像削除失敗で option 削除が失敗する UX になる。

- **id 再利用維持 vs 非再利用化**
  - id 再利用維持は `a,b,c` などの表示語彙が自然。
  - 非再利用化は zombie 誤紐付きを別方向から避けられるが、穴あき表示や既存 UI 語彙への影響が大きい。
  - 今回は cascade 採用が妥当だが、cascade 失敗時の window は残る。

- **card 全体画像上限 vs field 別上限**
  - 全体上限は既存仕様に近く実装も単純。
  - field 別上限はユーザー期待に近い可能性があるが、保存・validation・UX の設計面が増える。

- **選択肢 compact UI vs 常時 gallery**
  - compact は仮想化・行高リスクを抑える。
  - 一方で画像追加 affordance が小さくなり、発見性・アクセシビリティが下がる可能性がある。

- **学習面 W4 を同 sprint に含める vs 分離**
  - 同 sprint に含めると体験として完結する。
  - 分離すると実装リスクは減るが、「付けた画像が学習で見えない」期間が発生するため、機能として不完全。

- **field name 一致 target vs OCR 語彙寄せ**
  - `explanation_text` / `memo` は既存 field と一致して保守しやすい。
  - OCR 語彙に寄せると別 namespace との混同が起きやすく、今回の asset refs とは分ける判断が妥当。