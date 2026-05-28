# T8 連打防御調査 — OCR upload submit 連打防御の既存実装確認

**日付**: 2026-05-28  
**調査タスク**: S2.0.5 OCR pipeline 改修 / Task 8  
**調査担当**: Claude Code  
**方針**: コード変更ゼロ / 調査・記録のみ

---

## 調査概要

「同 user 同ファイル連続 click (= upload submit の連打)」に対する既存防御の
file:line レベルの確認と、三段防御の十分性評価。

---

## 1. Client 側防御 (upload-form.tsx)

**ファイル**: `app/(app)/app/upload/_components/upload-form.tsx`

### 1-1. phase state と isSubmitting フラグ

```
L113: const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
L115: const isSubmitting = phase.kind === 'submitting'
```

- `Phase` 型は `'idle' | 'submitting' | 'error'` の discriminated union (L74-L86)
- `isSubmitting` は `phase.kind === 'submitting'` の派生フラグ (L115)
- コメント L114: "UI controls の disable 判定に集約利用" と明示

### 1-2. submitDisabled 集約

```
L232-L240:
  const submitDisabled =
    entries.length === 0 ||
    anyProcessing ||
    anyError ||
    totalExceeded ||
    !destinationReady ||
    overQuota ||
    alreadyAtQuota ||
    overPageCap
```

連打防御直接要因は `phase.kind === 'submitting'` であり、`submitDisabled` には
含まれていない点に注意。

### 1-3. submit ボタンの disabled 制御

```
L779-L780:
  <Button
    type="submit"
    disabled={submitDisabled || phase.kind === 'submitting'}
```

- `submitDisabled` と `phase.kind === 'submitting'` を OR で組み合わせる
- submit 中 (`phase.kind === 'submitting'`) は `submitDisabled` の値に関わらず必ず disable
- **実確認**: L780 が client 側の連打防御の核心

### 1-4. handleSubmit と phase 遷移のタイミング

```
L497-L503:
  function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault()
    setLongRunning(false)
    setPhase({ kind: 'submitting' })   // <-- urgent priority でコミット
    void runProcess()
  }
```

- `handleSubmit` は通常の `setState` (urgent priority)
- コメント L491-L495: "phase 切替を **urgent priority** で行う (startTransition で wrap しない)"
  - React 19 の concurrent renderer が `submitting` を必ず commit するよう意図設計
  - `runProcess()` は `void` 投げ捨て (await しない)

### 1-5. 連打窓の評価

**実確認した事実**:
- `setPhase({ kind: 'submitting' })` と `void runProcess()` は同期的に続けて呼ばれる
- React の `setState` は同期コミットではない（次の render まで UI は更新されない）
- ただしコメント (L491-L495) によれば、urgent priority で `startTransition` を使わず呼ぶため、
  React 19 では優先度高で即座に commit される設計

**微小窓 (仮説)**:
- `handleSubmit` 呼び出しから React が次の render で button を disabled に切り替えるまでの間、
  理論上はごく短い時間窓が存在しうる
- ただし通常のユーザー操作 (物理クリック) ではこの窓に別クリックが入ることは実質困難

**programmatic 二重 submit のリスク (仮説)**:
- `form.submit()` 等の programmatic 呼び出しや、`requestAnimationFrame` レベルの連続 dispatch では
  button disabled 切り替え前に 2 回 `handleSubmit` が呼ばれる可能性は排除できない
- しかし server 側に advisory lock + in-flight check があるため、仮に 2 つの request が飛んでも
  server 側で後発が弾かれる (下記 §2 参照)

### 1-6. file input の disable

```
L584: disabled={isSubmitting}
```

- submitting 中はファイル追加も不可

---

## 2. Server 側防御 (process.ts)

**ファイル**: `app/(app)/app/upload/_actions/process.ts`

### 2-1. guard transaction の構造

```
L214-L226 (コメント):
// 「1 user 1 OCR ジョブ」 を 2 機構の併用で担保する:
//   (A) advisory xact lock: 同時起動 (ms 窓) の race を防ぐ。
//   (B) in-flight 行 check: 先行ジョブが OCR 走行中 (lock は source_documents INSERT
//       の commit で既に解放済) の並列起動を弾く実効ルール。

L238: const guardResult = await db.transaction(async (tx): Promise<GuardTxResult> => {
```

guard transaction は単一の `db.transaction()` で実行、その中に (a)(b) 両機構を含む。

### 2-2. (a) advisory xact lock

```
L239-L247:
    // (a) advisory xact lock — 同時起動 (ms 窓) の race loser を弾く
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${user.id})) AS locked`,
    )
    const locked = lockResult[0]?.locked
    if (!locked) {
      return { outcome: 'in_progress' }
    }
```

- `pg_try_advisory_xact_lock` は取得失敗時に即 false を返す (wait しない)
- xact lock なので transaction の commit/rollback で自動解放
- `hashtext(user.id)` で user ごとのキーを生成
- lock 取得失敗 → `outcome: 'in_progress'` → `UPLOAD_IN_PROGRESS` エラーを返す (L363-L369)

### 2-3. (b) in-flight 行 check

```
L250-L271:
    // (b) in-flight 行 check — 先行ジョブ走行中 (lock 解放済) の並列起動を弾く
    const inflightThreshold = new Date(Date.now() - STALE_PROCESSING_MS)
    const inflight = await tx
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.userId, user.id),
          eq(sourceDocuments.status, 'processing'),
          gte(sourceDocuments.createdAt, inflightThreshold),
        ),
      )
      .limit(1)
    if (inflight.length > 0) {
      return { outcome: 'in_progress' }
    }
```

- 条件: 同 user / status='processing' / createdAt が `STALE_PROCESSING_MS` (15分) 以内
- `STALE_PROCESSING_MS = 15 * 60 * 1000 = 900,000 ms` (`lib/exams/source-doc-status.ts` L28)
- 先行 OCR ジョブが走行中 (advisory lock は source_documents INSERT commit で解放済) でも弾ける
- stale orphan (>15分前の残骸) は guard を通過させ、新規 job を許可する安全網

### 2-4. source_documents INSERT と advisory lock の保持タイミング

```
L306-L359: (exam INSERT + source_documents INSERT = 同一 transaction 内)
    const sourceDocInsert = await tx
      .insert(sourceDocuments)
      .values({ ..., status: 'processing', ... })
      ...
    return { outcome: 'success', ... }
  }) // <-- transaction commit = advisory lock 解放
```

- advisory lock は `source_documents` INSERT の commit まで保持される
- INSERT commit 後に lock 解放 → 同時起動の別リクエストは lock 取得を試みて失敗するか、
  INSERT 後は in-flight 行として検出されるか、いずれかで弾かれる

### 2-5. OCR pipeline は transaction 外で実行

```
L439-L491: pipelineResult = await runOcrPipeline(...)
```

- OCR (最大 600s) は guard transaction の外で実行
- lock が OCR 本体に持ち込まれることはない (コメント L224-L225)

### 2-6. エラーコードのマッピング

```
L58-L63 (コメント):
//   UPLOAD_IN_PROGRESS: 同一 user の OCR ジョブが既に走行中 (S1.9.4)
//                       advisory xact lock 取得失敗 (ms 窓の race) または
//                       in-flight processing 行が存在 (先行ジョブ走行中) の
//                       いずれかで発生する。
```

両ケース (advisory lock 失敗 / in-flight check) が同一 error code `UPLOAD_IN_PROGRESS` に集約。

---

## 3. 合わせ技の評価

### 3-1. 三段防御の構成まとめ

| 段 | 機構 | 場所 | file:line |
|---|---|---|---|
| 1 | submit button disabled (`phase.kind === 'submitting'`) | client | upload-form.tsx L779-L780 |
| 2 | advisory xact lock (`pg_try_advisory_xact_lock`) | server DB | process.ts L242-L247 |
| 3 | in-flight 行 check (status='processing' + 15分窓) | server DB | process.ts L257-L271 |

### 3-2. シナリオ別評価

**シナリオ A: UI 上の素早い連打 (通常ユーザー操作)**

- 1 回目クリック → `handleSubmit` → `setPhase({ kind: 'submitting' })` → React urgent render
- 次の render 以降、button は `disabled={true}` になりクリック不可
- **評価**: client (段 1) で完全に防御。server まで届かない。

**シナリオ B: React render 前の極短窓内の連続 click (物理的に困難)**

- 理論上 2 つの `handleSubmit` が呼ばれうる
- どちらも `processUpload` を呼び出す
- 先着が guard transaction の advisory lock を取得 → 後着は lock 失敗 → `UPLOAD_IN_PROGRESS` 返却
- **評価**: server (段 2) で防御。二重 OCR job は起動されない。

**シナリオ C: programmatic 二重 submit (悪意ある / テスト操作)**

- 同時に 2 つの `processUpload` が Server Action として呼ばれる最悪ケース
- 同一 Postgres 接続で advisory lock が競合 → 先着が取得、後着は即 false
- **評価**: server (段 2) で防御。

**シナリオ D: 先行ジョブ走行中 (lock 解放済) に新規 submit**

- 先行ジョブは source_documents INSERT 後に transaction commit → advisory lock 解放
- OCR 走行中に別 submit → guard transaction 起動 → advisory lock は取得できる (先行ジョブは解放済)
- in-flight 行 check: 先行ジョブの source_documents が status='processing' かつ createdAt < 15分前 → 検出
- **評価**: server (段 3) で防御。先行ジョブ中の並列起動を弾く。

**シナリオ E: stale orphan の残骸 (>15分前の processing 残骸)**

- OCR 中断 (Vercel 強制終了等) で status='processing' のまま残った行
- createdAt が `STALE_PROCESSING_MS`(15分) を超えている → in-flight check の対象外
- → 新規 submit は guard を通過できる (意図設計)
- **評価**: 想定内の設計。OT が手動 update または `reconcileStaleProcessing` で解消。

### 3-3. advisory lock の hashtext 衝突

- `hashtext(user.id)` で 32bit int に射影するため、異なる user.id が同じハッシュになる確率は 1/2^32 ≒ 0.00000002%
- user.id は UUID v4 形式
- 衝突しても「別 user の OCR job を一時直列化」するだけで correctness には影響なし
- コメント L228: "correctness には影響しないため許容" と明記

---

## 4. 結論

### 十分性判定

**既存の三段防御で「同 user 同ファイル連打による二重 OCR job 起動」は防げる。**

- **client 側** (段 1): 通常の UI 連打は `phase.kind === 'submitting'` による button disabled で完全ブロック
- **server 側** (段 2): ms 窓の race (同時起動) は advisory xact lock で弾く
- **server 側** (段 3): 先行ジョブ走行中の並列起動は in-flight 行 check で弾く

### 残る窓と実害評価

| 窓 | 内容 | 実害 |
|---|---|---|
| React render 前の極短窓 | 物理クリック 2 回が 1 render 前に入る | server (段 2) で最終ブロック、実害なし |
| programmatic 二重 submit | API 直叩き等 | server (段 2) で最終ブロック、実害なし |
| hashtext 衝突 | 異なる user が同キー | 別 user を一時直列化するだけ、correctness 影響なし |

いずれのケースも server 側で最終的に弾かれるため、二重 OCR job が起動することはない。

### 最終結論

**「既存で十分、追加実装不要」**

ただし以下の点は別途 OT 判断に委ねる:
- programmatic submit に対する追加の server-side rate limit (IP / user-id 単位) が必要かどうか
- `hashtext` 衝突による別 user 直列化を将来的に改善するかどうか (現状は確率的に無視できる)

これらは correctness バグではなく、将来的な改善候補として Sprint 外で検討することを推奨。

---

## 5. 調査対象ファイル一覧

- `app/(app)/app/upload/_components/upload-form.tsx` (全体確認)
- `app/(app)/app/upload/_actions/process.ts` (全体確認)
- `lib/exams/source-doc-status.ts` L1-L50 (STALE_PROCESSING_MS 確認)

---

*調査者: Claude Code (T8 実行) | コード変更: ゼロ*
