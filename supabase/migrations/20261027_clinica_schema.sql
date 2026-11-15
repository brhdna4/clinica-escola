-- ============================================================================
-- Clínica-Escola de Psicologia — Schema base (Supabase / PostgreSQL)
-- Arquivo: supabase/migrations/20261027_clinica_schema.sql
--
-- Substitui o antigo banco em localStorage (chave "clinicaPsicoDB_v2").
-- Uma tabela por coleção usada pelo app, com os MESMOS nomes de campo do
-- JavaScript (identificadores entre aspas, portanto sensíveis a maiúsculas).
-- Isso mantém o contrato 1:1 com index.html / panel.html e evita perda de dados.
--
-- Colunas técnicas:
--   "extra"        jsonb  -> guarda qualquer campo novo que o app venha a criar,
--                            sem precisar de migração de schema (nada é descartado).
--   "criadoEm"     timestamptz
--   "atualizadoEm" timestamptz
--
-- RLS: habilitado em todas as tabelas. As políticas estão no fim deste arquivo.
-- ============================================================================

-- ---------------------------------------------------------------- terapeutas
-- Alunos e professores (terapeutas) + grade de disponibilidade por dia da semana.
create table if not exists public."terapeutas" (
  "id"              text primary key,
  "nome"            text,
  "disponibilidade" jsonb,
  "ativo"           boolean default true,
  "tipo"            text,          -- 'aluno' | 'professor'
  "semestre"        text,
  "professor"       text,
  "turma"           text,
  "codigo"          text,
  "periodo"         text,
  "professorId"     text,
  "extra"           jsonb not null default '{}'::jsonb,
  "criadoEm"        timestamptz not null default now(),
  "atualizadoEm"    timestamptz not null default now()
);

-- --------------------------------------------------------------------- salas
-- Consultórios (nome, ativo/inativo).
create table if not exists public."salas" (
  "id"           text primary key,
  "nome"         text,
  "ativa"        boolean default true,
  "extra"        jsonb not null default '{}'::jsonb,
  "criadoEm"     timestamptz not null default now(),
  "atualizadoEm" timestamptz not null default now()
);

-- ----------------------------------------------------------------- pacientes
create table if not exists public."pacientes" (
  "id"             text primary key,
  "nome"           text,
  "idade"          integer,
  "dataNascimento" text,
  "cpf"            text,
  "nomeSocial"     text,
  "sexo"           text,
  "nomeMae"        text,
  "email"          text,
  "endereco"       jsonb,
  "prontuario"     text,
  "telefone"       text,
  "terapeutaId"    text,
  "diaFix"         text,
  "horaFix"        text,
  "status"         text,          -- triagem | agendado | desistiu | vinculado
  "responsavel"    jsonb,
  "extra"          jsonb not null default '{}'::jsonb,
  "criadoEm"       timestamptz not null default now(),
  "atualizadoEm"   timestamptz not null default now()
);

-- -------------------------------------------------------------- solicitacoes
-- Pedidos de horário vindos do portal do paciente (index.html).
create table if not exists public."solicitacoes" (
  "id"           text primary key,
  "pacienteId"   text,
  "terapeutaId"  text,
  "data"         text,           -- YYYY-MM-DD
  "hora"         text,           -- HH:mm
  "status"       text,           -- pendente | sugerida | aprovada | recusada
  "mensagem"     text,
  "salaId"       text,
  "extra"        jsonb not null default '{}'::jsonb,
  "criadoEm"     timestamptz not null default now(),
  "atualizadoEm" timestamptz not null default now()
);

-- --------------------------------------------------------------- agendamentos
create table if not exists public."agendamentos" (
  "id"           text primary key,
  "pacienteId"   text,
  "terapeutaId"  text,
  "data"         text,           -- YYYY-MM-DD
  "hora"         text,           -- HH:mm
  "salaId"       text,
  "status"       text,           -- agendado | compareceu | falta_justificada | desistiu
  "extra"        jsonb not null default '{}'::jsonb,
  "criadoEm"     timestamptz not null default now(),
  "atualizadoEm" timestamptz not null default now()
);

-- ------------------------------------------------------------------ usoSalas
-- Uso de consultório (Recepção / Aluno) — base da taxa de utilização.
create table if not exists public."usoSalas" (
  "id"           text primary key,
  "alunoId"      text,
  "salaId"       text,
  "data"         text,           -- YYYY-MM-DD
  "horaInicio"   text,           -- HH:mm
  "duracaoMin"   integer,
  "pacienteId"   text,
  "nota"         text,
  "extra"        jsonb not null default '{}'::jsonb,
  "criadoEm"     timestamptz not null default now(),
  "atualizadoEm" timestamptz not null default now()
);

-- ------------------------------------------------------------------ usuarios
-- Usuários do painel (admin / recepcao / aluno / professor).
create table if not exists public."usuarios" (
  "id"           text primary key,
  "nome"         text,
  "tipo"         text,
  "terapeutaId"  text,
  "codigo"       text,
  "ativo"        boolean default true,
  "extra"        jsonb not null default '{}'::jsonb,
  "criadoEm"     timestamptz not null default now(),
  "atualizadoEm" timestamptz not null default now()
);

-- ------------------------------------------------------------------- índices
create index if not exists "idx_pacientes_nome"      on public."pacientes" (lower("nome"));
create index if not exists "idx_pacientes_cpf"       on public."pacientes" ("cpf");
create index if not exists "idx_pacientes_telefone"  on public."pacientes" ("telefone");
create index if not exists "idx_solicitacoes_data"   on public."solicitacoes" ("data");
create index if not exists "idx_agendamentos_data"   on public."agendamentos" ("data");
create index if not exists "idx_agendamentos_pac"    on public."agendamentos" ("pacienteId");
create index if not exists "idx_agendamentos_sala"   on public."agendamentos" ("salaId");
create index if not exists "idx_usosalas_data"       on public."usoSalas" ("data");
create index if not exists "idx_usosalas_aluno"      on public."usoSalas" ("alunoId");
create index if not exists "idx_usosalas_sala"       on public."usoSalas" ("salaId");

-- ============================================================================
-- SEGURANÇA (RLS)
-- ----------------------------------------------------------------------------
-- O sistema tem duas frentes:
--   1) index.html — PORTAL PÚBLICO do paciente: sem login, precisa CADASTRAR
--      pacientes, CRIAR solicitações e LER agendamentos/disponibilidade para
--      calcular horários livres.
--   2) panel.html — PAINEL da equipe: hoje o login é a demonstração
--      "Admin / Admin", validada no próprio navegador (não é autenticação real).
--
-- Por isso as políticas abaixo liberam leitura/escrita para anon (portal) e
-- authenticated (equipe), e o RLS fica HABILITADO para que qualquer endurecimento
-- futuro seja apenas troca de política — sem mexer em código.
--
-- >>> RECOMENDADO (ver 20261027_rls_hardening_OPCIONAL.sql): migrar o painel para
-- >>> Supabase Auth e restringir escrita a "authenticated". Enquanto o login do
-- >>> painel não for real, restringir a escrita quebraria a ferramenta.
-- ============================================================================

alter table public."terapeutas"   enable row level security;
alter table public."salas"        enable row level security;
alter table public."pacientes"    enable row level security;
alter table public."solicitacoes" enable row level security;
alter table public."agendamentos" enable row level security;
alter table public."usoSalas"     enable row level security;
alter table public."usuarios"     enable row level security;

do $$
declare
  t text;
  lista text[] := array[
    'terapeutas','salas','pacientes','solicitacoes','agendamentos','usoSalas','usuarios'
  ]::text[];
begin
  foreach t in array lista loop
    -- privilégios de tabela para as duas roles do PostgREST
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);

    -- políticas (idempotentes)
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_select', t);
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_update', t);
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_delete', t);

    execute format('create policy %I on public.%I for select to anon, authenticated using (true)',  'pol_' || t || '_select', t);
    execute format('create policy %I on public.%I for insert to anon, authenticated with check (true)', 'pol_' || t || '_insert', t);
    execute format('create policy %I on public.%I for update to anon, authenticated using (true) with check (true)', 'pol_' || t || '_update', t);
    execute format('create policy %I on public.%I for delete to anon, authenticated using (true)',  'pol_' || t || '_delete', t);
  end loop;
end $$;

-- ============================================================================
-- TEMPO REAL (sincronização entre o Portal e o Painel sem recarregar)
-- ============================================================================
do $$
declare
  t text;
  lista text[] := array[
    'terapeutas','salas','pacientes','solicitacoes','agendamentos','usoSalas','usuarios'
  ]::text[];
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array lista loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- recarrega o cache de schema do PostgREST (a API passa a enxergar as tabelas)
notify pgrst, 'reload schema';

-- ============================================================================
-- FIM — nenhum dado de exemplo é inserido aqui.
-- O app importa automaticamente, na primeira execução, os dados que já existiam
-- no localStorage deste navegador (ver js/clinica-db.js: migrarCacheParaBanco).
-- ============================================================================
