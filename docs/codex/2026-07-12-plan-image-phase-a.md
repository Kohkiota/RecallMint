# Codex plan cross-check — image-phase-a (2026-07-12)

- **作成日**: 2026-07-12
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **asset 参照の恒久 invariant**
  - `cards.images` は assetId のみ保存し、URL を DB / Dexie / DOM 永続値に残さない防衛が必要。
  - UUID key と非 UUID legacy OCR entry の判別は、将来の key 形式拡張時に壊れやすい。UUIDv4 固定の検証範囲を明確にする必要がある。

- **server 最終防衛**
  - client gate だけでは不十分で、server handler が「自 user の ready asset のみ参照可能」を必ず検証する必要がある。
  - `url` 非空 reject は migration 的にも重要。既存データに `url` が存在する可能性があるなら、reject 対象を新規 mutation に限定できるか確認が要る。

- **upload saga の失敗状態**
  - reserve 後、PUT / finalize / tab close / presign expiry / retry / abandon の各状態遷移が複雑。
  - 特に re-reserve 時に旧 assetId を mirror / cache / Dexie / outbox からどう置換・掃除するかが事故点。
  - reserved orphan は無害とするが、運用上の増加監視や手動掃除手順は別途必要。

- **flush gate と coalesce**
  - gate は最新 mutation value を見る必要がある。
  - `uploading` のみ block、local unknown key は block しない、`failed` は block しない、という区別は重要。
  - 画像削除や abandon と同時に別タブで編集された場合、最終 images 配列の勝ち方を確認すべき。

- **client local state の user scope**
  - Cache API key と Dexie row の userId namespace は必須。
  - logout / user switch / shared browser で、旧 user の objectURL Map や cache hit が混ざらない設計が必要。

- **objectURL lifecycle**
  - `URL.createObjectURL` の再利用・revoke 方針が必要。
  - assetId だけで Map すると userId を跨ぐ衝突リスクがあるため、Map key も userId+assetId が望ましい。

- **Cache API の耐久性**
  - Cache は消えうる前提なので miss 経路は常に動く必要がある。
  - `navigator.storage.persist()` は保証ではないため、一括 DL 済み表示をどこまで信用するかを明確にする必要がある。

- **一括 DL の all-or-nothing**
  - 失敗時に「当該 job 追加分のみ」削除するには、added_asset_ids の更新タイミングが重要。
  - fetch 成功後 Cache put 前後でクラッシュした場合、sweep が正しく追加分だけ掃除できるか要確認。
  - 既存キャッシュと今回追加キャッシュの境界が最重要。

- **R2 presigned PUT/GET**
  - PUT は Content-Type 署名固定が必要。
  - finalize は HEAD の Content-Length 検証が核だが、Content-Length 不在 fallback を許すなら、size 一致保証が弱まる。
  - CORS は PUT / GET / HEAD / preflight の実要件を再確認すべき。spec は PUT+GET を明記しているが finalize HEAD は server-side なので browser CORS 不要。ただし実装の誤配線で client HEAD しないこと。

- **MIME / byte validation**
  - canvas decode → re-encode 前提なら server sniff 省略は成立する。
  - ただし Safari PNG fallback、透明 PNG、巨大画像、壊れた EXIF、animated WebP/GIF 的入力の扱いはテスト対象にしたい。
  - `file.type` と拡張子の AND 条件は、OS/browser によって空 MIME になるケースを reject する判断でよいか確認が要る。

- **画像 dimensions**
  - width / height は layout shift 回避に使うため、圧縮後 blob から測るべき。
  - EXIF orientation 適用後の寸法になっているか確認が必要。

- **UI 表示範囲**
  - Phase A は target 単位 gallery で、inline marker はやらない。
  - 学習ビュー read-only gallery を含めるなら、一括 DL の価値と整合する。
  - legacy OCR entry は非描画なので、既存 images があるのに何も出ないケースの UX が必要か検討余地あり。

- **同期対象の境界**
  - assets は pull 同期非対象、cards.images だけが同期対象。
  - 別 device で ready asset が参照された card を pull した場合、local media_assets row が無いまま表示 miss→resolve できる必要がある。

- **authorization / ownership**
  - reserve / finalize / resolve / images handler すべて user scope が必須。
  - finalize は assetId owner 確認だけでなく object_key が当該 asset row と一致していることが重要。

- **DB schema / constraints**
  - `status` が text の場合、DB check constraint を入れないなら application invariant 依存になる。
  - `mime` も text なので check constraint を入れるか、アプリ検証のみでよいか判断が必要。
  - `byte_size integer` は 5MB cap なら十分だが、将来拡張時は注意。

- **ops / observability**
  - orphan reserved / ready orphan / R2 object 残置を許容するなら、手動 SQL と R2 prefix 削除手順が必要。
  - 失敗率、reserve-to-ready 滞留、HEAD mismatch、resolve miss などの最低限ログ設計が欲しい。

## plan ドラフトへの抜け・未考慮指摘

- **objectURL Map の namespace**
  - Task 9 が「assetId 単位に再利用」と書いているが、主入力の userId namespace 原則からは `userId+assetId` 単位が安全。user switch 時の revoke / clear も明記不足。

- **CORS 前提の記述がやや不足**
  - ops 前提は PUT+GET だが、実際の browser PUT では `Content-Type` header と preflight 許可 header が重要。allowed headers / exposed headers まで smoke 前提に含めた方がよい。

- **HEAD fallback が spec より弱い**
  - plan の参照事実で「Content-Length が無い場合は実在確認のみ」としている。主入力では finalize HEAD で byte_size 一致検証が核なので、fallback を入れるならリスクとして明示し、テストも「弱化を許容する理由」を固定すべき。

- **DB check constraints の扱いが未記載**
  - `assets.status` / `assets.mime` を DB check で縛るか、アプリ層のみかが plan にない。text 列のままなら、意図的に check なしと書いた方がよい。

- **既存 `cards.images.url` データへの影響確認がない**
  - server handler が url 非空 reject する前提だが、既存 OCR / import データに `url` が入っている可能性の調査・移行判断が plan にない。

- **file.type 空文字ケース**
  - Task 8 は MIME gate を書いているが、主入力では MIME + 拡張子チェック。ブラウザによって `file.type === ''` の場合にどう扱うか、テストケースが不足。

- **re-reserve の詳細が薄い**
  - Task 8 に「期限切れは re-reserve」とあるが、旧 assetId の mirror entry 差し替え、old cache / media_assets 削除、旧 reserved orphan の扱いが完了条件に明示されていない。

- **multi-tab 同時 upload / abandon の競合**
  - sweep と deck download は Web Lock があるが、attach / abandon 自体の同時実行、同じ card images の concurrent optimistic update の競合観点が薄い。

- **logout / user switch cleanup**
  - Cache key は userId namespace だが、in-memory objectURL、pending UI state、download job 表示の user switch 時の扱いが plan にない。

- **dimension / EXIF orientation の検証**
  - 圧縮後 width/height を測ることはあるが、orientation 適用後の寸法であること、Safari PNG fallback で寸法が正しいことのテストが不足。

- **学習ビューへの images 供給経路**
  - Task 11 は「未載なら供給元に追加」としているが、session payload / mapper / type propagation のどこが境界か未確定。ここは実装時に広がりやすい。

- **一括 DL の crash consistency**
  - Task 12 は rollback を書いているが、Cache put 成功後・job row added_asset_ids 更新前に tab close した場合の扱いが明確でない。sweep で掃除できない追加分が出る可能性がある。

- **observability / manual ops**
  - orphan 掃除が手動前提なのに、plan に手動 SQL 例、R2 prefix 削除手順、確認クエリ、ログ観点がない。

- **security regression tests**
  - resolve の cross-user assetId、finalize の cross-user assetId、images handler の他 user ready asset 参照などは Task 4/5 に含まれるが、明示的に「他 user ready asset でも reject」を書くとよい。

## リスク / 対立しうる設計判断

- **DB constraint vs app invariant**
  - check constraint を増やすと DB 防衛は強くなるが、migration / 将来拡張は硬くなる。アプリ層のみだと実装バグで不正 row が入りうる。

- **HEAD Content-Length 厳格必須 vs fallback 許容**
  - 厳格にすると finalize 失敗が増える可能性がある。
  - fallback を許すと byte_size 一致保証が弱まり、spec の安全性が下がる。

- **添付オンライン限定 vs offline queue**
  - 今回の仕様は reserve 失敗時に何も書かないため単純。
  - offline 添付を許す設計にすると local-first 体験は良くなるが、assetId 発行・後続同期が大幅に複雑化する。

- **reserved orphan 許容 vs 自動掃除**
  - 許容すれば MVP は単純。
  - 自動掃除しない場合、長期運用で台帳と R2 の残骸が増える。手動運用の現実性がリスク。

- **Safari PNG fallback 維持 vs WASM/server transcode**
  - fallback は実装が軽い。
  - PNG はサイズが膨らみやすく、5MB cap や Cache 容量に効く。将来の圧縮品質要求と対立しうる。

- **all-or-nothing DL vs partial success**
  - all-or-nothing はユーザー説明が明快。
  - 大量画像では 1 件失敗で全追加分破棄になり、体験が悪い可能性がある。

- **asset 残置 vs reference counting**
  - 削除時に asset/R2 を残すのは同期競合に強い。
  - ストレージ残骸は増える。`reference_count` を dormant にする判断は妥当だが、いつ有効化するか未定。

- **legacy non-UUID passthrough**
  - 既存データを壊さない利点がある。
  - 非 UUID entry の target / url / alt が不正でも通る可能性があり、将来の UI や export で扱いが曖昧になる。