# Tag-2b + Tag-2c stg smoke checklist

> 対象 commit: Tag-2b (card_tags 独立 pull stream + 取り直し) + Tag-2c (`tag_option_ids` handler) を統合した単一 commit (controller が後で積む)。
>
> **核心 (案 a)**: client は **ローカル即時反映を観測しない**。 mutation 送信 → **server に書き** → **自端末が pull で取り直し** → IDB を観測、 という実経路を必ず通す。 これは「`[A,B] → []`」 のような関連付け空集合化が別端末に伝わることを担保する設計 (`docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` §4)。
>
> Tag-2c の handler は client 側で optimistic に IDB を書き換えない (= `update_field` 経路に `tag_option_ids` を 1 entry 足しただけで、 IDB 反映は **後続の pull が card_tags stream + cards bulkPut 経由で行う**)。 したがって IDB を「fetch 直前」 と「pull 後」 で比較する。

## 環境情報

- URL: https://stg.recallmint.nekotest.net/app
- アカウント: `komail9server+clerk_test@gmail.com` / pw `komail9server` (memory `stg-smoke-login`)
- 対象 exam: `Sync1 Smoke Exam` (id=`08ec7835-db67-4e45-b402-db776ba93048`、 Tag-2a smoke で使用済)
- 対象 card: id=`030c1b55-8477-4907-8cb6-4f71d7518865` (Tag-2a smoke で残った `Smoke-2a-A`、 cleanup を 2b smoke 終了時にまとめる)
- IDB 名: `recallmint`

## 事前準備

1. ログイン + `/app/exams/<examId>` を 1 回開いて pull を完走させ、 IDB の baseline を整える。
2. DevTools console で **tag_options 2 件の id を控える** (UI が無いため IDB から取得):
   ```js
   const req = indexedDB.open('recallmint')
   req.onsuccess = () => {
     const tx = req.result.transaction('tag_options', 'readonly')
     const r = tx.objectStore('tag_options').getAll()
     r.onsuccess = () => console.log('tag_options:', r.result)
   }
   ```
   控えた option を `<UUID_A>` / `<UUID_B>` と呼ぶ。 0 件なら server admin SQL で 2 件先に INSERT (本 smoke の前提条件、 OT 判断)。
3. baseline 観測: 対象 cardId の card_tags が 0 件 / `cards.updated_at` の現値を記録。

## 観測コマンド (各観点で使い回す)

```js
// (A) mutation 送信 (fetch 直送、 UI 無いため DevTools console から)
async function sendTagOpts(cardId, value) {
  const mutId = crypto.randomUUID()
  const res = await fetch('/api/entity-mutations/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mutations: [{
        mutation_id: mutId,
        entity_type: 'card',
        entity_id: cardId,
        op: 'update_field',
        patch: { field: 'tag_option_ids', value },
        edited_at: new Date().toISOString(),
      }],
    }),
  })
  const json = await res.json()
  console.log('send result:', json, 'mutation_id:', mutId)
  return json
}

// (B) pull を手動 trigger: タブを切り替えて戻す (visibilitychange → 'visible' で PullTrigger が runGuardedPull を kick)。
//     代替: 5 秒待つ → entity-mutation-flush 経路の pullBack が裏で発火している可能性もある。
//     確実性のため、 観測前に `await new Promise(r => setTimeout(r, 5000))` で待つ。

// (C) IDB 観測 — card_tags 行
function readCardTags(cardId) {
  return new Promise((resolve) => {
    const req = indexedDB.open('recallmint')
    req.onsuccess = () => {
      const tx = req.result.transaction('card_tags', 'readonly')
      const idx = tx.objectStore('card_tags').index('card_id')
      const r = idx.getAll(cardId)
      r.onsuccess = () => resolve(r.result)
    }
  })
}

// (D) IDB 観測 — cards.updated_at
function readCardUpdatedAt(cardId) {
  return new Promise((resolve) => {
    const req = indexedDB.open('recallmint')
    req.onsuccess = () => {
      const tx = req.result.transaction('cards', 'readonly')
      const g = tx.objectStore('cards').get(cardId)
      g.onsuccess = () => resolve(g.result?.updated_at)
    }
  })
}
```

## 観点 (PASS/FAIL チェックリスト)

PASS = (1) 期待動作通り、 (2) console error 0、 (3) 全 API 200。

### A. Tag-2a regression (handler registry 化が壊れていないこと)

カード詳細編集 UI で操作 → IDB 観測。 全 6 件 + B.7/B.8 = 8 件すべて applied / sync_status=synced を維持すること。

- [ ] A.1 title 編集: `Smoke-2a-A` → `Smoke-2b-A` → IDB cards.title 反映、 synced
- [ ] A.2 sort_key `'' → null` 正規化: 入力欄をクリア → POST `value:""` → IDB cards.sort_key=null
- [ ] A.3 question_text 編集: 末尾に ` (smoke-2b)` 追記 → applied、 IDB 反映
- [ ] A.4 explanation_text `'' → null`: 値→クリア で IDB が文字列→null
- [ ] A.5 memo `'' → null`: 値→クリア で IDB が文字列→null
- [ ] A.6 options + correct_answer_ids 再生成: opt2.is_correct を toggle → applied、 IDB correct_answer_ids が server 再生成値で反映
- [ ] B.7 card 作成 (applyCardCreateWithId): 新規カード追加 → applied、 IDB に新 card row
- [ ] B.8 card 削除 (applyCardDelete): B.7 の card を削除 → applied、 IDB から消滅

### B. Tag-2c handler 経路 (DevTools fetch 直送 + 取り直し観測)

**重要**: 各 step は「fetch 直送 → pull を待つ → IDB を観測」 の順。 IDB を 「fetch 直前」 と「pull 後」 で比較する。

#### B.1 単発付与 `value=[UUID_A]`

期待: server で card_tags に 1 件 INSERT + cards.updated_at bump → 次回 pull で client の card_tags mirror に 1 件追加、 cards.updated_at が進む。

- [ ] 1. `before = await readCardTags(cardId)` (0 件のはず)、 `tsBefore = await readCardUpdatedAt(cardId)`
- [ ] 2. `await sendTagOpts(cardId, ['<UUID_A>'])` → response `{ok:true, applied:1, failed:[]}`
- [ ] 3. タブ切替 (hide → visible) で pull を kick、 5 秒待機
- [ ] 4. `after = await readCardTags(cardId)` → 1 件 (`option_id='<UUID_A>'`)
- [ ] 5. `tsAfter = await readCardUpdatedAt(cardId)` → `tsAfter > tsBefore` (ISO 文字列の lexicographic 比較で OK)

#### B.2 whole-set replace `value=[UUID_B]` (取り直し)

期待: server で `[UUID_A]` を全 DELETE → `[UUID_B]` INSERT + cards.updated_at bump → pull で「変更カード分の旧 card_tags 全削除 → 新集合 bulkPut」 が走り、 IDB に `UUID_B` のみ残る。 旧 `UUID_A` は **client 側で消える** (取り直し経路の正常動作)。

- [ ] 1. `await sendTagOpts(cardId, ['<UUID_B>'])` → applied:1
- [ ] 2. タブ切替で pull kick + 5 秒待機
- [ ] 3. `after = await readCardTags(cardId)` → 1 件 (`option_id='<UUID_B>'`)、 `UUID_A` の行は **存在しない**
- [ ] 4. `cards.updated_at` が更に進んでいる

#### B.3 空集合化 `value=[]` (案 a の核心)

期待: server で全 DELETE + INSERT 0 + cards.updated_at bump → pull で「cards 増分に当該 cardId が乗る → 当該 card_tags 全削除 → card_tags stream は当該 cardId について 0 件 (bulkPut 対象なし)」 → IDB から **完全に消える**。 これが「関連付けのみ外す」 の伝播が成立する所以 (旧設計では空集合化が別端末に届かなかった穴の対応)。

- [ ] 1. `await sendTagOpts(cardId, [])` → applied:1
- [ ] 2. タブ切替で pull kick + 5 秒待機
- [ ] 3. `after = await readCardTags(cardId)` → **0 件** ← これが PASS の条件
- [ ] 4. `cards.updated_at` が更に進んでいる

#### B.4 値検証失敗ケース (server defensive)

各ケースで response が **per-mutation failed[]** を返し、 card_tags / cards.updated_at どちらも **変化なし**。

- [ ] B.4.1 存在しない option_id: `await sendTagOpts(cardId, ['00000000-0000-0000-0000-000000000000'])`
  - response `{ok:true, applied:0, failed:['<mutId>']}`
  - card_tags 変化なし、 cards.updated_at 変化なし
- [ ] B.4.2 他 user の option_id: 別アカウントの tag_option id があれば混在送信 (OT 環境次第、 skip 可)。 期待は B.4.1 と同様。
- [ ] B.4.3 非 uuid: `await sendTagOpts(cardId, ['not-a-uuid'])` → envelope の `z.uuid()` で弾かれて failed
- [ ] B.4.4 101 件超: `await sendTagOpts(cardId, Array.from({length: 101}, () => crypto.randomUUID()))` → `max(100)` 違反で failed
- [ ] B.4.5 重複排除: `await sendTagOpts(cardId, ['<UUID_A>', '<UUID_A>', '<UUID_B>'])` → applied:1、 pull 後 IDB は 2 件 (`UUID_A` + `UUID_B`、 重複の `UUID_A` は 1 件のみ)

### C. cascade purge (option / card 削除起点、 取り直しとは独立経路)

#### C.1 tag_option 削除

期待: option を削除すると、 server cascade で該当 option_id を持つ card_tags 行が消える + tombstone が乗る。 pull で client は tombstone を見て該当 option_id の card_tags mirror を purge。

- [ ] 1. C.1 前に B.4.5 で `[UUID_A, UUID_B]` 状態にしておく
- [ ] 2. DevTools fetch で tag_option 削除 mutation を直送 (registry の `entity_type='tag_option' / op='delete'` 経路):
  ```js
  await fetch('/api/entity-mutations/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mutations: [{
        mutation_id: crypto.randomUUID(),
        entity_type: 'tag_option',
        entity_id: '<UUID_A>',
        op: 'delete',
        patch: {},
        edited_at: new Date().toISOString(),
      }],
    }),
  }).then(r => r.json()).then(console.log)
  ```
  - 注: `entity_type='tag_option' / op='delete'` の registry 配線がまだなら本観点は **N/A (Tag-3 以降)** と記録、 skip 可
- [ ] 3. タブ切替 + 5 秒待機
- [ ] 4. IDB `card_tags` から `option_id='<UUID_A>'` 行が消え、 `UUID_B` だけ残ること

#### C.2 card 削除

- [ ] 1. B.4.5 後に対象 card を削除 (Tag-2a B.8 と同経路、 UI から)
- [ ] 2. IDB card_tags 該当 cardId 行が **全消滅** (tombstone 経由の cascade purge)
- [ ] 3. ※ 本 smoke の対象 card は cleanup で残す必要があるため、 C.2 は別途用意した throwaway card で実施 (B.7 で作る新規 card に B.4.5 後の状態を作ってから削除)

### D. 全体

- [ ] D.1 console error 0 (warnings=Clerk dev key のみ許容)
- [ ] D.2 全 API 200 (500 / 4xx なし、 ただし envelope 不正の意図的 400 を除く)
- [ ] D.3 IDB `entity_mutations` が flush 後 pending=0 / syncing=0 / failed=0 を維持
- [ ] D.4 pull response (Network パネル) に `cursors.card_tags` が含まれ、 連続 pull で値が進む (or null)
- [ ] D.5 IDB `sync_meta` に `card_tags_cursor` key が ISO 文字列で保存される

## FAIL 時の再現手順 + 原因仮説テンプレ

```
観点 #: B.3
症状: IDB card_tags が 1 件 (UUID_B) 残ったまま
再現手順:
  1. <ここに console コマンドを順に貼る>
原因仮説候補:
  A. server handler が cards.updated_at bump を忘れた (→ cards 増分 pull に当該 cardId が乗らず、 client が「変更カード集合の card_tags 全削除」 step を実行しなかった)
     確認: Network 直前 pull response の cards[].id に対象 cardId が含まれているか
  B. client pull.ts の tx 内順序が崩れた (cards bulkPut → 全削除 → bulkPut の順序が変わった)
     確認: コード差分 grep
  C. card_tags stream cursor が「DELETE は cursor に乗らない」 性質のためで、 本観点は cards stream 経由でのみ伝わる前提 (期待) を覆していないか
     確認: server pull route で card_tags.rows が空、 cards.rows に当該 cardId が乗っていれば期待通り
```

## cleanup (smoke 完了後にまとめて)

Tag-2a smoke で残った変更 + Tag-2b smoke で追加した card_tags を restore する:

- [ ] Tag-2a 残: title `Smoke-2a-A` → `C9-edit-A` に戻す
- [ ] Tag-2a 残: sort_key `null` → `109` に戻す
- [ ] Tag-2a 残: question_text 末尾の ` (smoke-2a)` を削除
- [ ] Tag-2a 残: options opt2.is_correct true → false (correct_answer_ids `["1","2"]` → `["1"]`)
- [ ] Tag-2b smoke で追加した card_tags を `await sendTagOpts(cardId, [])` で空にする
- [ ] Tag-2a Smoke-2b-A への title 変更も C9-edit-A に戻す (A.1 で改名済の場合)
- [ ] C.1 で削除した tag_option があれば admin SQL で復元 (OT 判断、 stg のみのため再生成も可)
- [ ] B.7/B.8 で生成→削除した card は B.8 で消えているはず、 残っていれば手動削除

## 参照

- 設計判断: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` §4 (案 a) / §5 (whole-set replace + updated_at bump)
- plan: `docs/superpowers/plans/2026-06-06-tag-2b-2c-card-tags-sync.md`
- Tag-2a smoke 報告: `docs/superpowers/sessions/2026-06-06-tag-2a-stg-smoke.md`
