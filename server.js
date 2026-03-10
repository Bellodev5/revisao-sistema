// ============================================================
//  REVISÃO DE VIDAS — API Backend
//  Node.js + Express + PostgreSQL
//
//  Instalar dependências:
//    npm install express cors pg dotenv
//
//  Rodar:
//    node server.js
//    (ou: npx nodemon server.js para desenvolvimento)
// ============================================================

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── BANCO ───────────────────────────────────────────────────
const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    user:     process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'bellopg',
    database: process.env.DB_NAME || 'revisao_vidas',
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Teste de conexão lazy (não bloqueia o start em serverless)
const q = (sql, params) => pool.query(sql, params);

// ─── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log de todas as requisições
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`);
    next();
});

// Serve os arquivos HTML estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Rota de teste rápido
app.get('/api/ping', (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// ─── HELPER ───────────────────────────────────────────────────
const ok  = (res, data) => res.json({ success: true,  data });
const err = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });

// ─── AUTH ─────────────────────────────────────────────────────
// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return err(res, 'Usuário e senha obrigatórios');
        const { rows } = await q(
            'SELECT id, username, name, role FROM usuarios WHERE username=$1 AND password=$2 AND ativo=TRUE',
            [username, password]
        );
        if (!rows.length) return err(res, 'Credenciais inválidas', 401);
        ok(res, rows[0]);
    } catch(e) { err(res, e.message, 500); }
});

// ─── REVISIONISTAS ────────────────────────────────────────────

// POST /api/inscricao  ← chamado pelo site de inscrição público
app.post('/api/inscricao', async (req, res) => {
    try {
        const {
            nome_completo, cpf, data_nascimento, endereco, sexo,
            telefone, lider_ou_convite, condicao_saude, restricao_alimentar,
            informacao_filho, contatos_emergencia, expectativa,
            entrou_grupo_whatsapp, revisao,
            equipe_id, celula_id,
            pagamento   // pode vir quando adicionado manualmente pelo painel
        } = req.body;

        if (!nome_completo) return err(res, 'Nome é obrigatório');

        // Detecta revisão automaticamente se não enviada
        const rv = revisao || (() => {
            const m = new Date().getMonth() + 1;
            return m <= 3 ? 'RV1' : m <= 6 ? 'RV2' : m <= 9 ? 'RV3' : 'RV4';
        })();

        // equipe_id e celula_id: converte para inteiro ou null
        const eqId  = equipe_id  && !isNaN(equipe_id)  ? parseInt(equipe_id)  : null;
        const celId = celula_id  && !isNaN(celula_id)  ? parseInt(celula_id)  : null;

        // Busca o ano ativo do banco
        const { rows: cfgRows } = await q("SELECT valor FROM config WHERE chave='ano_ativo'");
        const anoAtivo = cfgRows[0]?.valor ? parseInt(cfgRows[0].valor) : new Date().getFullYear();

        // Busca snapshot de nome/cor da equipe e célula para preservar histórico
        let eqSnap = null, celSnap = null;
        if (eqId) {
            const { rows: eqRows } = await q('SELECT name, color FROM equipes WHERE id=$1', [eqId]);
            if (eqRows.length) eqSnap = eqRows[0];
        }
        if (celId) {
            const { rows: celRows } = await q('SELECT nome, lider FROM celulas WHERE id=$1', [celId]);
            if (celRows.length) celSnap = celRows[0];
        }

        const { rows } = await q(`
            INSERT INTO revisionistas
              (nome_completo, cpf, data_nascimento, endereco, sexo, telefone,
               lider_ou_convite, condicao_saude, restricao_alimentar,
               informacao_filho, contatos_emergencia, expectativa,
               entrou_grupo_whatsapp, revisao, equipe_id, celula_id, ano_referencia,
               equipe_nome_snap, equipe_cor_snap, celula_nome_snap, celula_lider_snap,
               pagamento)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
            RETURNING id, nome_completo, revisao, equipe_id, celula_id, ano_referencia, pagamento, data_inscricao
        `, [
            nome_completo, cpf||null, data_nascimento||null, endereco||null, sexo||null,
            telefone||null, lider_ou_convite||null, condicao_saude||null,
            restricao_alimentar||null, informacao_filho||null,
            contatos_emergencia||null, expectativa||null,
            entrou_grupo_whatsapp||null, rv, eqId, celId, anoAtivo,
            eqSnap?.name||null, eqSnap?.color||null,
            celSnap?.nome||null, celSnap?.lider||null,
            ['confirmado','pendente'].includes(pagamento) ? pagamento : 'pendente'
        ]);

        ok(res, rows[0]);
    } catch(e) { err(res, e.message, 500); }
});

// GET /api/revisionistas
app.get('/api/revisionistas', async (req, res) => {
    try {
        const { revisao, pagamento, equipe_id, ativo, search } = req.query;
        let sql = `
            SELECT r.*,
                   COALESCE(e.name,  r.equipe_nome_snap)  AS equipe_nome,
                   COALESCE(e.color, r.equipe_cor_snap)   AS equipe_cor,
                   COALESCE(c.nome,  r.celula_nome_snap)  AS celula_nome,
                   COALESCE(c.lider, r.celula_lider_snap) AS celula_lider
            FROM revisionistas r
            LEFT JOIN equipes e ON e.id = r.equipe_id
            LEFT JOIN celulas c ON c.id = r.celula_id
            WHERE 1=1
        `;
        const params = [];
        let pi = 1;

        if (revisao  && revisao  !== 'all') { sql += ` AND r.revisao=$${pi++}`;    params.push(revisao); }
        if (pagamento && pagamento !== 'all') { sql += ` AND r.pagamento=$${pi++}`; params.push(pagamento); }
        if (equipe_id && equipe_id !== 'all') { sql += ` AND r.equipe_id=$${pi++}`; params.push(equipe_id); }
        if (ativo === 'true')  { sql += ` AND r.ativo=TRUE`; }
        if (ativo === 'false') { sql += ` AND r.ativo=FALSE`; }
        if (search) {
            sql += ` AND (r.nome_completo ILIKE $${pi} OR r.cpf ILIKE $${pi} OR r.telefone ILIKE $${pi})`;
            params.push(`%${search}%`); pi++;
        }
        sql += ` ORDER BY r.data_inscricao DESC`;

        const { rows } = await q(sql, params);
        ok(res, rows);
    } catch(e) { err(res, e.message, 500); }
});

// POST /api/revisionistas/finalizar  ── arquiva ativos e avança RV
app.post('/api/revisionistas/finalizar', async (req, res) => {
    try {
        const { revisao } = req.body;

        // 1. Arquiva revisionistas ativos da revisão informada
        let sql = 'UPDATE revisionistas SET ativo=FALSE WHERE ativo=TRUE';
        const params = [];
        if (revisao && revisao !== 'all') { sql += ' AND revisao=$1'; params.push(revisao); }
        const { rowCount } = await q(sql, params);

        // 2. Avança a RV ativa automaticamente
        let novaRV = 'RV1';
        if (revisao && revisao !== 'all') {
            const map = { 'RV1':'RV2', 'RV2':'RV3', 'RV3':'RV4', 'RV4':'RV1' };
            novaRV = map[revisao] || 'RV1';
        } else {
            // Se finalizou "todas", pega a atual e avança
            const { rows } = await q("SELECT valor FROM config WHERE chave='rv_ativa'");
            const atual = rows[0]?.valor || 'RV1';
            const map = { 'RV1':'RV2', 'RV2':'RV3', 'RV3':'RV4', 'RV4':'RV1' };
            novaRV = map[atual];
        }
        await q("INSERT INTO config (chave, valor) VALUES ('rv_ativa',$1) ON CONFLICT (chave) DO UPDATE SET valor=$1, updated_at=NOW()", [novaRV]);

        ok(res, { arquivados: rowCount, nova_rv: novaRV });
    } catch(e) { err(res, e.message, 500); }
});

// GET /api/revisionistas/:id
app.get('/api/revisionistas/:id', async (req, res) => {
    try {
        const { rows } = await q(`
            SELECT r.*,
                   COALESCE(e.name,  r.equipe_nome_snap)  AS equipe_nome,
                   COALESCE(e.color, r.equipe_cor_snap)   AS equipe_cor,
                   COALESCE(c.nome,  r.celula_nome_snap)  AS celula_nome,
                   COALESCE(c.lider, r.celula_lider_snap) AS celula_lider
            FROM revisionistas r
            LEFT JOIN equipes e ON e.id = r.equipe_id
            LEFT JOIN celulas c ON c.id = r.celula_id
            WHERE r.id = $1`, [req.params.id]);
        if (!rows.length) return err(res, 'Não encontrado', 404);
        ok(res, rows[0]);
    } catch(e) { err(res, e.message, 500); }
});

// PUT /api/revisionistas/:id
app.put('/api/revisionistas/:id', async (req, res) => {
    try {
        const {
            nome_completo, cpf, data_nascimento, endereco, sexo, telefone,
            lider_ou_convite, condicao_saude, restricao_alimentar,
            informacao_filho, contatos_emergencia, expectativa,
            entrou_grupo_whatsapp, revisao, pagamento, ativo, equipe_id, celula_id
        } = req.body;

        const { rows } = await q(`
            UPDATE revisionistas SET
                nome_completo=$1, cpf=$2, data_nascimento=$3, endereco=$4,
                sexo=$5, telefone=$6, lider_ou_convite=$7, condicao_saude=$8,
                restricao_alimentar=$9, informacao_filho=$10, contatos_emergencia=$11,
                expectativa=$12, entrou_grupo_whatsapp=$13, revisao=$14,
                pagamento=$15, ativo=$16, equipe_id=$17, celula_id=$18
            WHERE id=$19 RETURNING *
        `, [
            nome_completo, cpf||null, data_nascimento||null, endereco||null,
            sexo||null, telefone||null, lider_ou_convite||null, condicao_saude||null,
            restricao_alimentar||null, informacao_filho||null, contatos_emergencia||null,
            expectativa||null, entrou_grupo_whatsapp||null, revisao,
            pagamento||'pendente', ativo !== false,
            equipe_id||null, celula_id||null,
            req.params.id
        ]);
        if (!rows.length) return err(res, 'Não encontrado', 404);
        ok(res, rows[0]);
    } catch(e) { err(res, e.message, 500); }
});

// PATCH /api/revisionistas/:id/pagamento
app.patch('/api/revisionistas/:id/pagamento', async (req, res) => {
    try {
        const { pagamento } = req.body;
        const { rows } = await q(
            'UPDATE revisionistas SET pagamento=$1 WHERE id=$2 RETURNING id, nome_completo, pagamento',
            [pagamento, req.params.id]
        );
        if (!rows.length) return err(res, 'Não encontrado', 404);
        ok(res, rows[0]);
    } catch(e) { err(res, e.message, 500); }
});

// DELETE /api/revisionistas/:id
app.delete('/api/revisionistas/:id', async (req, res) => {
    try {
        const { rows } = await q('DELETE FROM revisionistas WHERE id=$1 RETURNING id', [req.params.id]);
        if (!rows.length) return err(res, 'Não encontrado', 404);
        ok(res, { deleted: rows[0].id });
    } catch(e) { err(res, e.message, 500); }
});

// ─── EQUIPES ──────────────────────────────────────────────────

// GET /api/equipes  (inclui células e contagem)
app.get('/api/equipes', async (req, res) => {
    try {
        const { rows: eqs } = await q('SELECT * FROM equipes ORDER BY name');
        const { rows: cels } = await q('SELECT * FROM celulas ORDER BY nome');
        const { rows: counts } = await q(`
            SELECT equipe_id, celula_id,
                   COUNT(*) FILTER (WHERE ativo=TRUE) AS total
            FROM revisionistas GROUP BY equipe_id, celula_id
        `);

        const result = eqs.map(e => ({
            ...e,
            celulas: cels
                .filter(c => c.equipe_id === e.id)
                .map(c => ({
                    ...c,
                    count: counts
                        .filter(x => x.celula_id === c.id)
                        .reduce((a, x) => a + parseInt(x.total), 0)
                })),
            total: counts
                .filter(x => x.equipe_id === e.id)
                .reduce((a, x) => a + parseInt(x.total), 0)
        }));
        ok(res, result);
    } catch(e) { err(res, e.message, 500); }
});

// POST /api/equipes
app.post('/api/equipes', async (req, res) => {
    try {
        const { name, leader, color, celulas = [] } = req.body;
        if (!name || !leader) return err(res, 'Nome e líder obrigatórios');

        const { rows: [eq] } = await q(
            'INSERT INTO equipes (name, leader, color) VALUES ($1,$2,$3) RETURNING *',
            [name, leader, color || '#2563eb']
        );

        // Inserir células
        for (const c of celulas) {
            if (c.nome) await q(
                'INSERT INTO celulas (equipe_id, nome, lider) VALUES ($1,$2,$3)',
                [eq.id, c.nome, c.lider || '']
            );
        }

        ok(res, eq);
    } catch(e) { err(res, e.message, 500); }
});

// PUT /api/equipes/:id
app.put('/api/equipes/:id', async (req, res) => {
    try {
        const { name, leader, color, celulas = [] } = req.body;
        const eqId = req.params.id;

        const { rows: [eq] } = await q(
            'UPDATE equipes SET name=$1, leader=$2, color=$3 WHERE id=$4 RETURNING *',
            [name, leader, color, eqId]
        );
        if (!eq) return err(res, 'Não encontrado', 404);

        // Busca células existentes
        const { rows: existentes } = await q(
            'SELECT id, nome FROM celulas WHERE equipe_id=$1', [eqId]
        );

        // IDs que vieram do frontend (células que devem continuar existindo)
        const idsParaManter = celulas.filter(c => c.id).map(c => parseInt(c.id));

        // Deleta apenas células que foram removidas pelo usuário (não estão na lista)
        // E que não possuem revisionistas vinculados
        for (const ex of existentes) {
            if (!idsParaManter.includes(ex.id)) {
                // Verifica se tem inscritos vinculados
                const { rows: vinculados } = await q(
                    'SELECT COUNT(*) AS n FROM revisionistas WHERE celula_id=$1', [ex.id]
                );
                if (parseInt(vinculados[0].n) === 0) {
                    // Sem inscritos: pode deletar
                    await q('DELETE FROM celulas WHERE id=$1', [ex.id]);
                } else {
                    // Com inscritos: apenas desvincula da equipe deixando nome intacto
                    // (o snapshot já preserva o histórico, mantemos a célula)
                }
            }
        }

        // Atualiza células existentes (nome/lider pode ter mudado)
        for (const c of celulas) {
            if (c.id) {
                // Célula existente — atualiza nome e lider
                await q(
                    'UPDATE celulas SET nome=$1, lider=$2 WHERE id=$3 AND equipe_id=$4',
                    [c.nome, c.lider || '', c.id, eqId]
                );
            } else if (c.nome) {
                // Célula nova — insere
                await q(
                    'INSERT INTO celulas (equipe_id, nome, lider) VALUES ($1,$2,$3)',
                    [eqId, c.nome, c.lider || '']
                );
            }
        }

        ok(res, eq);
    } catch(e) { err(res, e.message, 500); }
});

// DELETE /api/equipes/:id
app.delete('/api/equipes/:id', async (req, res) => {
    try {
        const { rows } = await q('DELETE FROM equipes WHERE id=$1 RETURNING id', [req.params.id]);
        if (!rows.length) return err(res, 'Não encontrado', 404);
        ok(res, { deleted: rows[0].id });
    } catch(e) { err(res, e.message, 500); }
});

// ─── USUÁRIOS ─────────────────────────────────────────────────

// GET /api/usuarios
app.get('/api/usuarios', async (req, res) => {
    try {
        const { rows } = await q('SELECT id, username, name, role, ativo, created_at FROM usuarios ORDER BY id');
        ok(res, rows);
    } catch(e) { err(res, e.message, 500); }
});

// POST /api/usuarios
app.post('/api/usuarios', async (req, res) => {
    try {
        const { username, name, password, role } = req.body;
        if (!username || !name || !password) return err(res, 'Campos obrigatórios faltando');
        const { rows } = await q(
            'INSERT INTO usuarios (username, name, password, role) VALUES ($1,$2,$3,$4) RETURNING id, username, name, role',
            [username, name, password, role || 'viewer']
        );
        ok(res, rows[0]);
    } catch(e) {
        if (e.code === '23505') return err(res, 'Usuário já existe');
        err(res, e.message, 500);
    }
});

// DELETE /api/usuarios/:id
app.delete('/api/usuarios/:id', async (req, res) => {
    try {
        if (req.params.id === '1') return err(res, 'Não é possível excluir o admin principal');
        const { rows } = await q('DELETE FROM usuarios WHERE id=$1 RETURNING id', [req.params.id]);
        if (!rows.length) return err(res, 'Não encontrado', 404);
        ok(res, { deleted: rows[0].id });
    } catch(e) { err(res, e.message, 500); }
});

// ─── RANKING ──────────────────────────────────────────────────

// GET /api/ranking?revisao=RV1
app.get('/api/ranking', async (req, res) => {
    try {
        const { revisao } = req.query;
        const rvFilter = revisao && revisao !== 'all' ? `AND r.revisao='${revisao}'` : '';

        const { rows: teams } = await q(`
            SELECT e.id, e.name, e.color, e.leader,
                   COUNT(r.id) AS total
            FROM equipes e
            LEFT JOIN revisionistas r ON r.equipe_id=e.id AND r.ativo=TRUE ${rvFilter}
            GROUP BY e.id ORDER BY total DESC
        `);

        const { rows: cells } = await q(`
            SELECT c.id, c.nome, c.lider, e.name AS equipe_name, e.color AS equipe_color,
                   COUNT(r.id) AS total
            FROM celulas c
            JOIN equipes e ON e.id=c.equipe_id
            LEFT JOIN revisionistas r ON r.celula_id=c.id AND r.ativo=TRUE ${rvFilter}
            GROUP BY c.id, c.nome, c.lider, e.name, e.color ORDER BY total DESC
        `);

        ok(res, { teams, cells });
    } catch(e) { err(res, e.message, 500); }
});


// ─── CONFIG (RV ATIVA) ────────────────────────────────────────

// GET /api/config  — retorna configuração atual
app.get('/api/config', async (req, res) => {
    try {
        // Garante que rv_ativa e ano_ativo existem
        await q("INSERT INTO config (chave, valor) VALUES ('rv_ativa','RV1'),('ano_ativo','2026') ON CONFLICT (chave) DO NOTHING");
        const { rows } = await q("SELECT chave, valor FROM config");
        const cfg = {};
        rows.forEach(r => cfg[r.chave] = r.valor);
        ok(res, cfg);
    } catch(e) { err(res, e.message, 500); }
});

// PUT /api/config  — atualiza rv_ativa manualmente
app.put('/api/config', async (req, res) => {
    try {
        const { rv_ativa, ano_ativo } = req.body;
        if (rv_ativa) {
            const valid = ['RV1','RV2','RV3','RV4'];
            if (!valid.includes(rv_ativa)) return err(res, 'Revisão inválida');
            await q("INSERT INTO config (chave, valor) VALUES ('rv_ativa',$1) ON CONFLICT (chave) DO UPDATE SET valor=$1, updated_at=NOW()", [rv_ativa]);
        }
        if (ano_ativo) {
            await q("INSERT INTO config (chave, valor) VALUES ('ano_ativo',$1) ON CONFLICT (chave) DO UPDATE SET valor=$1, updated_at=NOW()", [String(ano_ativo)]);
        }
        const { rows } = await q("SELECT chave, valor FROM config");
        const cfg = {};
        rows.forEach(r => cfg[r.chave] = r.valor);
        ok(res, cfg);
    } catch(e) { err(res, e.message, 500); }
});


// POST /api/ano/finalizar  ── finaliza o ano inteiro, avança o ano
app.post('/api/ano/finalizar', async (req, res) => {
    try {
        const { rows: cfgRows } = await q("SELECT chave, valor FROM config");
        const cfg = {};
        cfgRows.forEach(r => cfg[r.chave] = r.valor);
        const anoAtual = parseInt(cfg.ano_ativo || new Date().getFullYear());
        const novoAno  = anoAtual + 1;

        // 1. Arquiva todos os revisionistas ativos do ano atual
        const { rowCount } = await q(
            'UPDATE revisionistas SET ativo=FALSE WHERE ativo=TRUE AND ano_referencia=$1',
            [anoAtual]
        );

        // 2. Avança o ano e reseta a RV ativa para RV1
        await q("UPDATE config SET valor=$1, updated_at=NOW() WHERE chave='ano_ativo'", [String(novoAno)]);
        await q("UPDATE config SET valor='RV1', updated_at=NOW() WHERE chave='rv_ativa'");

        ok(res, { arquivados: rowCount, ano_finalizado: anoAtual, novo_ano: novoAno });
    } catch(e) { err(res, e.message, 500); }
});

// GET /api/relatorio/:ano  ── todos os dados de um ano específico
app.get('/api/relatorio/:ano', async (req, res) => {
    try {
        const ano = parseInt(req.params.ano);
        const { rows } = await q(`
            SELECT r.*,
                   COALESCE(e.name,  r.equipe_nome_snap)  AS equipe_nome,
                   COALESCE(e.color, r.equipe_cor_snap)   AS equipe_cor,
                   COALESCE(c.nome,  r.celula_nome_snap)  AS celula_nome,
                   COALESCE(c.lider, r.celula_lider_snap) AS celula_lider
            FROM revisionistas r
            LEFT JOIN equipes e ON e.id = r.equipe_id
            LEFT JOIN celulas c ON c.id = r.celula_id
            WHERE r.ano_referencia = $1
              AND r.pagamento = 'confirmado'
            ORDER BY r.revisao, r.data_inscricao
        `, [ano]);
        ok(res, rows);
    } catch(e) { err(res, e.message, 500); }
});

// GET /api/relatorio/:ano/stats  ── resumo estatístico de um ano
app.get('/api/relatorio/:ano/stats', async (req, res) => {
    try {
        const ano = parseInt(req.params.ano);
        const { rows } = await q(`
            SELECT
                revisao,
                COUNT(*) AS total,
                COUNT(*) AS pagos,
                COUNT(*) FILTER (WHERE sexo='Masculino') AS masc,
                COUNT(*) FILTER (WHERE sexo='Feminino') AS fem
            FROM revisionistas
            WHERE ano_referencia = $1
              AND pagamento = 'confirmado'
            GROUP BY revisao ORDER BY revisao
        `, [ano]);

        // Ranking de equipes do ano — usa snapshot para preservar equipes deletadas
        const { rows: equipes } = await q(`
            SELECT
                COALESCE(e.name,  r.equipe_nome_snap, '(sem equipe)') AS name,
                COALESCE(e.color, r.equipe_cor_snap,  '#334155')       AS color,
                COUNT(r.id) AS total
            FROM revisionistas r
            LEFT JOIN equipes e ON e.id = r.equipe_id
            WHERE r.ano_referencia = $1
              AND r.pagamento = 'confirmado'
            GROUP BY COALESCE(e.name, r.equipe_nome_snap, '(sem equipe)'),
                     COALESCE(e.color, r.equipe_cor_snap, '#334155')
            ORDER BY total DESC
        `, [ano]);

        // Células por equipe do ano (com snapshot)
        const { rows: celulas } = await q(`
            SELECT
                COALESCE(e.name,  r.equipe_nome_snap, '(sem equipe)') AS equipe_name,
                COALESCE(e.color, r.equipe_cor_snap,  '#334155')       AS equipe_color,
                COALESCE(c.nome,  r.celula_nome_snap, '(célula geral)') AS celula_name,
                COALESCE(c.lider, r.celula_lider_snap, '—')             AS celula_lider,
                COUNT(r.id) AS total
            FROM revisionistas r
            LEFT JOIN equipes e ON e.id = r.equipe_id
            LEFT JOIN celulas c ON c.id = r.celula_id
            WHERE r.ano_referencia = $1
              AND r.pagamento = 'confirmado'
            GROUP BY COALESCE(e.name, r.equipe_nome_snap, '(sem equipe)'),
                     COALESCE(e.color, r.equipe_cor_snap, '#334155'),
                     COALESCE(c.nome,  r.celula_nome_snap, '(célula geral)'),
                     COALESCE(c.lider, r.celula_lider_snap, '—')
            ORDER BY equipe_name, total DESC
        `, [ano]);

        ok(res, { por_revisao: rows, equipes, celulas });
    } catch(e) { err(res, e.message, 500); }
});

// ─── STATS ────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
    try {
        const { revisao } = req.query;
        const rvF = revisao && revisao !== 'all' ? `AND revisao='${revisao}'` : '';
        const { rows: [s] } = await q(`
            SELECT
                COUNT(*) FILTER (WHERE ativo=TRUE ${rvF})                                   AS ativos,
                COUNT(*) FILTER (WHERE ativo=TRUE AND pagamento='confirmado' ${rvF})        AS pagos,
                COUNT(*) FILTER (WHERE ativo=TRUE AND pagamento='pendente' ${rvF})          AS pendentes,
                COUNT(*) FILTER (WHERE ativo=FALSE ${rvF})                                  AS arquivados
            FROM revisionistas
        `);
        const { rows: [eq] } = await q('SELECT COUNT(*) AS total FROM equipes');
        ok(res, { ...s, equipes: eq.total });
    } catch(e) { err(res, e.message, 500); }
});

// ─── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`   Site inscrição: http://localhost:${PORT}/inscricao.html`);
    console.log(`   Painel admin:   http://localhost:${PORT}/painel-admin.html`);
    console.log(`   API:            http://localhost:${PORT}/api/\n`);
});
