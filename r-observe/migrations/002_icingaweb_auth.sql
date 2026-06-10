-- Migration 002: Tabelas de autenticação do IcingaWeb2
-- Criadas no observedb para suportar usuários e sessões do IcingaWeb2.

CREATE TABLE IF NOT EXISTS icingaweb_group (
  "name"          character varying(254) NOT NULL,
  "parent"        character varying(254) DEFAULT NULL,
  "ctime"         timestamp NULL DEFAULT NULL,
  "mtime"         timestamp NULL DEFAULT NULL,
  CONSTRAINT pk_icingaweb_group PRIMARY KEY ("name")
);

CREATE TABLE IF NOT EXISTS icingaweb_group_membership (
  "group_name"  character varying(254) NOT NULL,
  "username"    character varying(254) NOT NULL,
  "ctime"       timestamp NULL DEFAULT NULL,
  "mtime"       timestamp NULL DEFAULT NULL,
  CONSTRAINT pk_icingaweb_group_membership PRIMARY KEY ("group_name", "username")
);

CREATE TABLE IF NOT EXISTS icingaweb_user (
  "name"          character varying(254) NOT NULL,
  "active"        smallint NOT NULL,
  "password_hash" bytea NOT NULL,
  "ctime"         timestamp NULL DEFAULT NULL,
  "mtime"         timestamp NULL DEFAULT NULL,
  CONSTRAINT pk_icingaweb_user PRIMARY KEY ("name")
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_icingaweb_user ON icingaweb_user (lower(name::text));

CREATE TABLE IF NOT EXISTS icingaweb_user_preference (
  "username" character varying(254) NOT NULL,
  "section"  character varying(254) NOT NULL,
  "name"     character varying(254) NOT NULL,
  "value"    character varying(4096) NOT NULL,
  "ctime"    timestamp NULL DEFAULT NULL,
  "mtime"    timestamp NULL DEFAULT NULL,
  CONSTRAINT pk_icingaweb_user_preference PRIMARY KEY ("username", "section", "name")
);

CREATE TABLE IF NOT EXISTS icingaweb_rememberme (
  "id"              serial NOT NULL,
  "username"        character varying(254) NOT NULL,
  "passphrase"      character varying(256) NOT NULL,
  "random_iv"       character varying(32) NOT NULL,
  "http_user_agent" text NOT NULL,
  "expires_at"      timestamp NULL DEFAULT NULL,
  "ctime"           timestamp NULL DEFAULT NULL,
  "mtime"           timestamp NULL DEFAULT NULL,
  CONSTRAINT pk_icingaweb_rememberme PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS icingaweb_schema (
  "id"          serial NOT NULL,
  "version"     smallint NOT NULL,
  "timestamp"   int NOT NULL,
  CONSTRAINT pk_icingaweb_schema PRIMARY KEY ("id")
);
