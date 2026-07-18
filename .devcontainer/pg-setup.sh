#!/bin/bash
# -----------------------------------------------------------------------------
# PostgreSQL 17 常駐 cluster セットアップ(Iso-1: 実 PG 2 テナント統合テスト
# `pnpm test:iso` の乗り物)。
#
# post-create.sh の step から呼ばれ、同一 script を手動でも実行できる
# (= manual と script の乖離ゼロ。OT rebuild checklist の担保対象)。
# 冪等: 既 install / 既 cluster / 既起動 いずれの状態でも安全に再実行できる。
#
# 接続契約(allow-list と一致): 統合テストは 127.0.0.1:5432 に postgres/postgres で
# TCP 接続する。DB 名は recallmint_test に完全一致(globalSetup が drop/create)。
# noble の default apt は PG16 のため PGDG repo を追加して 17 を install する
# (Stripe / Chrome と同じ keyring + sources.list.d 方式)。
# -----------------------------------------------------------------------------
set -euo pipefail

fail() { echo "✗ POSTCONDITION FAIL: $*" >&2; exit 1; }

PG_MAJOR=17
PG_PORT=5432
PG_TEST_DB=recallmint_test

echo "==> PostgreSQL ${PG_MAJOR} setup (test:iso 用 常駐 cluster)"

# --- install (PGDG repo)---
if [ ! -d "/usr/lib/postgresql/${PG_MAJOR}" ]; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
  . /etc/os-release
  echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq "postgresql-${PG_MAJOR}"
fi

# --- cluster (apt が postgresql-common 経由で main を作る。無ければ作る)---
if ! pg_lsclusters -h 2>/dev/null | awk '{print $1}' | grep -qx "${PG_MAJOR}"; then
  pg_createcluster "${PG_MAJOR}" main --port "${PG_PORT}"
fi

# --- start (init system 無 container ゆえ明示 start。既起動なら restart で吸収)---
pg_ctlcluster "${PG_MAJOR}" main start >/dev/null 2>&1 \
  || pg_ctlcluster "${PG_MAJOR}" main restart >/dev/null 2>&1 \
  || true

# --- role: postgres の password を設定(127.0.0.1 TCP scram 接続用・冪等)---
su postgres -c "psql -p ${PG_PORT} -c \"ALTER USER postgres PASSWORD 'postgres';\"" >/dev/null

# --- test DB: globalSetup が drop/create するが postcondition 接続確認用に用意 ---
if ! su postgres -c "psql -p ${PG_PORT} -tAc \"SELECT 1 FROM pg_database WHERE datname='${PG_TEST_DB}'\"" \
     | grep -qx 1; then
  su postgres -c "createdb -p ${PG_PORT} ${PG_TEST_DB}"
fi

# --- role: recallmint_app(RLS-P1 最小権限 app role・非所有者・冪等)---
# 存在すれば作らず属性のみ矯正(ALTER は無条件で流し、CREATE 直後の状態と再実行後の
# 状態を一致させる)。password は throwaway(grants は db/roles/recallmint_app-grants.sql、
# ここでは role 作成のみ。適用は別 task / OT)。
if ! su postgres -c "psql -p ${PG_PORT} -tAc \"SELECT 1 FROM pg_roles WHERE rolname='recallmint_app'\"" \
     | grep -qx 1; then
  su postgres -c "psql -p ${PG_PORT} -c \"CREATE ROLE recallmint_app LOGIN PASSWORD 'recallmint_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\"" >/dev/null
fi
su postgres -c "psql -p ${PG_PORT} -c \"ALTER ROLE recallmint_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS LOGIN;\"" >/dev/null

# --- postcondition: pg_isready でなく実 TCP 接続で「認証 + 権限 + 版」を検証 ---
# (pg_isready は listen 状態しか見ない = 認証/権限/major を保証しない: Codex 指摘)
command -v pg_ctlcluster >/dev/null || fail "postgresql-${PG_MAJOR} が未 install"
PGPASSWORD=postgres psql -h 127.0.0.1 -p "${PG_PORT}" -U postgres -d "${PG_TEST_DB}" -tAc "SELECT 1" \
  | grep -qx 1 || fail "127.0.0.1:${PG_PORT}/${PG_TEST_DB} への TCP 認証接続が失敗"
VER="$(PGPASSWORD=postgres psql -h 127.0.0.1 -p "${PG_PORT}" -U postgres -d "${PG_TEST_DB}" -tAc 'SHOW server_version_num')"
[ "${VER:0:2}" = "17" ] || fail "server_version_num=${VER} が 17 系でない"

echo "✓ PostgreSQL ${PG_MAJOR} ready on 127.0.0.1:${PG_PORT} (db=${PG_TEST_DB}, user=postgres)"
