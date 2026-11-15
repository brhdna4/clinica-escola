-- ============================================================================
-- Clínica-Escola de Psicologia — ENDURECIMENTO de RLS (OPCIONAL / NÃO APLICADO)
-- Arquivo: supabase/migrations/20261027_rls_hardening_OPCIONAL.sql
--
-- Este arquivo NÃO foi executado no banco. Ele só funciona depois de UMA mudança
-- de código no painel (abaixo). Leia tudo antes de aplicar.
--
-- MOTIVO: com o login demonstrativo "Admin / Admin" (validado no navegador), o
-- painel escreve no banco com a chave anon. Para o painel continuar funcionando,
-- as políticas atuais liberam escrita para anon. Isso significa que qualquer
-- pessoa com a chave pública (que está no HTML) poderia ler/gravar os dados.
--
-- PASSO 1 — autenticação real no painel:
--   a) criar um usuário em Supabase > Authentication > Users
--      (ex.: admin@clinica.local, senha forte) e convidar a equipe;
--   b) em panel.html, trocar a validação local do demo em doLogin() por:
--        const { data, error } = await ClinicaDB.entrar(email, senha);
--      e adicionar em js/clinica-db.js:
--        entrar: (email, senha) => cliente.auth.signInWithPassword({ email, password: senha }),
--        sair:   () => cliente.auth.signOut(),
--        sessao: () => cliente.auth.getSession()
--      (a tela de login continua exatamente igual — muda só a validação).
--
-- PASSO 2 — ajustar a busca do portal (index.html), para não expor a lista
--   completa de pacientes ao anônimo:
--      hoje:  state.pacientes.filter(...)
--      depois: const { data } = await cliente.rpc('portal_buscar_paciente', { termo: busca.value });
--              (retorna apenas id, nome, status e terapeutaId — o suficiente para
--               o paciente escolher seu cadastro e ver os horários livres)
--
-- PASSO 3 — executar este arquivo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- RPC de busca pública (devolve o mínimo necessário, nunca CPF/telefone/endereço)
-- ---------------------------------------------------------------------------
create or replace function public.portal_buscar_paciente(termo text)
returns table ("id" text, "nome" text, "status" text, "terapeutaId" text)
language sql
security definer
set search_path = public
as $$
  select p."id", p."nome", p."status", p."terapeutaId"
  from public."pacientes" p
  where termo is not null
    and length(trim(termo)) >= 2
    and (
      p."nome" ilike '%' || trim(termo) || '%'
      or p."prontuario" ilike '%' || trim(termo) || '%'
    )
  limit 6;
$$;

revoke all on function public.portal_buscar_paciente(text) from public;
grant execute on function public.portal_buscar_paciente(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Recria as políticas com escopo: anon = apenas portal; authenticated = equipe
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  lista text[] := array[
    'terapeutas','salas','pacientes','solicitacoes','agendamentos','usoSalas','usuarios'
  ]::text[];
begin
  foreach t in array lista loop
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_select', t);
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_update', t);
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_delete', t);
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_equipe', t);
    execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_portal_select', t);

    -- equipe autenticada: acesso completo
    execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', 'pol_' || t || '_equipe', t);
  end loop;
end $$;

-- Portal público (anon) — somente o necessário para calcular horários e solicitar
do $$
declare t text;
begin
  foreach t in array array['terapeutas','salas','agendamentos','solicitacoes','usoSalas']::text[] loop
    execute format('create policy %I on public.%I for select to anon using (true)', 'pol_' || t || '_portal_select', t);
  end loop;
end $$;

drop policy if exists "pol_pacientes_portal_insert" on public."pacientes";
drop policy if exists "pol_solicitacoes_portal_insert" on public."solicitacoes";
create policy "pol_pacientes_portal_insert" on public."pacientes"    for insert to anon with check (true);
create policy "pol_solicitacoes_portal_insert" on public."solicitacoes" for insert to anon with check (true);

-- anon NÃO enxerga a tabela "usuarios" (usuários/permissões do painel)
grant select on public."usuarios" to authenticated;

notify pgrst, 'reload schema';
