-- 非所有者 app role への最小権限付与。owner=postgres 実行前提。
-- grants は DB 毎に適用され、test:iso は global-setup が migrate 後に流す。
GRANT USAGE ON SCHEMA public TO recallmint_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO recallmint_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO recallmint_app;
