import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cxjybmupdffeoqpwrfji.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_fpVju5NPZpYbAAkOc-9jFQ_727Bc8MR';

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@clinica-escola.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'Admin123';

const hasEnv = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const describeIf = hasEnv ? describe : describe.skip;

describeIf('Supabase — integração', () => {
  let anonClient;

  beforeAll(() => {
    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sb-anon-test' }
    });
  });

  it('cliente anon inicializa', () => {
    expect(anonClient).toBeTruthy();
    expect(typeof anonClient.from).toBe('function');
  });

  it('anon pode chamar portal_buscar_paciente (RPC)', async () => {
    const { data, error } = await anonClient.rpc('portal_buscar_paciente', { termo: 'zzzzzzzzzz' });
    // Sem resultados é OK; erro de permissão não é.
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it('anon NÃO lê a tabela usuarios (RLS)', async () => {
    const { data, error } = await anonClient.from('usuarios').select('*').limit(1);
    // Deve falhar ou retornar vazio (RLS bloqueia leitura).
    const bloqueado = !!error || !data || data.length === 0;
    expect(bloqueado).toBe(true);
  });

  it('anon NÃO pode chamar alterar_senha_usuario (apenas admin)', async () => {
    const { error } = await anonClient.rpc('alterar_senha_usuario', {
      p_email: 'x@x.com', p_nova_senha: 'Senha1234'
    });
    expect(error).toBeTruthy();
  });

  it('admin faz login com credenciais válidas', async () => {
    const { data, error } = await anonClient.auth.signInWithPassword({
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD
    });
    expect(error).toBeNull();
    expect(data && data.session && data.session.access_token).toBeTruthy();
    await anonClient.auth.signOut();
  });

  it('login com senha errada falha', async () => {
    const { data, error } = await anonClient.auth.signInWithPassword({
      email: ADMIN_EMAIL, password: 'senha-errada-123'
    });
    expect(error).toBeTruthy();
    expect(!data || !data.session).toBe(true);
  });

  it('login de usuário banido é bloqueado pelo GoTrue', async () => {
    // Usa root (deve estar desbanido ao final). Guarda estado original.
    const email = 'root@clinica-escola.local';
    const password = 'Root12345';
    // banir
    const { data: sess } = await anonClient.auth.signInWithPassword({
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD
    });
    const adminToken = sess && sess.session && sess.session.access_token;
    expect(adminToken).toBeTruthy();

    const adminClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sb-admin-test' },
      global: { headers: { Authorization: `Bearer ${adminToken}` } }
    });

    try {
      await adminClient.rpc('bloquear_usuario_auth', { p_email: email });

      const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
      expect(error).toBeTruthy();
      expect(String((error && error.message) || (error && error.code) || '')).toMatch(/banned/i);
      expect(!data || !data.session).toBe(true);
    } finally {
      // restaura estado: desbanir
      await adminClient.rpc('desbloquear_usuario_auth', { p_email: email });
      await anonClient.auth.signOut();
    }
  });
});
