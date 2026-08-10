-- 画像 asset GC 日次 cron(spec §3.2)向け SECURITY DEFINER 関数。cron lane は
-- app role (recallmint_app) で動くが、RLS 下では tenant context (app.user_id) を
-- 張らない限り public.assets を 1 行も読めない — 「GC すべき作業がある user は誰か」
-- を知るには tenant 横断の集合演算が要る。本関数はその集合演算のみを迂回する。
--
-- 迂回するもの: assets の RLS(user_id の列挙のみ)。行データ(object_key 等)は
-- 一切返さない(RETURNS SETOF uuid)。
-- なぜ安全か: 返るのは uuid 集合のみで、この uuid を得ても他 user の行を直接読める
-- わけではない — 呼出側(cron)が各 uuid ごとに tenant tx(app.user_id を set)を
-- 張って初めて当該 user の行を読める。本関数自身は tenant tx を張らない・
-- 行を返さない両方の理由で「呼出側が必ず tenant tx を使うこと」に安全性が依存する。
-- cron lane 専用(spec §3.2)。UI/webhook 等の対話的経路から呼ばない。
--
-- 3 arm は現行 reconciler(scripts/gc-image-assets.ts)の 3 つの WHERE と同値
-- (spec §3.2 = core の作業対象行の定義そのもの):
--   arm① status IN ('deleting','deleted')                 == collect の対象
--   arm② unreferenced_at IS NOT NULL                       == markClear ∪ promote の対象
--        (markClear: unreferenced_at IS NOT NULL AND EXISTS refs /
--         promote: status IN ('reserved','ready')
--           AND unreferenced_at < now() - grace AND NOT EXISTS refs
--         — 両者とも unreferenced_at IS NOT NULL に包含される)
--   arm③ status IN ('reserved','ready') AND unreferenced_at IS NULL
--        AND NOT EXISTS(refs)                               == markSet の対象
CREATE OR REPLACE FUNCTION public.app_list_asset_gc_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT a.user_id FROM public.assets a
  WHERE a.status IN ('deleting','deleted')
     OR a.unreferenced_at IS NOT NULL
     OR (a.status IN ('reserved','ready') AND a.unreferenced_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.card_asset_refs r WHERE r.asset_id = a.id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_list_asset_gc_user_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_list_asset_gc_user_ids() TO recallmint_app;
