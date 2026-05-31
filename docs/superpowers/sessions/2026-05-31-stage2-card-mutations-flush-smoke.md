# Stage 2 (試験詳細 local-first 書込化) — stg smoke 手順

- 日付: 2026-05-31
- 対象: client outbox + flush engine + layout 常駐 trigger(`lib/sync/card-mutations.ts` / `card-mutation-flush.ts` / `app/(app)/app/_components/card-mutation-flush-trigger.tsx`)
- 実施: Claude Code(後続 prompt、chrome-devtools で stg ログイン済セッションを駆動)
- 完了後: 問題なければ Stage 2 の 3 commit に `[reviewed]` を amend(本 Stage は削除/外部副作用の新規 logic は含まず flush 配線だが、外部 API 発火を伴うため OT 確認 or Claude Code smoke 後に付与)

## 前提 / 認証 hand-off
- Stage 2 では **編集 UI は未配線**(UI は従来 server action 直叩きのまま)。enqueue は DevTools/test から呼べる状態まで。本 smoke は **flush engine + trigger + Stage1 endpoint の結合**を確認する。
- 認証: stg(https://stg.recallmint.nekotest.net)にテストユーザーでログイン済みのタブで実施。flush の `POST /api/card-mutations/bulk` と pull-back の `GET /api/pull` は session cookie が自動で乗る。
- `card-mutation-flush-trigger.tsx` は `(app)` layout 常駐のため、`/app/*` のどのページでも mount 済(ambient: mount/visibilitychange/online + pagehide)。

## 検証ストーリー
DevTools Console から Dexie `card_mutations` に **pending mutation を 1 件 seed**(= `enqueueCardMutation` が生成する行と同形)→ `visibilitychange` を発火 → 常駐 trigger が `kick('visibilitychange')` → `runGuardedCardMutationFlush` → `flushAllPendingCardMutations` が bulk POST → server 適用 → 該当行が Dexie 上で `sync_status='synced'` → flush 成功で `pullBack('card-mutation-flush')` が `GET /api/pull` を発火。

> 注: 「console から enqueue」は app module が window 非公開のため、raw IndexedDB 書込で pending 行を直接 seed する(`enqueueCardMutation` の出力と同形 = sync_status:'pending' の card_mutations 行)。enqueue/coalesce ロジック自体は Task 2.1 の unit test で担保済。本 smoke の対象は flush→server→synced→pull-back の結合。

## 事前準備(破棄前提のテストデータ)
- Stage 1 smoke と同様、`手動で試験を作成` で捨て exam を作り、`＋カードを追加` で card を 1 枚作る。`/api/pull` でその `EXAM_ID` と `CARD_ID`(実在・owner)を取得。update_field の対象に使う(memo を更新)。
- 本番/既存データには触れない。終了後に捨て exam を削除(cascade で card / card_mutations も連動削除)。

## 手順(chrome-devtools / Console)

### 1. pending mutation を seed(raw IndexedDB)
ログイン済 stg タブの Console で実行(`CARD_ID` は実在の owner card に置換):
```js
await (async () => {
  const CARD_ID = '<existing-owner-card-uuid>';
  const mutation_id = crypto.randomUUID();
  const row = {
    mutation_id, card_id: CARD_ID, op: 'update_field',
    patch: { field: 'memo', value: 'stage2 smoke ' + Date.now() },
    edited_at: new Date().toISOString(), sync_status: 'pending',
    last_attempted_at: null,
  };
  // 'recallmint' DB の 'card_mutations' store に直接 add(++local_id は auto)
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('recallmint'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction('card_mutations', 'readwrite');
    tx.objectStore('card_mutations').add(row);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  window.__smoke2 = { CARD_ID, mutation_id };
  return { seeded: row };
})();
```
期待: seeded 行が返る。

### 2. flush を発火(visibilitychange)
タブが可視のまま、visibilitychange を dispatch して常駐 trigger の `kick` を呼ぶ:
```js
document.dispatchEvent(new Event('visibilitychange'));
```
(trigger は `document.visibilityState==='visible'` のみ kick。可視タブで dispatch すれば発火する。)

### 3. 反映確認(数百 ms 待ってから)
```js
await (async () => {
  await new Promise(r => setTimeout(r, 1500));
  const { CARD_ID, mutation_id } = window.__smoke2;
  // 3a. Dexie 上で当該 mutation の sync_status を確認 → 'synced' 期待
  const db = await new Promise((res, rej) => { const r = indexedDB.open('recallmint'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  const rows = await new Promise((res, rej) => {
    const tx = db.transaction('card_mutations','readonly');
    const out = []; const cur = tx.objectStore('card_mutations').openCursor();
    cur.onsuccess = e => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
    cur.onerror = () => rej(cur.error);
  });
  const mine = rows.find(r => r.mutation_id === mutation_id);
  // 3b. server 適用を /api/pull で確認 → 当該 card の memo が更新されている
  const pull = await fetch('/api/pull').then(r => r.json());
  const card = pull.cards.find(c => c.id === CARD_ID);
  return { mutation_sync_status: mine ? mine.sync_status : '(row 消失)', card_memo: card ? card.memo : '(card なし)' };
})();
```
期待: `mutation_sync_status: 'synced'` かつ `card_memo` が seed した値。

### 4. pull-back 発火確認(Network)
- chrome-devtools の network 一覧で、`POST /api/card-mutations/bulk`(flush)の直後に `GET /api/pull`(pull-back の `runGuardedPull`)+ study-days pull が走っていることを確認。
- `pullBack('card-mutation-flush')` は flush outcome==='ok' 時のみ発火するため、これが見えれば onFlushed → pullBack 配線が生きている証左。

## 観点と PASS 判定
1. **flush 成功 → synced**: 手順3 で `mutation_sync_status==='synced'`(server が受理し markCardMutationsSynced が効いた)。
2. **server 適用**: `card_memo` が seed 値(endpoint が update_field を実 DB に適用)。
3. **pull-back 発火**: 手順4 で flush POST 直後に `GET /api/pull` が観測される。
4. **(任意)冪等再送**: 手順1〜2 をもう一度(別 mutation_id・同 card・同 field で seed → flush)→ synced。または同 mutation_id を再 seed して flush → server は skip(applied 据え置き)、Dexie 行は synced。
5. **(任意)trigger ambient**: seed 後に `online` event を dispatch、または別ページ遷移→詳細再入場でも flush が走り synced 化することを確認。

## 想定外/切り分け
- mutation が `sync_status:'pending'` のまま残る場合:
  - Network で `POST /api/card-mutations/bulk` が出ているか(出ていない=trigger 未発火、visibilitState や mount を確認)。
  - response が `failed:[mutation_id]`(card が他 user/不在=orphan → CARD_ID が owner card か確認)。
  - 401(未認証=ログイン切れ)。
  - lock-busy(他タブが flush 中=複数タブを閉じて再試行)。
- pull-back の `GET /api/pull` が出ない: flush outcome が 'ok' 以外(no-pending/transient/permanent)。response を確認。

## クリーンアップ
- 捨て exam を UI 削除(cascade で card / card_mutations 連動削除)。`/api/pull` で消失確認。

## smoke 後
- 観点 1〜3 PASS → Stage 2 の 3 commit(`205a02e` Task2.1 / `017ea87` Task2.2 / `3f73c14` Task2.3)に `[reviewed]` を amend。amend と push は OT が host から(または本スレ規律に従う)。
