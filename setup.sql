-- ============================================================
--  REVISÃO DE VIDAS — Sara Itapema
--  Setup completo do banco de dados PostgreSQL
--  Execute: psql -h localhost -p 5433 -U postgres -f setup.sql
-- ============================================================

-- Cria o banco se não existir (rode separado se necessário)
-- CREATE DATABASE revisao_vidas;
-- \c revisao_vidas

-- ─── EXTENSÕES ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── EQUIPES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS equipes (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(120) NOT NULL,
    leader      VARCHAR(120) NOT NULL,
    color       VARCHAR(20)  NOT NULL DEFAULT '#2563eb',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── CÉLULAS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS celulas (
    id          SERIAL PRIMARY KEY,
    equipe_id   INTEGER      NOT NULL REFERENCES equipes(id) ON DELETE CASCADE,
    nome        VARCHAR(120) NOT NULL,
    lider       VARCHAR(120) NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── REVISÕES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revisoes (
    id          SERIAL PRIMARY KEY,
    codigo      VARCHAR(10)  NOT NULL UNIQUE,  -- RV1, RV2, RV3, RV4
    descricao   VARCHAR(200),
    ano         INTEGER      NOT NULL DEFAULT EXTRACT(YEAR FROM NOW()),
    ativo       BOOLEAN      NOT NULL DEFAULT TRUE,
    finalizado  BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seeds de revisões
INSERT INTO revisoes (codigo, descricao, ano) VALUES
    ('RV1', 'Revisão 1 — Jan/Mar', EXTRACT(YEAR FROM NOW())),
    ('RV2', 'Revisão 2 — Abr/Jun', EXTRACT(YEAR FROM NOW())),
    ('RV3', 'Revisão 3 — Jul/Set', EXTRACT(YEAR FROM NOW())),
    ('RV4', 'Revisão 4 — Out/Dez', EXTRACT(YEAR FROM NOW()))
ON CONFLICT (codigo) DO NOTHING;

-- ─── REVISIONISTAS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revisionistas (
    id                  SERIAL PRIMARY KEY,
    nome_completo       VARCHAR(200) NOT NULL,
    cpf                 VARCHAR(14),
    data_nascimento     VARCHAR(12),
    endereco            TEXT,
    sexo                VARCHAR(20),
    telefone            VARCHAR(30),
    lider_ou_convite    VARCHAR(200),
    condicao_saude      TEXT,
    restricao_alimentar TEXT,
    informacao_filho    TEXT,
    contatos_emergencia TEXT,
    expectativa         TEXT,
    entrou_grupo_whatsapp VARCHAR(10),

    -- Relacionamentos
    equipe_id           INTEGER REFERENCES equipes(id) ON DELETE SET NULL,
    celula_id           INTEGER REFERENCES celulas(id) ON DELETE SET NULL,
    revisao             VARCHAR(10) NOT NULL DEFAULT 'RV1',

    -- Status
    pagamento           VARCHAR(20)  NOT NULL DEFAULT 'pendente',  -- pendente | confirmado
    ativo               BOOLEAN      NOT NULL DEFAULT TRUE,         -- FALSE = finalizado/arquivado

    -- Auditoria
    data_inscricao      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_rev_ativo    ON revisionistas(ativo);
CREATE INDEX IF NOT EXISTS idx_rev_revisao  ON revisionistas(revisao);
CREATE INDEX IF NOT EXISTS idx_rev_pagamento ON revisionistas(pagamento);
CREATE INDEX IF NOT EXISTS idx_rev_equipe   ON revisionistas(equipe_id);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rev_updated ON revisionistas;
CREATE TRIGGER trg_rev_updated
    BEFORE UPDATE ON revisionistas
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── USUÁRIOS DO PAINEL ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
    id          SERIAL PRIMARY KEY,
    username    VARCHAR(80)  NOT NULL UNIQUE,
    name        VARCHAR(200) NOT NULL,
    password    VARCHAR(200) NOT NULL,  -- hash bcrypt ou texto (para MVP)
    role        VARCHAR(20)  NOT NULL DEFAULT 'viewer', -- admin | lider | viewer
    ativo       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Usuário padrão: admin / admin123
INSERT INTO usuarios (username, name, password, role) VALUES
    ('admin', 'Administrador', 'admin123', 'admin')
ON CONFLICT (username) DO NOTHING;

-- ─── VIEW: ranking equipes ────────────────────────────────────
CREATE OR REPLACE VIEW v_ranking_equipes AS
SELECT
    e.id,
    e.name,
    e.color,
    e.leader,
    COUNT(r.id) FILTER (WHERE r.ativo = TRUE)               AS total,
    COUNT(r.id) FILTER (WHERE r.ativo = TRUE AND r.pagamento = 'confirmado') AS pagos,
    r.revisao
FROM equipes e
LEFT JOIN revisionistas r ON r.equipe_id = e.id
GROUP BY e.id, e.name, e.color, e.leader, r.revisao;

-- ─── VIEW: ranking células ────────────────────────────────────
CREATE OR REPLACE VIEW v_ranking_celulas AS
SELECT
    c.id,
    c.nome,
    c.lider,
    e.name  AS equipe_name,
    e.color AS equipe_color,
    COUNT(r.id) FILTER (WHERE r.ativo = TRUE) AS total,
    r.revisao
FROM celulas c
JOIN equipes e ON e.id = c.equipe_id
LEFT JOIN revisionistas r ON r.celula_id = c.id
GROUP BY c.id, c.nome, c.lider, e.name, e.color, r.revisao;

-- ─── PRONTO ───────────────────────────────────────────────────
DO $$ BEGIN
    RAISE NOTICE '✅ Banco criado com sucesso!';
    RAISE NOTICE '   Tabelas: equipes, celulas, revisoes, revisionistas, usuarios';
    RAISE NOTICE '   Login padrão: admin / admin123';
END $$;