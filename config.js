/*!
 * Configuração de ambiente do navegador (Supabase).
 * ---------------------------------------------------------------------------
 * IMPORTANTE: a chave "anon"/"publishable" é PÚBLICA por definição — ela é
 * enviada ao navegador do paciente. Quem controla o acesso aos dados são as
 * políticas de RLS criadas em supabase/migrations/20261027_clinica_schema.sql.
 * NUNCA coloque aqui a chave "service_role" (essa é secreta e não pode sair do servidor).
 *
 * Os mesmos valores existem em .env (usado pela integração Supabase / deploy).
 * Enquanto estiver em branco, o app funciona em MODO LOCAL (cache do navegador).
 */
window.CLINICA_ENV = {
  SUPABASE_URL: 'https://cxjybmupdffeoqpwrfji.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_fpVju5NPZpYbAAkOc-9jFQ_727Bc8MR'
};
