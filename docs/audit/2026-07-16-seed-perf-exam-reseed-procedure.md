# seed-perf-exam 再 seed 手順 fact-finding(read-only)

> **RLS-P1 注記**: 本 doc は 2026-07-16 時点の調査記録だが、実行手順は live runbook として維持する。RLS-P1 で env 変数名が `DATABASE_URL` → `DATABASE_URL_ADMIN`(script は `getAdminDb()` 経由)に改名されたため、本文中の `DATABASE_URL` / `getDb()` 表記は現行名に置き換えてある(guard のロジック・token list 自体は無変更)。

- **日付**: 2026-07-16
- **性質**: read-only 現物調査のみ(script 実行・DB 接続・実装変更なし)。Sprint I smoke 前の stg 再 seed 手順確定。
- **調査 HEAD**: `develop`(W5 含む)。全て `scripts/seed-perf-exam.ts` + `lib/db/index.ts` の実コードで裏取り。

## 1. 実行形

- **`--conditions=react-server` 必須(確定)**: `scripts/seed-perf-exam.ts:86` が `@/lib/db` を import → `lib/db/index.ts:4` に `import 'server-only'`。素の実行では server-only の default export が throw する。`--conditions=react-server` で react-server 条件が empty(no-op)に解決される(header `:11-16` 記載どおり)。
- **module-load 時に要求される env = `DATABASE_URL_ADMIN` のみ(確定・RLS-P1 で `DATABASE_URL` から改名)**: seed の import 連鎖(`dotenv/config` / `node:crypto` / `drizzle-orm` / `@/lib/db` / `@/lib/db/schema`)に、DATABASE_URL_ADMIN 以外の module-scope env 読み・fail-fast は**無い**(`lib/db/index.ts` / `lib/db/schema.ts` の `process.env.[A-Z_]+` grep = DATABASE_URL_ADMIN のみ)。DATABASE_URL_ADMIN は `getAdminDb()`(`lib/db/index.ts:31-39`)内で lazy に読まれ、未設定なら throw。→ **Clerk / Stripe / R2 等の env は不要**(DATABASE_URL_ADMIN だけ渡せば他の fail-fast は発火しない)。
- **`.env.local` の自動ロードは効かない(注意)**: seed は `import 'dotenv/config'`(`:83`)を持つが、これは **`.env`(既定)を読むだけで `.env.local` は読まない**。∴ `.env.local` に stg URL を置いていても、素の実行では拾われない。
- **正しい env 供給 = `node --env-file=<file>`(GC v2 で確立した形と一致)**: `node --env-file=.env.stg-seed --conditions=react-server --import tsx scripts/seed-perf-exam.ts ...`。`--env-file`(Node native)が指定 file を process.env に先読み → `dotenv/config` は既存を上書きしないため file の値が生きる。**接続文字列(パスワード平文)を CLI に書かずに済む**。
  - `pnpm tsx --conditions=...`(header の例)は `--conditions` は通るが、`--env-file` は Node flag ゆえ `node --import tsx` 形が確実。
- **不明**: `.env.local` の `DATABASE_URL_ADMIN` が **stg を指すか dev/local を指すか**は CC から確認不可(secret・未読)。**dev を指すなら `--env-file=.env.local` は dev DB を seed してしまう**。→ stg 専用の env file(header `:9` が示唆する `.env.stg-seed`・gitignore 済であること)に stg URL(6543)を置き、それを `--env-file` で指すのが安全。

## 2. 実在する flag(全リスト・file:line)

`parseArgs`(`:99`)は `--flag`(→ true)/ `--flag=value`(→ string)を解釈。main で参照される flag:

| flag | file:line | 挙動 |
|---|---|---|
| `--user-id=<uuid>` | `:272` | **必須**(L3 guard・未指定で `:274` exit(1))。対象 user の内部 DB UUID |
| `--cards=N` | `:283` | カード数(既定 **300**)。無効値は `:288` exit(1) |
| `--cleanup` | `:284` | `[PERF-SEED]%` exam 削除モード(下記 §3)|
| `--dry-run` | `:285` | DB 書込なしで予定を出力(下記)|
| `--with-answers[=ratio]` | `:296` | 回答記録投入(既定 ratio 0.5)|

- **CC 前回提示手順との差分**: `--dry-run` / `--user-id` / `--cleanup` は**全て実在**(claude.ai の「未確認」疑義に対し = 実在を確認)。存在しない flag を提示してはいない。**唯一の欠落 = SEED_FORCE=1**(§3)。
- **`--dry-run` は本当に DB 書込をしない(確定)**: 全書込点が `if (dryRun) { console.log } else { db.insert/delete }` で gate。cleanup dry-run は対象列挙後 `:340` return、通常 path は `:573` で「dry-run 完了(DB 書込なし)」+ return(exam INSERT `:480` / cards INSERT `:584` は else 側)。
- **多択カード混入(W5)= 常時**(flag 制御でない): `:515` `optionCount = i % 75 === 37 ? 20 : 4`。300 件中 ~4 枚が 20 択。uid mint も 4/20 択とも `randomUUID()`(`:517` 相当)。

## 3. SEED_FORCE ガードの実際

> **⚠ 実測補正(2026-07-16)**: 下記 line 39-41 の「提示 URL は token を含まない → L2 exit(1) → **SEED_FORCE=1 必須**」は**誤り**だった。OT が `SEED_FORCE` 無しで `--dry-run --cleanup` を実行したところ **`SEED_FORCE: OFF` の表示のまま正常走行**した。原因と正しい guard 実態は §3-bis(本節末)を参照。L2 の**コード記述(substring 検査)は正しい**が、full URL(secret)を CC が未読ゆえ「token を含まない」という**推論が外れた**。

3 層(`:235-278`):
- **L1**(`:237-245`): `VERCEL_ENV === 'production' || NODE_ENV === 'production'` → exit(1)。**SEED_FORCE でも bypass 不可**。ただしローカル実行では両 env が通常 unset ゆえ**発火しない**(= prod DB を local から叩く場合の防御にならない)。
- **L2**(`:248-267`): `DATABASE_URL_ADMIN` を lowercase して `['stg','test','dev','localhost','127.0.0.1']` のいずれかを `includes` するか判定(`:255-258`)。含まなければ exit(1)、ただし **`SEED_FORCE === '1'` で bypass**(`:259`)。
- **L3**(`:270-279`): `--user-id` 必須。

**claude.ai の指摘は正しい(重大)**:
- 提示 URL `aws-1-ap-northeast-1.pooler.supabase.com` は safe token を**一つも含まない** → **L2 は exit(1)**。∴ cleanup/seed には **`SEED_FORCE=1` が必須**(CC 前回手順の欠落)。
- かつ **Supabase pooler URL は stg も prod も同形**(`...pooler.supabase.com`・"stg" token 無し)。∴ **L2 は stg/prod を判別していない**。SEED_FORCE=1 は stg のために必要だが、それを立てると同じ URL 形の**prod にも通ってしまう**(L2 の唯一の URL チェックを無効化)。
- **実際の安全境界**:
  - DATABASE_URL_ADMIN(= どの DB か)は **operator が正す責任**。コードは Supabase URL に対し stg/prod を検証しない。
  - L1 は「production env で実行しない」だけ(local からは効かない)。
  - **L3(`--user-id`)= 実質の bounding**: cleanup/seed は指定 user のデータにしか触れない(§4)。テストアカウント UUID を渡す限り、仮に prod DB に向いても触れるのは「そのテスト user の [PERF-SEED] exam」に限定される。
  - → ガードが守っているもの = 「production env での実行拒否(L1)」「user scope 限定(L3)」。**守れていないもの = Supabase URL の stg/prod 判別(L2)**。

## 3-bis. L2 実測補正と破壊 script ガード実態(2026-07-16)

### なぜ SEED_FORCE 無しで通ったか(現物 file:line)

- L2 は `if (!looksSafe && process.env.SEED_FORCE !== '1') process.exit(1)`(`:259-267`)。**exit するのは `looksSafe` が false かつ SEED_FORCE 未設定の時だけ**。SEED_FORCE OFF で走った = **`looksSafe === true`** だった。
- `looksSafe = safeTokens.some(token => dbUrl.toLowerCase().includes(token))`(`:256-258`)。`safeTokens = ['stg','test','dev','localhost','127.0.0.1']`(`:255`)。→ **`.env.local` の `DATABASE_URL_ADMIN` 文字列のどこかに、これらのいずれかが substring として含まれていた**。
- **検査対象は接続文字列全体**: scheme / username(`postgres.<project-ref>`)/ **password** / host / port / dbname / query の全部を lowercase 連結して `includes`。前回 §3 の「pooler URL は token を含まない」は、**OT が chat で提示した host 断片(`aws-1-ap-northeast-1.pooler.supabase.com`)だけを見た推論**。CC は full URL(secret)を未読ゆえ、実際に project-ref / username / password 等に token が含まれていた事実を捉えられなかった。
- **どの token が match したかは不明**(secret 未読)。host 側(`...pooler.supabase.com` / `aws-1-ap-northeast-1` / `postgres`)には `stg/test/dev/localhost/127.0.0.1` は現れないので、match は **secret 部分(project-ref か password 等)**。CC は推測で埋めない。
- **dry-run だから gate されなかったのではない**: L2 は `main()` 冒頭(`:247-267`)で cleanup/dryRun 分岐(`:318`)より**前**に無条件評価される。∴ dry-run/cleanup でも L2 は走る。通った理由は `looksSafe===true` の一点。

### L2 はさらに弱い(次の実装者への警告)

- substring 検査は **password も対象**にする。長いランダム password が偶然 `dev`/`stg`/`test`(3-4 char)を含めば、**prod URL でも `looksSafe===true` になり SEED_FORCE 不要で通る**(false positive)。逆に token を含まない正当な stg URL は SEED_FORCE=1 が要る(false negative)。
- Supabase の stg/prod pooler URL は構造上ほぼ同形(host に stg/prod token 無し)ゆえ、**L2 は stg/prod 境界として設計上機能しない**。前回結論「L2 は stg/prod を判別しない」は正しく、実測でむしろ**より弱い**(password 誤 match で prod を通しうる)と判明した。
- ∴ 「SEED_FORCE=1 が必須」は **URL 依存で一般には成り立たない**。実際の `.env.local` では不要だった。**`SEED_FORCE` の有無を安全指標にしてはならない**。

### 破壊 script のガード実態(横断・「ガードがあるから安全」の誤解防止)

| script | env 拒否 | URL チェック | scope 限定 | dry-run |
|---|---|---|---|---|
| `seed-perf-exam.ts` | L1: `NODE_ENV/VERCEL_ENV==='production'` で exit(`:237-245`・**local では両 env unset ゆえ無効**)| L2: URL substring 弱ヒューリスティック(`:255-267`・password 誤 match・SEED_FORCE=1 で bypass)| L3: `--user-id` 必須(`:272-279`)= 実質 bounding | `--dry-run`(write ゼロ)+ `--dry-run --cleanup`(削除対象 identity 列挙)|
| `gc-image-assets.ts`(GC reconciler)| grace<30 の prod 拒否(`:509-516`・**同じく production env 時のみ・local 無効**)| **無し**(L2 相当の URL チェックは存在しない)| `--user` scope(`:545`)| `--dry-run`(referenced/divergence 件数で間接 identity)|

- **共通の穴**: どの破壊 script も「env 変数が literal `production`」以外では**自動で prod DB を止めない**。local shell から `--env-file` で prod URL を指せば L1/grace ガードは素通り。
- **実効的な安全境界(これだけが確実)**:
  1. **operator が DATABASE_URL_ADMIN(GC はさらに R2 env 4 種)を実行前に目視で正す** — 唯一の確実な境界。コードは Supabase URL の stg/prod を判別しない。
  2. **`--user` / `--user-id` scope で blast radius を 1 テスト user に限定** — 万一向き先を誤っても、触れるのは指定 user のデータ(seed = `[PERF-SEED]%` exam / GC = その user の未参照 asset)に bounded。
  3. **dry-run を先行**(seed = `--dry-run --cleanup` の列挙 / GC = referenced>0 + divergence 件数)。
  - → 「ガードがあるから安全」は誤り。L1 / L2 / grace ガードは heuristic であり、**prod DB を local から叩く事故を構造的には防げない**。守りは operator の env 目視 + scope + dry-run の三点。

## 4. `--cleanup` の削除範囲

- 実 DELETE(`:343-351`): `db.delete(exams).where(and(eq(exams.userId, userId), like(exams.name, '[PERF-SEED]%')))`。→ **指定 user の `[PERF-SEED]%` exam のみ**(FK CASCADE で当該 exam の cards / card_tags も削除)。
- `tagCategories` / `tagOptions` は削除しない(header `:58`・他 PERF-SEED 再利用のため)。
- → 破壊範囲は「指定 user の [PERF-SEED] 試験」に bounded。**別 user・非 [PERF-SEED] exam・タグマスタには及ばない**。

## 5. 破壊操作前の read-only identity check

**組込みの `--dry-run --cleanup` が identity check そのもの**(`:319-341`):削除対象の `[PERF-SEED]%` exam を **id + name で列挙して DB 書込なしで return**。→ OT は cleanup 実行前にこれを走らせ、
- 出力が**テストアカウントの [PERF-SEED] 試験**(件数・タイムスタンプ名)なら向き先 = 想定の stg + user で正しい。
- 出力が空/想定外/大量なら向き先違いを疑い中断。

GC v2 の「assets 件数で stg/prod 間接判定」と同型の read-only 事前確認。

## 6. driver / ポート

- driver = **postgres-js**(`lib/db/index.ts:6-7` `drizzle-orm/postgres-js` + `postgres`)。`getAdminDb()` は `postgres(url, { prepare: false })`(`:36`)= Supabase **transaction pooler(6543)要件**(prepared statement 無効化)。app runtime(`getDb()`)と同一設定。
- seed は **INSERT / DELETE のみ・DDL 無し**(exams/cards/tagCategories/tagOptions/cardTags への insert/delete のみ・CREATE/ALTER 無し)→ **6543 transaction pooler で問題なし**(migration の 5432 直結は不要)。理解は正しい。
- `.env.local`(または `.env.stg-seed`)の `DATABASE_URL_ADMIN` が **6543 を指しているならそのまま使える**。

## 確定手順(コピペ可・パスワードを CLI に書かない)

前提: `.env.stg-seed`(gitignore 済)に **stg の `DATABASE_URL_ADMIN`(6543 pooler・owner 接続。RLS-P1)** を記載。`<uuid>` = テストアカウントの内部 DB UUID(Supabase `users` テーブルで Clerk ID から逆引き)。

```bash
# ① dry-run + cleanup = 削除対象を列挙(DB 書込なし・identity check)
SEED_FORCE=1 node --env-file=.env.stg-seed --conditions=react-server --import tsx \
  scripts/seed-perf-exam.ts --dry-run --cleanup --user-id=<uuid>
#   → 出力の [PERF-SEED] 試験名/件数が想定(stg・テスト user)であることを目視確認

# ② cleanup 実行(uid 無し legacy seed を削除)
SEED_FORCE=1 node --env-file=.env.stg-seed --conditions=react-server --import tsx \
  scripts/seed-perf-exam.ts --cleanup --user-id=<uuid>

# ③ dry-run で新 seed 内容を確認(任意・DB 書込なし)
SEED_FORCE=1 node --env-file=.env.stg-seed --conditions=react-server --import tsx \
  scripts/seed-perf-exam.ts --dry-run --user-id=<uuid>

# ④ 新 seed 投入(W5: uid 付き options + 20択カード分散混入・既定 300 件)
SEED_FORCE=1 node --env-file=.env.stg-seed --conditions=react-server --import tsx \
  scripts/seed-perf-exam.ts --user-id=<uuid>
```

- 回答記録も要るなら ④ に `--with-answers`(既定 50%)or `--with-answers=0.7`。
- `SEED_FORCE=1` は secret でないゆえ CLI 記載可(env file 内でも可)。
- **`--env-file` が指す file の DATABASE_URL_ADMIN が stg・6543 であることを ① の前に確認**(dev を指していると dev DB を触る)。CC からは file 内容未確認 = 不明。

## 不明点

- `.env.local` / `.env.stg-seed` の DATABASE_URL_ADMIN が stg を指すか(secret・未読)。→ OT が向き先を確認(① の dry-run 出力が実質の確認)。
- テストアカウントの内部 DB UUID の実値(Supabase / Clerk で OT 取得)。
