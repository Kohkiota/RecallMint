# side peek トリガー再設計(title セル hover ボタン)事実確認

- 日付: 2026-07-06
- 目的: 専用 open 列 → Notion 式 title セル hover ボタンへの変更前確認(OT 指示 3 点)。実装なし。
- 親文書: spec `docs/superpowers/specs/2026-07-06-side-peek-design.md` / plan `docs/superpowers/plans/2026-07-06-side-peek.md` / fact-finding v2。

## 1. モバイルからテーブルビューへの到達経路 — **ある**

- view state は `exam-detail-view.tsx:55` の `useState<View>('card')` — **全環境共通 default 'card'**(viewport ベースの既定切替は未実装。design-policy §3.1「デスクトップ既定 = テーブル」もコード上は未実装で、per-device 永続がその代替)。
- mount 後に `examViewPrefs`(Dexie・per-device)を load し saved view を復元(`:77-91`)。ユーザー切替は `handleToggle`(`:111-118`)→ fire-and-forget 永続(`:137-157`)。
- ViewToggle(`:176-195`)は**responsive class なし** — card view(`:226`)/ table view chrome(`:266`)の両方で常時表示。**モバイルでも「テーブル」ボタンで切替可能**で、per-device 永続によりモバイル端末が table 固定になることもある。
- 結論: side peek トリガーは「実質デスクトップ専用」に**ならない**。モバイル分岐(§3 の常時表示 + 旧案 b 全幅 overlay)は**引き続き必要**。

## 2. title セルの現在のレンダリングと hover ボタンの余地

- 列 def(`exam-card-table-columns.tsx:95-117`): `id:'title'`, `size:80`(80px 初期幅・columnSizing でユーザー可変)、cell = `<InlineTextField cardId field="title" initialValue ariaLabel="タイトル 編集"/>` を直置き(wrapper なし)。sortable(accessorFn)+ text filterFn。
- td(`exam-card-table.tsx:195-218`): `px-1 py-1 border-b`、幅は CSS 変数、**overflow-hidden/truncate なし**。pinned 時は `sticky z-[1]` + 不透過背景。行 `<tr>` は無名 `group`(pinned 背景合成用 `:188`)。
- InlineTextField display(`inline-text-field.tsx:316-345`): `role="button" tabIndex=0` div、`block w-full min-h-11 md:min-h-8`、`whitespace-pre-wrap break-words`(truncate なし・折返し表示)、`onClick={startEdit}`。editing 時は同寸法の Input/Textarea に置換(`:277-312`)。
- **hover ボタンの構造余地**: cell を `relative` wrapper(named group、例 `group/peek`)化し、`InlineTextField` と**兄弟**の `absolute right-1 top-1/2 -translate-y-1/2` button を並置すれば成立。
  - **click 衝突なし(構造的)**: button は display div の兄弟なので、button click のバブリングは wrapper → td へ抜け、display div の `onClick={startEdit}` を経由しない。stopPropagation 不要。
  - 表示制御は opacity 切替(`opacity-0 group-hover/peek:opacity-100 focus-visible:opacity-100`)— `display:none` にしないため **Tab 到達可**(旧 plan の focus 方針と同じ)。行 `group`(無名)とは named group で衝突しない。セルホバー(OT 指定)= wrapper 起点で自然に実現。
  - **編集中の重なり**: editing 時も hover でボタンが Input 上に出る。Tailwind v4 の `has-` variant(`group-has-[input]/peek:hidden` 相当)で **CSS のみで編集中非表示にできる**(JS/props 追加不要)。
  - **視認性**: 初期幅 80px + 折返し表示のため、hover ボタンはタイトル末尾に重なりうる → Notion 同様 button に不透過背景(`bg-background` + shadow)を敷く。
- title 列は hideable(column toggle 除外は `select` のみ)。**title 非表示時は peek 到達不能 = ユーザー責任で許容**(OT 確定)。

## 3. モバイル常時表示の分岐余地 — **必要・CSS のみで可能**

- §1 の通りモバイルからテーブル到達可。touch に hover は無く、display div への tap は `startEdit` に食われるため、**mobile はボタン常時表示が必要**。
- 分岐は CSS breakpoint のみで実現: `opacity-100 md:opacity-0 md:group-hover/peek:opacity-100`(JS viewport 判定なし = 既存規律・旧 spec 制約と整合)。
- トレードオフ: モバイル幅で title セル(初期 80px)に常時 icon が重なり窮屈 → icon を小径(size-6 相当)+ 不透過背景で許容。代替(モバイルではトリガー非表示 = peek デスクトップ専用化)は、モバイル table ユーザーから peek を奪うため非推奨。

## 4. spec/plan 改訂提案(骨子)

- **spec §3.3 差替**: 専用 open 列 → title セル内 hover peek button。① cell を `relative group/peek` wrapper 化 ② button = `aria-label="カードを開く"` + `aria-pressed`、絶対配置 right、desktop = hover/focus-visible 表示(opacity、Tab 到達可)、mobile(<md)= 常時表示、編集中 = `has-` variant で非表示、不透過背景 ③ title 非表示時は peek 到達不能を許容(明記)④ enableHiding:false・列 toggle 除外・pinning select 準拠・列順 index 1 の記述を削除。
- **plan T2 差替**: 変更 file は `exam-card-table-columns.tsx` のみに縮小(`exam-card-table-column-toggle.tsx` 改修は消滅)。meta 拡張(`activeCardId` / `openCard`)は不変。test 観点: hover/focus で表示・click で openCard・display div click(startEdit)と非干渉・編集中非表示・aria-pressed 連動・mobile 常時表示(class 検証)。
- **T1 / T3 / z-index / prune / 閉じ方 = 無影響**。**モバイル案 b(全幅 overlay)= 不変で必要**(§1 の結果、モバイル table 経路が生きているため)。
- spec §6 Open Questions から「トリガー = 専用列で確定可か」(旧 Q3)を削除し、「title 非表示時の到達不能許容」は確定事項へ移動。
