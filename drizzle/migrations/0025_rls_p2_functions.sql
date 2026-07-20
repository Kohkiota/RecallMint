-- RLS-P2 (0025): tenant-context loud 検出関数 + users 特殊経路の SECURITY DEFINER 3 本。
-- functions のみ。RLS policy (ENABLE ROW LEVEL SECURITY + CREATE POLICY) は
-- db/policies/ の versioned SQL で別適用 (spec §2.9)。旧コードは本関数を参照しない
-- ため 0025 は additive (RLS off・挙動不変)。

-- app.user_id GUC が未設定 (NULL) または空文字なら loud に RAISE する。
-- SQLSTATE 'P0RLS' = 本プロジェクト専用のカスタムコード。標準 28000 (認証系) や
-- 42501 (権限) と混同しないため専用採用。policy USING/WITH CHECK から
-- (SELECT public.app_current_user_id()) の形で呼ばれ、context 未供給の配管ミスを
-- 静かな 0 行でなく例外として表面化させる (spec §2.1)。SECURITY INVOKER (default)。
CREATE OR REPLACE FUNCTION public.app_current_user_id() RETURNS uuid
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'tenant context (app.user_id) is not set'
      USING ERRCODE = 'P0RLS';
  END IF;
  RETURN v::uuid;
END;
$$;
--> statement-breakpoint

-- getCurrentUser (claim なし fallback) / contact / handleUserDeleted resolve が使う。
-- clerk_id で users 1 行を引く現行ロジックの忠実移植。SETOF users = 全列返却
-- (getCurrentUser の User 契約が全列を要し、露出面は pre-RLS の app role 直 SELECT と
-- 等価。呼出 3 箇所限定。spec §2.3)。scrub 済み行は clerk_id=NULL ゆえ構造的に 0 行。
CREATE OR REPLACE FUNCTION public.app_bootstrap_user_from_clerk(p_clerk_id text)
  RETURNS SETOF public.users
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.users WHERE clerk_id = p_clerk_id LIMIT 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_bootstrap_user_from_clerk(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_bootstrap_user_from_clerk(text) TO recallmint_app;
--> statement-breakpoint

-- Stripe webhook / upgrade actions が退会後 log+skip 判定のため使う。whereFor 4 arm
-- (id / clerkId / stripeCustomerId / scheduleId) の忠実移植。返却は最小 2 列 (id,
-- deleted_at)。p_by は allowlist、範囲外は RAISE。退会済み行も返す (呼出側が
-- deleted_at で判定するため)。spec §2.3。
CREATE OR REPLACE FUNCTION public.app_resolve_user_for_stripe(p_by text, p_value text)
  RETURNS TABLE(id uuid, deleted_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_by = 'id' THEN
    RETURN QUERY SELECT u.id, u.deleted_at FROM public.users u WHERE u.id = p_value::uuid;
  ELSIF p_by = 'clerkId' THEN
    RETURN QUERY SELECT u.id, u.deleted_at FROM public.users u WHERE u.clerk_id = p_value;
  ELSIF p_by = 'stripeCustomerId' THEN
    RETURN QUERY SELECT u.id, u.deleted_at FROM public.users u WHERE u.stripe_customer_id = p_value;
  ELSIF p_by = 'scheduleId' THEN
    RETURN QUERY SELECT u.id, u.deleted_at FROM public.users u
      WHERE u.scheduled_downgrade_schedule_id = p_value;
  ELSE
    RAISE EXCEPTION 'invalid p_by: %', p_by USING ERRCODE = 'P0RLS';
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_resolve_user_for_stripe(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_resolve_user_for_stripe(text, text) TO recallmint_app;
--> statement-breakpoint

-- handleUserDeleted の scrub tx から呼ぶ。現行 scrub UPDATE
-- (deleted_at=now(), email=NULL, clerk_id=NULL WHERE id=$1) の忠実移植 (再設計禁止)。
-- VOLATILE (書込ゆえ STABLE を付けない)。definer 自衛: p_user_id が現在の
-- app.user_id と不一致なら RAISE (SECURITY DEFINER は RLS を迂回するため、context と
-- 異なる任意 uuid の scrub 経路を関数内で封じる)。0 行 = no-op (再削除は resolve 段の
-- 0 行で実質不達。「影響 1 行以外で RAISE」する代替案は不採用 — spec §7)。spec §2.3。
CREATE OR REPLACE FUNCTION public.app_scrub_deleted_user(p_user_id uuid)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_user_id <> public.app_current_user_id() THEN
    RAISE EXCEPTION 'scrub target does not match tenant context'
      USING ERRCODE = 'P0RLS';
  END IF;
  UPDATE public.users
    SET deleted_at = now(), email = NULL, clerk_id = NULL
    WHERE id = p_user_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_scrub_deleted_user(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_scrub_deleted_user(uuid) TO recallmint_app;
