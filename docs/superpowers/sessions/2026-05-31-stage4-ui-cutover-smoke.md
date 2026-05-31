# Stage 4 (試験詳細 UI cutover / local-first 書込) — stg smoke 手順

- 日付: 2026-05-31
- 対象: 試験詳細 (`/app/exams/[id]`) の card 表示/編集/追加/削除を local-first 化
  (Task 4.1〜4.4)。表示は Dexie cards mirror の `useLiveQuery` 直読み、編集は
  mirror 楽観直書き + `card_mutations` outbox enqueue + debounced/immediate drain
  (`runGuardedCardMutationFlush`) → flush 成功で pull-back 収束。
- 実施: Claude Code(後続 prompt、chrome-devtools で stg ログイン済セッションを駆動)
- 認証: stg ログイン(`docs` 外の memory `stg-smoke-login` 参照。
  `komail9server+001@gmail.com`)。多くは session cookie 生存。

## Stage 4 commit 一覧(全 `[no-review]` 中間 tag、smoke PASS 後に `[reviewed]` amend)
- `c6a1bab` feat(sync): Task 4.1 — 詳細 cards 表示を Dexie mirror useLiveQuery 直読みに切替
- `ea38f0d` feat(sync): Task 4.2 — inline 編集を mirror 直書き + outbox drain に cutover
- `3ac712c` fix(sync): Task 4.2 review — nullable '' →null mirror 正規化 + drain cleanup コメント
- `5749d43` feat(sync): Task 4.3 — card 追加/削除を client local-first (mirror insert/remove + outbox create/delete) に cutover
- `69367d4` refactor(sync): Task 4.4 — dead 化した card server action wrapper 撤去 + 型 import repoint

実装結果: `pnpm exec tsc --noEmit` clean / `pnpm build` 緑 / `pnpm test` 全通過
(103 files, 1174 tests) / per-task spec+code-quality review Critical 0 / final
holistic review Critical 0。

## 前提 / 観測手段
- 編集 UI が **今回初めて local-first 配線**。観測は Stage 2/3 と同じ fetch spy +
  Dexie 直接 inspect。
- 区別する request:
  - `POST /api/card-mutations/bulk` = outbox flush(編集/追加/削除の送信)。
  - `GET /api/pull` = pull(入口 kick / pull-back / ambient)。詳細滞在中 ambient は
    suppress、pull-back は通る(Stage 3 既証)。
- **client-side ナビ(リンク click)では spy が生存、hard reload で消える**。reload を
  伴う観点(観点②)では reload 後に spy/Dexie helper を再設置する。

### fetch spy(Stage 3 と同一。ログイン済タブで一度設置)
```js
(() => {
  if (window.__spy) { window.__log.length = 0; return 'cleared'; }
  window.__log = [];
  const orig = window.fetch;
  window.fetch = async (...a) => {
    const url = typeof a[0]==='string'?a[0]:(a[0]&&a[0].url)||'';
    const m = (a[1]&&a[1].method)||'GET';
    const hit = url.includes('/api/pull') || url.includes('/api/card-mutations/bulk');
    const r = await orig(...a);
    if (hit) window.__log.push({ m, u: url.replace(location.origin,'').split('?')[0], s: r.status });
    return r;
  };
  window.__spy = true; return 'installed';
})();
```

### Dexie inspect helper(cards mirror / outbox を読む)
```js
window.__db = (store, where) => new Promise((res,rej)=>{
  const q=indexedDB.open('recallmint');
  q.onsuccess=()=>{const db=q.result;const tx=db.transaction(store,'readonly');
    const rq=tx.objectStore(store).getAll();
    rq.onsuccess=()=>res(where?rq.result.filter(where):rq.result);rq.onerror=()=>rej(rq.error);};
  q.onerror=()=>rej(q.error);
});
// 例: await window.__db('cards', c=>c.exam_id===EXAM_A)
//     await window.__db('card_mutations')   // outbox 全件
```

## 事前準備
- `手動で試験を作成` で捨て exam **A** を作成、`＋カードを追加` で card 1 枚。
  `/api/pull` または `await window.__db('cards', c=>c.exam_id===EXAM_A)` で `EXAM_A` /
  `CARD_ID`(実在 owner)取得。
- 観点④/⑤用にもう 1 つ捨て exam **B** を作成。
- 終了後 A・B を削除(クリーンアップ節)。

---

## 観点と手順

### 観点①: 詳細で編集/追加/削除が UI 即時反映(local-first 楽観)
詳細 A に入り spy 設置 → `window.__log.length=0`。
- **text 編集**: 問題文 cell を click → 編集 → blur。期待: blur 直後に表示が新値へ
  **即時**(server 応答を待たない)。`await window.__db('cards', c=>c.id===CARD_ID)` で
  `question_text` が新値、`await window.__db('card_mutations')` に
  `op:'update_field', card_id:CARD_ID, patch.field:'question_text'` の pending 行
  (sync_status は pending→程なく synced)。
- **options 編集**: 選択肢 cell 編集 + checkbox toggle。期待: 即時反映、mirror の
  `options` / `correct_answer_ids` が更新、outbox に `field:'options'` の pending。
  checkbox は debounce なし即時 drain。
- **カード追加**: `＋カードを追加` → 期待: 新 card が**即座に**リストに現れ、問題文
  cell が auto-edit(編集モード)で起動。mirror に新 card 行(client UUID)、outbox に
  `op:'create'` の pending(patch は snake_case `{exam_id,title,sort_key,question_text,
  options(camelCase isCorrect),explanation_text:null,memo:null}`)。
- **カード削除**: × → 確認 → 削除。期待: 該当 card が**即座に**リストから消える。
  mirror から該当 card 消失、outbox に `op:'delete'` pending。
- 注: 全操作で UI 反映は `POST /api/card-mutations/bulk` の応答を待っていないこと
  (即時 = mirror 直読み)を確認。

### 観点②: reload で編集が永続(Dexie outbox + mirror)
観点①直後(drain 前を狙うなら素早く)に **hard reload**。
- reload 後 `window.__db` helper を再設置 →
  `await window.__db('cards', c=>c.id===CARD_ID)` で編集値が残存、
  追加した card / 削除済 card の状態も mirror に永続していることを確認。
- 趣旨: 旧実装は揮発(reload で未送信編集ロスト)。local-first では outbox + mirror が
  IDB 永続のため reload を跨いで残る。
- 補足: reload 後の入口 kick pull + ambient flush で残 pending は server へ送信される。

### 観点③: 数秒後に server 反映 + 一覧の card_count 整合
観点①の編集/追加/削除のまま 2〜3 秒待つ(debounce drain + flush)。
- spy に `POST /api/card-mutations/bulk` 200 が出ること、その後 `GET /api/pull`
  (pull-back)が出ること。
- `await window.__db('card_mutations')` の該当行が `sync_status:'synced'` 化。
- **一覧の card_count 整合**: アプリ内リンクで `← 試験一覧`(`/app/exams`)へ。一覧の
  exam A のカード数が追加/削除を反映した正しい件数であること(一覧件数は
  `exam-list-live` が **cards mirror を計数**して出すため、mirror の add/remove で
  即整合。server の `exams.card_count` は pull-back で収束)。
- **Minor 注記(別 issue 候補)**: 詳細 page の見出し `カード (N 件)` は SSR fetch の
  `cards.length` 由来で **live ではない**ため、追加/削除直後は見出し件数が stale に
  なり得る(リスト本体は live 反映)。一覧件数(本観点の対象)は live で整合。見出しの
  staleness を許容するか live 化するかは OT 判断(下記「smoke 後の論点」)。

### 観点④: 背景 pull 再開状態(離脱→再入場)でも編集が IDB 直読みで正しく反映
- 詳細 A で 1 件編集 → drain 完了(synced)を確認。
- アプリ内リンクで一覧へ離脱(ExamDetailPullGate unmount → suppress 解除 = ambient
  pull 再開)。一覧で `visibilitychange` を撃つ等で ambient pull が走る状態を作る
  (`document.dispatchEvent(new Event('visibilitychange'))`)。
- 再び詳細 A に入場(入口 kick pull + suppress 再 on)。
- 期待: 再入場後の表示が編集後の正しい値(mirror = server 収束値)。ambient pull が
  間に走っても、表示は `useLiveQuery` 直読みのため最新 mirror を反映し、編集が
  巻き戻らない/重複しないこと。

### 観点⑤: 多タブで同一試験を編集(Web Locks 直列化)
Stage 2 では単一タブのみ確認。UI 配線後の現実シナリオをここで厚く確認。
- 同一 stg アカウントで詳細 A を **2 タブ**開く(タブ1/タブ2)。両タブで spy + helper
  設置。
- **同時編集**: タブ1 で field X を、タブ2 で field Y を続けて編集。期待:
  - 各タブの `POST /api/card-mutations/bulk` が **直列**(`recallmint:card-mutations:flush`
    Web Lock + `ifAvailable` skip により、片タブ flush 中の他タブ drain は lock-busy で
    skip、後で再 drain)。二重送信や取りこぼしがないこと。
  - 最終的に両 field が server に反映、両タブの mirror が pull-back で収束し一致。
- **同一 field 衝突(LWW)**: 両タブで同じ field を異なる値に編集 → 後勝ち(LWW)で
  どちらか一方の値に収束し、両タブ表示が一致すること(spec §3 ケース2)。
- **同一 card create→他タブ**: タブ1 で card 追加 → drain → タブ2 で pull が走ると
  タブ2 mirror にも同 card(同 UUID、ON CONFLICT 冪等)。重複行が出ないこと。
- 観測点: `card_mutations` の同一 mutation が二重 apply されない(server UNIQUE +
  in-flight set + Web Lock の 3 重防御)。`POST` の時系列が重ならない(直列)こと。

### 観点⑥: mobile view 動作検証
chrome-devtools の emulate(mobile viewport)で観点①の中核(text/options 編集・
追加・削除の即時反映)を再確認。選択肢 row の grid レイアウト(mobile 4 列 →
explanation が row2 全幅)、tap target、auto-resize textarea が破綻しないこと。

---

## 追加 probe(final review Important: split-batch 遅延 edge)
- 趣旨: 「同一 card の `create` flush が in-flight 中に後続 `update_field` の drain が
  走る」競合は、`runGuardedCardMutationFlush` の Web Lock が **POST 完走まで保持** +
  `ifAvailable` skip により**直列化され split しない**(create commit 後に update が
  found:true で適用)想定。残余 risk は「lock-busy で skip された lone edit が次の
  ambient kick まで送信遅延」(データ欠損なし・self-healing)。
- probe: カード追加 → auto-edit で問題文を即編集 → blur。`POST /api/card-mutations/bulk`
  の時系列を spy で確認:
  - 期待(正常): create と update が**直列**に 200(または同一 batch に同梱)。update が
    `200 {failed:[id]}` で**戻らない**こと。
  - 万一 `failed` に update_id が出て pending のまま残る場合 = split-batch 遅延 edge を
    実機再現。OT に報告(下記論点)。

---

## クリーンアップ
- 追加した捨て card / exam A・B を UI 削除(cascade)。drain 完了まで待ち、
  `await window.__db('card_mutations')` の pending=0 / 残行 synced を確認。
- `await window.__db('cards', c=>c.exam_id===EXAM_A||c.exam_id===EXAM_B)` が空、
  `/api/pull` で A・B 消失確認。
- 多タブは全タブ閉じる。

## smoke 後の論点(OT 判断)
1. **Important(split-batch update_field 遅延 edge)**: 上記 probe で再現しなければ
   現状維持で可(Web Lock 直列化で防御済)。再現した場合のみ対応(案: receiver が
   「未存在 owned card への update_field」を transient 扱い / lock-busy 時の短 re-kick /
   同一 card の create+update を同 batch 強制)。いずれも Stage 1-2 shipped 코드 に
   触れるため OT 承認後に follow-up。
2. **Minor(詳細見出し `カード (N 件)` の stale)**: SSR `cards.length` 由来で非 live。
   live 化(見出しを mirror 計数の child に lift)するか、許容するか OT 判断。
3. 観点①〜⑥ + probe PASS かつ上記論点に OT 合意 →
   Stage 4 の 5 commit に `[reviewed]` を amend(amend と push は OT が host から)。
   決済/認証/削除の裏取り対象のうち本 Stage は **card 削除(cascade)** を含むため、
   観点①削除 + 観点③ server 反映 + クリーンアップの cascade 消失を OT 実機確認後に
   `[reviewed]` 付与(CLAUDE.md「重要 Fix の裏取り: 削除」)。
