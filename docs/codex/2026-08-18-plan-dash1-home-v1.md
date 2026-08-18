# Codex plan cross-check — dash1-home-v1 (2026-08-18)

- **作成日**: 2026-08-18
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

### 選択中試験

- 「URL 正」が成立する範囲を明確にする必要がある。保存値や単一試験から選んだ後に URL を補完するだけでなく、無効な `exam`、削除済み ID、別 owner の IDを URL から除去する契約が必要。
- mirror の初回同期完了前と、本当に試験が 0 件である状態を区別する明示的な同期状態が必要。`useLiveQuery() === undefined` はクエリ未完了を表すだけで、server pull 完了を保証しない。
- 複数試験で未選択の場合、W1 だけでなく W2以降を描画するか、全面的に選択要求状態にするかが必要。
- 試験削除・pull 全置換・別タブでの試験切替が発生した際、表示中の選択をいつ再解決するかが未定義。
- URL 更新時に既存の `billing` 等の query parameterを保持する必要がある。
- `/app/study/smart` と `/app/study/quick` が Home と同じ選択解決を独自実装すると乖離しやすい。共通 resolver と「解決不能時の戻り先・エラー表示」が必要。
- URL を正とするなら、別タブ間で保存値が揺れても現在のタブの有効 URL は上書きされない、という不変条件を明記すべき。

### daily-new-limit / `first_reviewed_at`

- `cards.first_reviewed_at` は「今日導入された数」の観測には使えるが、オフライン・複数端末・複数タブでの厳密な account-wide 上限制御にはならない。各端末が古い mirror を見てそれぞれ k 件開始できる。
- 同一端末でも flush 前にセッションを複数起動すれば超過できる。セッション内 cap だけでは、再押下・別タブ・並行セッションを防げない。
- したがって保証レベルを次のいずれかに固定する必要がある。
  - UX上の soft limit
  - 端末内 limit
  - online 時のみ account-wide
  - server ingest が超過回答を拒否・非適用にする hard limit
- hard limit を求める場合、単なるカード列では不十分。server側の原子的な予約・消費契約と、超過イベントの扱いが必要になる。
- `first_reviewed_at` を「一度だけ不変」とすることと、イベント replay の決定性が衝突しうる。遅延到着した、より古い applied event が state 0→非0 を起こす場合に日時を修正するのか、先着値を維持するのかが必要。
- `answered_at` は client由来であるため、時計ずれ・未来時刻・誤った timezoneにより日次枠を誤計上しうる。日界判定に client時刻を採用することが意図的か確認が必要。
- fold がカードの全履歴を再生するのか、既存最終状態から増分適用するのかによって、`first_reviewed_at` の算出方法が変わる。
- unapplied、collision、重複、順序ガードで除外されたイベントが初回日時に影響しないことを契約化する必要がある。
- 既存カードを null のままにすると、過去に学習済みでも今日 state 0 に戻る経路がある場合や replay時の扱いが曖昧になる。
- カードの試験間移動を「移動先の当日枠消費」とする仕様は、ユーザー操作だけで両試験の u が変動する。移動機能の有無を含め、意図した意味論か確認が必要。
- カード削除で当日枠が戻る仕様は、削除後にさらに新規を導入できることを意味する。daily limitを「現存カード数」とするか「その日に実際に導入した累計」とするかの判断が必要。
- K変更、試験削除、カード移動、復元、import、duplicateなど、通常回答以外で state / exam所属が変わる経路を全列挙すべき。
- `daily_new_target` 更新が server actionのみなら、オフライン設定変更はできない。local-first の範囲外として明示する必要がある。
- nullable列で nullを既定値とすると、将来デフォルト値を変えた際に既存試験の実効 K も変わる。スナップショット値か動的デフォルトかを決める必要がある。

### スマート復習の選定変更

- `due < 今日の終わり` は、今より後に予定された Learning / Relearning stepを前倒しする。FSRSのstep間隔を破る可能性があり、「day粒度だから許容」だけでは correctness pinとの整合確認が不足する。
- later-dueカードをセッション開始時に一度だけ選ぶ場合、同一セッション中に回答後の新しい due が今日中になっても再度出題されない。逆に動的再選定すると同一カードが複数回出る。どちらかを定義すべき。
- 復習部をすべて先に置くため、復習件数が `session_limit` 以上なら新規 k は一件も出ない。W2に新規 k と表示しても、当該CTAセッションでは新規が開始されない可能性がある。
- `y` は全プール件数、実際のセッション件数は cap 後なので、「W2の y とCTAのプール件数が一致」の意味を表示件数・選定前・選定後で区別する必要がある。
- 復習優先が続くと新規が恒常的に飢餓状態になる。新規を毎日 k 件導入する目標なのか、単なる最大値なのかを明記すべき。
- `state !== 0` と due条件だけでは、不正・欠損 due、suspended相当、削除待ち、利用不能カードが存在する場合の扱いが不明。
- 全試験横断から試験単位への変更により、既存 bookmark、通知、他画面の「スマート復習」導線、空状態、テストだけでなくユーザー期待も変わる。Home以外の入口を列挙すべき。
- client選定と server fallbackの結果一致が必須。JST境界、now、並び順、null値、cap、k計算を共通の契約テストで固定する必要がある。
- セッション開始後に別端末で回答・削除・更新されたカードをどう扱うかが未定義。

### summary / W4

- 「各カード2件目以降」は、全履歴で row numberを付けてから30日窓で絞る必要がある。30日窓内だけで番号付けすると意味が変わる。
- 「applied 復習イベント」をDB上のどの列・状態で判別するかが記述されていない。`answer_events` に適用状態がどう表現されるかをSQL契約に含める必要がある。
- 30暦日の開始・終了時刻、JST、endpoint内での単一評価時刻を固定すべき。
- 正答率の分母・丸め・小数精度・0除算・wire型が必要。
- `option_id` 昇順の比較が UUID / text / DB native型のどの順序かを固定すべき。
- option/categoryが削除・改名された場合の表示と集計、タグ重複付与防止、同一カードが複数タグに寄与することを確認すべき。
- examの存在確認とowner scopeを区別し、他ownerのUUIDに対して 404 / 空配列 / 403 のどれにするかを定義すべき。
- fetch競合がある。試験Aの遅い応答が、切替後の試験B表示を上書きしないよう abort または request identityが必要。
- オフライン時にW4だけserver依存になる。エラー、再接続、再訪、stale値の扱いを決める必要がある。

### origin

- query parameterの `origin=home_today` をそのまま信頼すると、bookmarkや手入力でもHome流入に偽装できる。「分析ラベルなので許容」か、launcherが内部的に確定するかを決める必要がある。
- 同じ `session_id` に複数 originを許すと、成功セッション数が水増しされる。混在を検証しない判断は、成功指標の信頼性と直接衝突する。
- distinct のscopeに `user_id`、期間、originを含めること、session_idが全ユーザー・全端末で十分一意であることを確認すべき。
- session_id nullを除外するなら、Home入口から始めた回答ではsession_id必須にする方が指標欠損を防げる。
- originの異なる重複eventをcollisionにしない場合、先着が nullなら再送でoriginを補完できず、導入直後の旧client/outbox競合で恒久欠損する。
- 逆にoriginをcollision対象にすると旧client互換性を壊すため、「既存 null のときだけ補完する」「常に先着固定」等のmerge契約が必要。
- 未知 enumを400 rejectすると、新client先行だけでなくロールバック、複数server version、長期滞留outboxでも送信停止を起こしうる。分析metadataの未知値だけで回答本体をrejectする妥当性を検討すべき。
- origin不正でバッチ全体がrejectされるなら、学習回答の同期を分析列が妨害する。未知値を nullへ正規化する選択肢との比較が必要。
- originがevent本体の冪等性対象外であること、再送時に更新しないこと、既存イベントへの補完可否を契約テストにする必要がある。
- `custom`、既存smart以外のすべてのSessionRunner入口が列挙されているか確認が必要。漏れた入口では prop追加が型エラーまたはnull化する。

### L2 / local-first

- `study_days` 90日snapshotはW7には十分でも、同期完了前・pull失敗・offline時に古い値を表示する。その鮮度表示の要否を決める必要がある。
- mount pullとウィジェット読取の競合により、旧ownerデータのpurge後に一時的な0表示が出る可能性がある。
- flush成功後のpull-backが失敗した場合、回答済みなのにW7が更新されない。部分成功の状態と再試行契約が必要。
- owner限定全置換がtransactionalでなければ、deleteとbulkPutの間に一時的な空表示が発生する。
- dead route削除前に、コード検索だけでなく外部client、monitor、手動運用、文書化済みAPI契約の有無を確認する必要がある。

### tokens / UI契約

- semantic tokenにはlight/dark双方のコントラスト基準、色覚非依存、focus/hover/disabled状態が必要。
- W6の持ち越し区別を色だけに依存させない必要がある。
- `maturity-1..4` の4段階と「3区分 + 持ち越し」は別軸が混在している。成熟度と期限超過状態を同一scaleに載せる意味論を再検討すべき。
- Widget Cardのslotだけではloading、empty、error、disabled action、aria heading hierarchyが規定されていない。
- 7ウィジェットを同時に `useLiveQuery` で別々に集計すると、同じcards/eventsを反復走査する性能リスクがある。共有query・共有集計結果の検討が必要。
- 推定時間のローカルイベント最大1,000行走査を再renderごとに行わないキャッシュ・再計算契約が必要。

### 空状態

- 「試験はあるがカード0件」が4状態に明示されていない。uploadへ誘導するのか、現在対象なしにするのかが必要。
- 「カードあり・学習0」で K=0 の場合に「最初の10問」を出すとdaily limitと衝突する。
- 「最初の10問」は `session_limit < 10`、未学習総数 < 10、残りdaily budget < 10 の場合の文言調整が必要。
- 履歴僅少とfetch失敗を混同しない判定が必要。
- 選択試験未確定状態は、提示された4空状態とは別の制御状態として扱う必要がある。

## plan ドラフトへの抜け・未考慮指摘

- §6の「`useLiveQuery` undefined区別でpull完了を待てる」は成立しない。PullTriggerの完了・失敗状態をHomeへ公開する仕組みが必要。
- §6の `router.replace('/app?exam=…')` は `billing` その他のqueryを落とす。
- §6は無効URL IDを「次段へ」進めるが、URL自体の正規化・除去が明示されていない。
- §8.3の「account-wideの一貫性は従属的に得られる」は過大な主張。保存結果の最終整合は得られても、上限の強制は得られない。
- §8.3でclient楽観更新を行わない一方、flush前の再起動・別タブ・複数セッションによるk超過を扱っていない。
- §8.3の immutable `first_reviewed_at` と遅延イベントreplay・順序ガードの関係が未定義。
- §8.3の削除で枠が戻る、移動先の枠を消費するという設計は、daily limitの通常期待とずれる可能性が高いが、明示的な承認事項になっていない。
- §8.5はlater-due前倒しがFSRS correctnessに与える影響を「許容」と断定しているが、凍結pinとの照合や再学習stepへの影響検証がない。
- §8.5は復習優先 + session capにより、新規 k が実際には出題されない問題を扱っていない。
- §8.5の「回答済みは due が飛んで自然に除外」は、flush/pull完了前の再CTAでは保証されない。
- §8.5のHome外スマート復習入口の棚卸しが不足している。既存リンク、ナビゲーション、bookmark以外のcaller確認が必要。
- §8.5のclient経路とserver fallbackの同値性テストが、単なる触点列挙に留まっている。
- §10はapplied eventのSQL上の識別方法、30日境界の正確な式、accuracy丸めを欠く。
- §10は試験切替時fetch raceとoffline/stale表示を扱っていない。
- §11.2のorigin混在を許容する判断は、distinct session成功指標を壊しうる。
- §11.3は分析metadataの未知値で回答同期全体を400にする可用性リスクを検討していない。
- §11.4はcollisionからoriginを外す理由はあるが、null先着時の補完不能・analytics欠損を扱っていない。
- §11.4の触点には、outboxの永続済み旧payload、batch serialization、fixture/factory、debug/export/import、session resume経路の確認が不足している。
- §9はpull-back部分失敗、mount pull失敗、snapshot鮮度を扱っていない。
- §9のdead route削除判断はrepo内callerゼロだけに依存しており、外部契約の確認がない。
- §12の具体色を実装時判断へ送っているため、accessibility acceptance criteriaがspecから欠落している。
- §12の `maturity-1..4` は成熟度と持ち越しを混ぜておりsemantic tokenとして不安定。
- §13.1でpin 6/7/8をDash-3へ持ち越す一方、要件は「Dash-0の全pin無退行」を完了条件としている。非実装と無退行確認を区別し、既存pinを実行しない意味にならないよう修正が必要。
- §3.2ではR計算を作らないとし、§4 W7では「R(今日の学習量)」を表示するとしており、Rの名称・定義が内部矛盾している。
- §4の「deltaは実装時に落としてよい」は、凍結されたW7定義を実装判断で外す余地を残している。specレビュー時に確定すべき。
- §5の「カードあり・学習0 → 最初の10問」は k、K=0、session capと整合していない。
- §14の「同一deployでserver先行を満たす」は厳密には成立しない。旧serverと新client bundleが一時共存するrolling deploy/CDN条件を確認すべき。
- migration 0040一本に3つの独立機構を束ねるため、originだけのrollbackやdaily limit延期が難しい。リリース原子性を意図したものか検討が必要。
- `ClientExam` / `ClientCard` のフィールド追加でDexie version bump不要という判断は、型だけでなく保存済み行の欠損許容、mapper、schema validation、export/importを確認して初めて成立する。
- Homeの7ウィジェットが個別にDexieを読む構成について、反復全表走査・LiveQuery再計算の性能設計がない。

## リスク / 対立しうる設計判断

- **soft limit vs hard limit**  
  local-firstで回答を止めないことと、account-wide daily limitの厳密保証は両立しにくい。現案はsoft limitとしては成立するが、hard limitとは呼べない。

- **server正規化時刻 vs client回答時刻**  
  server時刻は不正・時計ずれに強いが、offlineで実際に回答したJST日とずれる。client `answered_at` はユーザー体験に沿うが改変・時計ずれに弱い。

- **初回日時の不変性 vs replay決定性**  
  先着値固定は運用上安定する一方、遅延イベントを含む履歴から再構築した結果と一致しない。履歴上の最古値へ修正すると「一度だけ」の契約を崩す。

- **復習優先 vs 新規導入目標**  
  復習を完全優先すると安全だが、新規 k は長期間出ない可能性がある。daily targetを「最大値」とするか「できるだけ達成する目標」とするかで混合順序が変わる。

- **later-due前倒し vs FSRS間隔尊重**  
  W2件数とCTA件数を一致させるほど、時刻ベースのLearning stepを前倒しする。表示整合とスケジューラ忠実性のトレードオフ。

- **origin厳格enum vs回答同期の可用性**  
  厳格rejectは分析品質を上げるが、未知の分析値だけで学習回答が同期不能になる。未知値をnull化すれば回答は守れるが、計測欠損が増える。

- **origin先着固定 vs metadata補完**  
  冪等性を単純化するなら先着固定。導入期の計測欠損を減らすなら null→非null の限定補完が必要だが、更新競合契約が増える。

- **server-only W4 vs完全local-first Home**  
  server集計は正確で軽量なclientを実現するが、Home内でW4だけoffline不能・鮮度特性が異なる。

- **snapshotの単純性 vs即時表示**  
  `study_days` 全置換は整合しやすいが、未flush回答やpull失敗時に表示が遅れる。local eventを合成すると即時性は上がるが二重計上防止が複雑になる。

- **nullable動的既定値 vs値の固定**  
  `daily_new_target = null` をグローバル既定値として解釈すると将来の既定変更が全既存試験へ波及する。作成時に実値を保存すれば挙動は安定するが、既定値の一括改善が難しい。

- **単一migration vs段階的リリース**  
  一本化は実装が簡潔だが、3機構のリリース・rollbackが結合する。特にdaily limitの意味論が未確定なままoriginまで巻き込むリスクがある。