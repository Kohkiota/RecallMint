# Stage 3 (試験詳細 local-first 書込化) — stg smoke 手順

- 日付: 2026-05-31
- 対象: 詳細滞在中の ambient pull suppress + 入口 pull kick(`lib/sync/ambient-pull-suppress.ts` / `pull-trigger.tsx` ガード / `exam-detail-pull-gate.tsx`)
- 実施: Claude Code(後続 prompt、chrome-devtools で stg ログイン済セッションを駆動)
- 完了後: 問題なければ Stage 3 の 2 commit に `[reviewed]` を amend

## 前提 / 認証 hand-off
- Stage 3 でも **編集 UI は未配線**(Stage 4)。本 smoke は pull 配線(suppress / 入口 kick / pull-back 対象外)の挙動確認。
- 認証: stg にログイン済みタブで実施。`GET /api/pull`(ambient / 入口 kick / pull-back)と `POST /api/card-mutations/bulk` は session cookie 自動付与。
- **観測は fetch spy で行う**。Next.js の client-side ナビゲーション(リンク click)は**リロードしない**ため、spy(window.fetch 差し替え)は遷移後も生存する。**hard reload(URL 直打ち)すると spy は消える**ので、観測中の遷移は**アプリ内リンク click** で行う(消えたら再設置)。

## 判別の要点(全 pull は GET /api/pull で同形)
- **ambient pull**: PullTrigger の mount/visibilitychange/online 由来。詳細滞在中は **suppress(発火しない)**。
- **入口 kick**: 詳細 mount で 1 回(`exam-detail-pull-gate`)。
- **pull-back**: card-mutation flush 成功時(`pullBack('card-mutation-flush')`)。**suppress 対象外(詳細滞在中も通る)**。
- 区別の手:
  - **pending mutation が無い**状態で visibilitychange を撃てば、flush(→pull-back)が起きないので「ambient のみ」を観測できる。
  - pull-back を見たいときは **pending mutation を seed** してから visibilitychange を撃つ。

## fetch spy(ログイン済タブで一度設置)
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
- ログ確認: `window.__log` / クリア: `window.__log.length = 0`。

## 事前準備
- `手動で試験を作成` で捨て exam **A** + `＋カードを追加` で card 1 枚。`/api/pull` で `EXAM_A` / `CARD_ID`(実在 owner)取得。
- **観点5(A→B 直接遷移)用に、もう 1 つ捨て exam B を作成**(card は任意、0 枚でも可)。`/api/pull` で `EXAM_B` 取得。詳細 B の URL は `/app/exams/<EXAM_B>`。
- pull-back 観点(観点4)では CARD_ID を update_field の対象にする。
- 終了後は A・B 両方を削除(クリーンアップ節)。

## 観点と手順

### 観点1: 詳細入口で pull が 1 回走る(入口 kick)
- 一覧 `/app/exams` を開いた状態で spy 設置 → `window.__log.length=0`。
- **アプリ内リンクで** `詳細を見る`(CARD のある捨て exam)を click(client nav)→ 1.5s 待つ。
- 期待: `window.__log` の `GET /api/pull` が **ちょうど 1 本(0 本でも 2 本以上でもない)**(入口 kick)。(※ list→detail の内部遷移では PullTrigger mount は再発火しないので、この pull は入口 kick 由来。)
- **fail 判定の厳格化**:
  - **0 本 = FAIL**: 入口 kick が自分の suppress-on に弾かれている(`exam-detail-pull-gate` の kick→suppress の**順序バグ**。kick が suppress より後に走っている疑い)。
  - **2 本以上 = FAIL**: 入口 kick の**二重発火**(StrictMode の in-flight guard で吸収しきれていない / effect 多重実行)。
  - ちょうど 1 本のみ PASS。

### 観点2: 詳細滞在中は ambient pull が発火しない(suppress)
- 詳細ページ滞在のまま、**pending mutation 無し**を確認(Dexie card_mutations 0、または seed しない)。
- `window.__log.length=0` → `document.dispatchEvent(new Event('visibilitychange'))` → 1.5s 待つ → さらに `window.dispatchEvent(new Event('online'))` → 1.5s。
- 期待: `window.__log` に **`GET /api/pull` が 0 本**(ambient suppressed。flush も無いので pull-back も無し)。

### 観点3: 詳細を離れると ambient pull が再開する(resume)+ 非詳細では発火する対比
- 詳細から **アプリ内リンクで** `← 試験一覧`(`/app/exams`)に戻る(client nav、gate unmount → resume)。
- `window.__log.length=0` → `document.dispatchEvent(new Event('visibilitychange'))` → 1.5s。
- 期待: `window.__log` に **`GET /api/pull` が 1 本以上**(ambient 再開)。
- (対比補強)観点2 と観点3 の差 = suppress が詳細滞在中のみ効いている証左。

### 観点4: pull-back は suppress 対象外(詳細滞在中の flush 後 pull-back が通る)
- 再び詳細ページへ(アプリ内リンク click)。
- Console で CARD_ID 宛ての **pending mutation を seed**(raw IndexedDB、Stage2 smoke と同形):
```js
await (async () => {
  const CARD_ID = '<owner-card-uuid>';
  const row = { mutation_id: crypto.randomUUID(), card_id: CARD_ID, op: 'update_field',
    patch: { field: 'memo', value: 'stage3 pullback ' + Date.now() },
    edited_at: new Date().toISOString(), sync_status: 'pending', last_attempted_at: null };
  const db = await new Promise((res,rej)=>{const q=indexedDB.open('recallmint');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
  await new Promise((res,rej)=>{const tx=db.transaction('card_mutations','readwrite');tx.objectStore('card_mutations').add(row);tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});
  window.__pbmid = row.mutation_id; return 'seeded';
})();
```
- `window.__log.length=0` → `document.dispatchEvent(new Event('visibilitychange'))` → 2s 待つ。
- 期待: `window.__log` に **`POST /api/card-mutations/bulk` 200**(flush)**＋ その後 `GET /api/pull`**(pull-back)。**ambient は suppress でも pull-back は通る**ことを確認。
- 補足: 同じ visibilitychange で PullTrigger の ambient は suppress され(直接の pull は出ない)、flush 成功 → pull-back のみが GET /api/pull を出す。seed 行は `synced` 化(Dexie 確認)。
- **後続ステップ(pull-back 後も suppress 継続)**: seed 行が `synced` 化し **pending が無い状態**を確認 →(必要なら観点4で seed した行はそのまま synced で可)→ `window.__log.length=0` → `document.dispatchEvent(new Event('visibilitychange'))` → 1.5s。
  - 期待: `GET /api/pull` が **0 本**(ambient suppress が**維持**されている)。
  - 趣旨: pull-back が誤って ambient suppress を**解除していない**こと、pull-back と ambient suppress が**独立に共存**していることの確認(`pullBack` は `resumeAmbientPull` を呼ばない / suppress フラグは詳細 unmount まで立ち続ける)。
  - 補足: 詳細を離れていないので suppress は on のまま。pending が無いので flush(→pull-back)も起きず、結果 0 本となるのが正。

### 観点5: 詳細 A → 詳細 B の直接遷移で gate が正しく再評価される
- 詳細 A 滞在中から、**アプリ内リンクで詳細 B(別 examId)へ直接遷移**する(一覧を経由せず詳細→詳細。例: A の本文中リンクが無ければ、`/app/exams` 経由でも可だが、可能なら詳細→詳細の内部遷移で行い、`[examId]` 変化での gate 再評価を突く)。
  - 直接の詳細→詳細リンクが UI に無い場合は、`window.history` / リンク click を使い `/app/exams/<EXAM_B>` へ client nav する(hard reload にしない=spy 維持)。
- **手順a(B 入口 kick)**: 遷移直前に `window.__log.length=0` → B へ client nav → 1.5s 待つ。
  - 期待: `GET /api/pull` が **ちょうど 1 本**(B の入口 kick)。**0 本 = FAIL**(A の suppress が残って B の入口 kick が弾かれている=`[examId]` cleanup→再 effect が連鎖していない)/ **2 本以上 = FAIL**(二重 kick)。
- **手順b(B 滞在中の suppress)**: B 滞在のまま **pending 無し**で `window.__log.length=0` → `document.dispatchEvent(new Event('visibilitychange'))` → 1.5s → `window.dispatchEvent(new Event('online'))` → 1.5s。
  - 期待: `GET /api/pull` が **0 本**(B でも suppress が効いている)。
- 趣旨: gate が `[examId]` effect で **A cleanup(resume)→ B mount(入口 kick + suppress on)** を正しく連鎖させている証左。A の suppress が B に残留して B 入口 kick を弾く / 二重に走る、のいずれも起きないこと。

## クリーンアップ
- seed した Dexie `card_mutations` 行を削除(mutation_id `window.__pbmid` で。残すと visibilitychange 毎に retry)。
- 捨て exam **A・B 両方**を UI 削除(cascade で card / server card_mutations log 連動削除)。`/api/pull` で A・B 消失確認。
- Dexie card_mutations の pending=0 / total=0 を確認。

## 想定外/切り分け
- 観点2 で `GET /api/pull` が出る: ① pending mutation が残っていて pull-back が出た(Dexie 確認・除去)② suppress 未配線(gate が mount してない / フラグ未参照)。
- 観点4 で `POST` は出るが `GET /api/pull`(pull-back)が出ない: flush outcome が 'ok' 以外(orphan card で failed → CARD_ID が owner か確認)。
- 観点4 後続で `GET /api/pull` が出る: pending 行が残っている(flush→pull-back が再発)か、pull-back が suppress を解除した疑い(後者なら fail = `pullBack` と suppress の独立性が崩れている)。
- 観点1 / 観点5手順a で入口 pull が **0 本**: 内部遷移でなく hard reload になっていないか(spy 消失)/ gate 未 mount / kick→suppress 順序バグ(自分の suppress に弾かれた)。
- 観点1 / 観点5手順a で **2 本以上**: 入口 kick の二重発火。
- 観点5手順b で `GET /api/pull` が出る: B で suppress が効いていない([examId] 再 effect で suppress on が再確立されていない)。

## smoke 後
- 観点 1〜5 PASS → Stage 3 の 2 commit(`9de2121` Task3.1 / `6923236` Task3.2)に `[reviewed]` を amend。amend と push は OT が host から。
