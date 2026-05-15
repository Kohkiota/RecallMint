# pnpm.overrides for transitive vuln: rationale + maintenance pattern

> **Source**: plan00 Phase 1 G-1 (`adea60a` deps upgrade hotfix) で導入の運用 pattern
> 保存 (2026-05-01)。 transitive vuln (上流 dep が修正版 release してない) の対処と、
> 永久残置を防ぐ maintenance 規律。

## 1. 背景

plan00 で `pnpm audit --prod` が 2 件の MOD vuln を検出 (`uuid` via `svix` /
`postcss` via `next`)。 直接 dep ではない transitive 経路で、 上流 dep (`svix` /
`next`) が修正版 release を出すまで通常手段では解消不可。 pnpm.overrides で強制
上書きが現実解だが、 override 自体が **永久残置 risk** (上流修正後も override が
残り続ける) を持つため、 rationale doc + 解除 trigger doc + 確認 cadence を制度化。

## 2. Lessons Learned

### 2.1 transitive vuln は pnpm.overrides で強制上書きが現実解

直接 dep でない transitive vuln (例: `your-app → svix → uuid` で uuid に vuln) は:
- 上流 dep (`svix`) が修正版 (uuid 新 version 採用) を release するまで `pnpm install`
  で解消不可
- 自前 dep を直接 upgrade しても影響なし

`package.json` の `pnpm.overrides` で強制 version 上書き = 全 transitive 経路を
override version に統一。 lock file 再生成で解消。

### 2.2 各 override は rationale + 解除 trigger を doc 化が必須

override は「一時 workaround」 として存続するが、 doc なしだと:
- なぜ存在するか分からなくなる → 「不要かも」 削除で再 vuln 化
- 上流修正後も誰も解除しない → 永久残置で transitive 制約継続

各 override に対して:
- **rationale**: vuln advisory ID + 直接 dep / transitive 経路 + 上流状況
- **解除 trigger**: 上流 release 条件 + audit clean 条件

両方を doc 化 (例: `docs/superpowers/lessons/<file>.md` or `docs/notes/`) し、
override 追加 commit でこの doc に追記。

### 2.3 確認 cadence の運用

override の解除 timing 自動検出は困難 = 手動 cadence で確認:

| timing | 内容 |
|---|---|
| Phase / sprint 終了時 | `pnpm outdated` + `pnpm why <pkg>` で transitive resolution が override 不要 version に追いついたか確認 |
| 月 1 回程度 | `pnpm audit --prod` で MOD/HIGH vuln 0 件維持を確認 |
| dependabot / renovate 導入時 | PR で対象 dep の bump があるたびに rationale doc を re-check |

## 3. 推奨運用 pattern

### 3.1 override 追加 checklist

- [ ] vuln advisory ID + 影響範囲を確認 (`pnpm audit --prod`)
- [ ] 直接 dep / transitive 経路を `pnpm why <pkg>` で確認
- [ ] 上流 dep の release 状況確認 (`pnpm view <upstream> dependencies`)
- [ ] `package.json` の `pnpm.overrides` に entry 追加
- [ ] `pnpm install --force` で lock file 再生成、 想定 version 解決確認
- [ ] `pnpm audit --prod` で当該 advisory 0 件確認
- [ ] `pnpm tsc --noEmit` / `pnpm test` / `pnpm build` 全 pass 確認
- [ ] rationale doc に entry 追加 (vuln + 直接 dep / transitive / 上流状況 / 解除 trigger)
- [ ] commit message で「pnpm.overrides 追加 + rationale doc 参照」 明示

### 3.2 override 削除 checklist

- [ ] 解除 trigger 条件確認 (`pnpm why <pkg>` で全 path が override 不要 version)
- [ ] `package.json` の `pnpm.overrides` から entry 削除
- [ ] `pnpm install --force` で lock file 再生成
- [ ] `pnpm audit --prod` で 0 件確認
- [ ] `pnpm tsc --noEmit` / `pnpm test` / `pnpm build` 全 pass 確認
- [ ] rationale doc から entry 削除
- [ ] commit message で「pnpm.overrides 解除」 明示

### 3.3 解除 trigger 確認 cmd

```bash
# transitive resolution 確認
pnpm why <pkg>

# 上流 dep の release 状況確認
pnpm view <upstream-pkg> dependencies

# vuln 解消確認
pnpm audit --prod
```

## 4. アンチパターン

- **override 追加 without rationale doc** → 永久残置 risk、 「なぜ存在するか分からない」 で削除 trigger 逃す
- **確認 cadence なし** → 上流修正後も override 残置で transitive 制約継続、 maintenance 負債累積
- **override 追加で test pass 確認せず** → 強制 version 上書きが動作互換性破壊する可能性、 production 障害化 risk

## 5. plan00 case study への参照

- 導入 commit: `adea60a` (Phase 1 G-1 deps upgrade hotfix)
- 関連 advisories:
  - `uuid`: GHSA-w5hq-g745-h8pq (buffer bounds check 不備、 v3/v5/v6 影響、 v4 経路は軽微)
  - `postcss`: GHSA-qx2v-qp2m-jg93 (style unescape XSS、 build time のみ)
- 上流 release 状況 (2026-05-01 時点):
  - `svix` → `uuid@10`、 `uuid@^14` へ追従 release なし
  - `next` → `postcss@8.4.31` 一部経路固定、 `^8.5.10` 追従 release なし
- 現 overrides (`package.json`):
  ```json
  "pnpm": {
    "overrides": {
      "uuid": "^14.0.0",
      "postcss": "^8.5.10"
    }
  }
  ```

## 6. 関連リンク

- [pnpm.overrides doc](https://pnpm.io/package_json#pnpmoverrides)
- [GHSA advisory database](https://github.com/advisories)
- [npm audit doc](https://docs.npmjs.com/cli/audit) (pnpm audit と同等概念)
