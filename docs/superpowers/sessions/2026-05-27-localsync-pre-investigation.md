# LocalSync MVP pre-investigation

- 起票日: 2026-05-27
- 種別: investigation / session log
- 関連 roadmap: `docs/cache-fix-roadmap.md`
- 種別: 調査専用 (実装変更 / commit なし)
- 目的: LocalSync MVP spec 起草前に未確認 6 点を一括確定する

---

## 全体結論サマリ

| # | 項目 | 結論 | LocalSync MVP spec への影響 |
|---|---|---|---|
| 1 | study_sessions flush | 既存 `/api/review-events/bulk` で session upsert 完結。独立 flush 経路は **不要** | session 系は spec から外して OK、 cards 系のみ scope |
| 2 | 演習中 cards snapshot | `StudySessionHost` mount 時 1 回 resolve → React state 固定。 演習中の pull は表示に影響しない | 「演習中 pull 抑制」 は性能/帯域目的の OK、 整合性救済は不要 |
| 3 | revokeSession() 即時性 | **即時 invalidate されない**。 JWT expiry (~60s auto refresh) まで valid。 Clerk 公式に明記 | Sprint ⑤ (deletedAt 撤去) は zombie window 再現の trade-off 判断要 |
| 4 | card_mutations 既存状況 | server schema / Dexie schema 両端で **定義済**、 helper + bulk API のみ未実装 | server migration 不要、 LocalSync MVP は client helper + endpoint 新設のみ |
| 5 | sync_meta.dbUserId | **不在** (key 3 種は pull cursor のみ) | user 切替検知用 key を新規追加要 |
| 6 | Web Locks API | repo 全体で **未使用** | 初導入、 lock key 命名規則を spec で策定要 |

---

## 1. study_sessions の flush 実装状況

### 結論
既存 `/api/review-events/bulk` が **answer_events bulk insert と並行して study_sessions も upsert** している。 LocalSync MVP で独立 flush 経路は不要。

### 証拠
- **server upsert ロジック**: `app/api/review-events/bulk/route.ts:130-172`
  - `studySessions` PK = sessionId、 `onConflictDoUpdate` で session 行を upsert
  - `setWhere: eq(studySessions.userId, user.id)` で tenant isolation (cross-tenant write 完全防止、 §C-1)
  - 再送時 set 対象は `completedAt` + `status` のみ。 `cardIds` は initial insert のみ書く (空配列倒し race を構造的に防ぐ、 §I-1)
  - upsert 失敗時は 500 返却 (events 反映に進まない)
- **client flush 経路**: `lib/sync/review-events.ts:207-282` の `flushPendingEvents(sessionId)`
  - events 0 件でも session の `status` / `completed_at` を server に送るために fire される (`:222` コメント)
  - session sync_status は「該当 session 内全 event が synced」 のときのみ `synced` に倒す (`:269-272`)
- **server schema**: `lib/db/schema.ts:516-551`
  - `studySessions` PK = sessionId、 client 採番 uuidv4
  - `updatedAt` $onUpdate で自動更新 (§13.14 「全テーブル updated_at」 整合)
  - `status` enum: `'active' | 'completed' | 'abandoned'`

### LocalSync MVP spec への影響
- session 系は LocalSync MVP の scope から外す。 spec は cards (update/delete) の local-first 化のみ
- 既存 bulk endpoint の pattern (event_id UNIQUE + ON CONFLICT DO NOTHING、 per-event tx、 failed[] 部分失敗) を card_mutations bulk endpoint でも踏襲する

---

## 2. 演習中の cards snapshot 保存状況

### 結論
`StudySessionHost` が mount 時に **1 回だけ cards を resolve して React state に保存**、 SessionRunner には props 経由で渡る。 演習中に Dexie に新 pull が走っても表示や判定は壊れない。 React state による事実上 snapshot は十分成立。

### 証拠
- **resolve flow**: `app/(app)/app/study/smart/_components/study-session-host.tsx:46-91`
  - mount 時 useEffect (deps=`[]`、 props 変化追従しない) で:
    1. `getDueCardsFromDexie(userId, sessionLimit)` 試行 → 0 件 / throw なら `serverCards` で fallback
    2. `chosen` を `setResolvedCards()` で state 保存 (`:90`)
    3. `chosen.map((c) => c.id)` で `card_ids` を確定し `createStudySession` で session 採番 (`:80-85`)
- **SessionRunner**: `app/(app)/app/study/smart/_components/session-runner.tsx:132`
  - `cards: Card[]` を props で受領、 内部 state には保存せず `cards[idx]` (`:159`) で都度参照
  - cards 配列自体は props 不変 (`StudySessionHost` 側で 1 回 resolve した後の参照を持ち回す)
- **source 整合**: cards 由来は **Dexie 優先 + server fallback** (`study-session-host.tsx:60-66`)。 server SSR は `app/(app)/app/study/smart/page.tsx:33-38` で `getSessionCards()` を try/catch (S-local-4)

### 演習中に新 pull が走ったときの影響
- SessionRunner は props 経由の cards を参照しており、 IDB が裏で更新されても **同 session 内では旧 snapshot を維持** (再 mount しない限り反映されない)
- 判定ロジック (`session-runner.tsx:201-209`、 `handleAnswer`) は `current.options` を参照、 これも props 経由の Card 由来
- = 「演習中 pull 抑制」 は性能 (帯域節約 / DB 負荷削減) 目的で十分妥当だが、 **整合性救済の意味は薄い** (snapshot で既に保護されている)

### LocalSync MVP spec への影響
- 「演習中 pull 抑制」 は性能 KPI として spec に入れる。 「session 中 snapshot の整合性」 を理由にする必要はない
- pending card_mutations が cards table に反映されていない状態で演習が始まる場合の動作は別途検討事項 (= 「演習開始時に pending mutations を Dexie 上で local apply するか」 は spec で判断要)

---

## 3. Clerk revokeSession() の即時性

### 結論
**即時 invalidate されない**。 既発行 JWT は self-contained で local 検証されるため、 revokeSession() 呼出後も **次の auto refresh (Clerk 仕様で ~60s) まで** valid。 middleware / `auth()` も JWT 検証で通過する。

### 証拠 (Context7 引用)

**Clerk stateless authentication の限界** (公式):
> "JWTs cannot be revoked due to their self-contained nature. Since JWT validation happens locally without consulting a central authority, there is no direct mechanism to invalidate them before their natural expiration. This creates challenges for session management, as forcibly terminating a user's session either requires waiting for the token to expire or rotating signing keys, which affects all active sessions."
>
> source: `https://github.com/clerk/clerk-docs/blob/main/docs/guides/how-clerk-works/overview.mdx`

**revokeSession() の効果範囲** (公式):
> "POST /sessions/{session_id}/revoke ... User will be signed out from the particular client the referred to."
>
> source: `https://github.com/clerk/clerk-docs/blob/main/docs/reference/backend/sessions/revoke-session.mdx`

**JWT refresh interval**:
> "A user's session token is a short-lived JWT that Clerk automatically refreshes every 60 seconds."
>
> source: `https://github.com/clerk/clerk-docs/blob/main/docs/guides/sessions/force-token-refresh.mdx`

### 解釈
- revokeSession() は Clerk の session resource を `revoked` 状態にする
- ただし JWT は self-contained で署名検証のみで認証成立 → server に revoke 状況を問合せない
- 結果として「revoke 直後でも next refresh まで認証通過」 = **最大 60s の zombie window**
- 強制ログアウト的に即時 effect を得るには signing key rotation が必要 (全 active session に影響、 副作用大)

### LocalSync MVP spec への影響
- 直接影響なし (LocalSync MVP は cards local-first、 認証フローを触らない)
- cache-fix roadmap **Sprint ⑤ (layout の deletedAt 撤去 + revokeSession)** の判断材料:
  - 撤去すると最大 60s の zombie window 再現 (削除済 user が /app/* を view し続ける)
  - 受容可否は OT 判断 (deletedAt redirect の即時性を取るか、 SELECT コスト撤去を取るかの trade-off)
- 別途、 BFCacheGuard (`_components/bfcache-guard.tsx`) は middleware/layout 再 trigger で zombie net の補強だが、 layout チェック撤去後はこちらも効かなくなる

---

## 4. 既存 `card_mutations` の現状 (server + Dexie)

### 結論
**server schema / Dexie schema 両端で定義済**。 client helper (`lib/sync/card-mutations.ts`) と bulk endpoint (`/api/card-mutations/bulk`) のみ未実装。 server migration 不要、 LocalSync MVP は新規ファイル 2 本で済む見込み。

### server schema (`lib/db/schema.ts:601-623`)

| 列 | 型 | 制約 |
|---|---|---|
| `id` | uuid PK defaultRandom | server 内部 id |
| `mutation_id` | uuid NOT NULL **UNIQUE** | client 採番、 ON CONFLICT DO NOTHING 用 |
| `card_id` | uuid NOT NULL | FK cards.id ON DELETE CASCADE |
| `user_id` | uuid NOT NULL | FK users.id ON DELETE CASCADE |
| `patch` | jsonb NOT NULL | client 確定の部分更新 payload |
| `edited_at` | timestamptz NOT NULL | client 編集時刻 |
| `applied_at` | timestamptz nullable | server apply 時刻 (server 側 sync 状態) |
| `created_at` | timestamptz defaultNow | server 受領時刻 |

**index**: `card_mutations_card_idx (card_id, edited_at)` / `card_mutations_user_idx (user_id, edited_at)`

**server 側 sync_status 列は無し**。 `applied_at` の null/値 で「未 apply / apply 済」 を表現。 client の 4 値 SyncStatus とは別系統。

### Dexie schema (`lib/client-db.ts:144-152` + `:196`)

```ts
export type ClientCardMutation = {
  local_id?: number          // auto-increment
  mutation_id: string         // client 採番、 server UNIQUE 用
  card_id: string
  patch: Record<string, unknown>
  edited_at: string
  sync_status: SyncStatus     // 'pending' | 'syncing' | 'synced' | 'failed'
  last_attempted_at?: string | null
}
// store: card_mutations: '++local_id, mutation_id, card_id, sync_status'
```

### sync 状態 (3 状態 vs 4 状態)
- Dexie 型は **4 値** (`SyncStatus = pending/syncing/synced/failed`、 `lib/client-db.ts:30`)
- LocalSync MVP roadmap で「3 状態 (pending/synced/failed)」 と決まっているため、 spec で **`syncing` を使わない方針を明文化**するか、 型を 3 値に narrow するか要判断 (Dexie 型撤回には version migration 要否確認)

### helper / endpoint の現状
- `lib/sync/card-mutations.ts` **不在** (`lib/sync/` 配下に cards / exams / review-events / study-days / sync-meta のみ)
- `app/api/card-mutations/` ディレクトリ **不在**

### LocalSync MVP spec への影響
- server schema migration **不要** (`card_mutations` table は既に DB に存在)
- 新規実装物:
  1. `lib/sync/card-mutations.ts` — `recordCardMutation` / `getPendingCardMutations` / `flushPendingCardMutations` (review-events.ts pattern 流用)
  2. `app/api/card-mutations/bulk/route.ts` — review-events bulk pattern 流用 (per-mutation tx + failed[] 部分失敗 + ON CONFLICT DO NOTHING)
- patch 圧縮 (同 card_id + field の最新だけ送る) は helper 内で実装、 server 側は受領 payload を順次 apply するだけで OK
- `mutation_id` 命名: spec roadmap は `${clientId}:${uuid}` だが server schema は `uuid` 型なので、 **形式統一が必要** (server を text に変える / client が UUID v4 で済ます、 のいずれか)

---

## 5. `sync_meta.dbUserId` の現在の保存状況

### 結論
**dbUserId は sync_meta に保存されていない**。 既存 key は pull cursor の 3 種のみ。 LocalSync MVP の「user 切替時 IDB clear」 のために新規追加要。

### 証拠 (`lib/sync/sync-meta.ts:12-17`)

```ts
export const SYNC_META_KEYS = {
  lastCardPullAt: 'last_card_pull_at',
  lastExamPullAt: 'last_exam_pull_at',
  lastStudyDayPullAt: 'last_study_day_pull_at',
} as const
```

- get/set は `string` value 限定 (ISO8601 cursor 専用 narrow、 `:25-26`)
- repo grep (`lib/sync/` / `lib/client-db.ts`) で `dbUserId` / `db_user_id` の出現 0 件

### LocalSync MVP spec への影響
- 新規 key 追加: 例えば `currentDbUserId: 'current_db_user_id'` を `SYNC_META_KEYS` に追加
- 書込タイミング: pull 成功時に「現在 user の id (Clerk userId or 内部 UUID)」 を保存
- user 切替検知: 起動時 / pull 前に sync_meta.currentDbUserId と現 user.id を比較、 不一致なら全 Dexie store を clear → 新 user の pull を fire
- 値の形は spec で決定要 (Clerk userId か内部 dbUserId か、 = JWT 由来か getCurrentUser 由来か)。 推奨: 内部 dbUserId (JWT 経由で取得済 = `getAuthContext().dbUserId`、 一意性が tenant 分離と一致)

---

## 6. Web Locks API の既存利用状況

### 結論
**repo 全体で未使用**。 LocalSync MVP で初導入、 lock key 命名規則を spec で策定要。

### 証拠
- `find ... | xargs grep -l "navigator.locks\|navigator\.locks\|Web Locks\|LockManager"` 結果 **0 件**
- `lib/sync/` 配下 review-events.ts / cards.ts / exams.ts / study-days.ts の flush 実装はいずれも lock なし (= 多重発火は server 側 ON CONFLICT で吸収する設計)

### LocalSync MVP spec への影響
- 初導入につき命名規則を spec で確定要。 案:
  - `recallmint:localsync:flush:${dbUserId}` (sync 全般)
  - `recallmint:localsync:cards:flush:${dbUserId}` (table 別に細分するなら)
- TypeScript で `navigator.locks.request(key, callback)` の lib.dom 型は標準で存在 (型補完追加不要)
- 取得 mode は `'exclusive'` (default、 既存 helper の二重発火を完全防止) を spec で明示
- 旧 browser (iOS Safari 16.4 未満) は LockManager 非対応の可能性 → fallback (no-op で進める / 排他なし) を spec で決める

---

## やらないこと (本 sprint scope 外、 確認のため明示)

- 実装変更 / commit
- LocalSync MVP の spec / plan 起草 (次 sprint)
- Sprint Small Fix (PullTrigger 移動 / prefetch 漏れ / `/app/cards/[id]` 廃止 / notifyOps 404) の調査 (cache-fix roadmap Step 2)
- Sprint ⑤ (deletedAt 撤去) 実装判断 (本 sprint は revokeSession 即時性の確認のみ、 撤去可否は別判断)

---

## 次手 (LocalSync MVP spec で決めるべき項目)

本調査の結果から、 spec 起草時に明示決定が必要な 5 項目:

1. **mutation_id 形式統一**: server schema は `uuid`、 roadmap 案は `${clientId}:${uuid}`。 server 側を `text` に migrate するか / client UUID v4 だけにするか
2. **sync_status 3 値 narrow**: Dexie 型 `SyncStatus` は 4 値、 LocalSync MVP は 3 値。 `syncing` を使わない方針の明文化 (Dexie 型変更は version migration 要否確認)
3. **sync_meta.currentDbUserId の値の形**: Clerk userId or 内部 dbUserId (推奨は後者)
4. **Web Locks lock key 命名規則** + iOS Safari 16.4 未満 fallback
5. **演習開始時の pending mutations の local apply 要否** (整合性救済が必要かの判断、 spec で明示)
