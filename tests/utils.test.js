import { describe, it, expect } from 'vitest';

describe('utils — normalizaNome', () => {
  it('remove acentos e coloca em minúsculo', () => {
    expect(normalizaNome('João')).toBe('joao');
    expect(normalizaNome('MARIA')).toBe('maria');
  });
  it('normaliza espaços', () => {
    expect(normalizaNome('  Ana   Clara  ')).toBe('ana clara');
  });
  it('trata null/undefined', () => {
    expect(normalizaNome(null)).toBe('');
    expect(normalizaNome(undefined)).toBe('');
  });
});

describe('utils — onlyDigits', () => {
  it('remove não-dígitos', () => {
    expect(onlyDigits('(11) 98765-4321')).toBe('11987654321');
    expect(onlyDigits('abc')).toBe('');
  });
});

describe('utils — esc', () => {
  it('escapa HTML', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc('a&b')).toBe('a&amp;b');
    expect(esc('"x"')).toBe('&quot;x&quot;');
  });
  it('trata null', () => {
    expect(esc(null)).toBe('');
  });
});

describe('utils — validaCpf', () => {
  it('aceita CPF válido', () => {
    expect(validaCpf('529.982.247-25')).toBe(true);
  });
  it('rejeita CPF inválido', () => {
    expect(validaCpf('111.111.111-11')).toBe(false);
    expect(validaCpf('123')).toBe(false);
  });
});

describe('utils — validaHora', () => {
  it('valida formato HH:MM', () => {
    expect(validaHora('08:00')).toBe(true);
    expect(validaHora('23:59')).toBe(true);
    expect(validaHora('24:00')).toBe(false);
    expect(validaHora('8:00')).toBe(false);
  });
});

describe('utils — validaEmail', () => {
  it('aceita e-mails válidos ou vazio', () => {
    expect(validaEmail('a@b.com')).toBe(true);
    expect(validaEmail('')).toBe(true);
    expect(validaEmail(null)).toBe(true);
  });
  it('rejeita e-mails inválidos', () => {
    expect(validaEmail('sem-arroba')).toBe(false);
  });
});

describe('utils — sanitizeImportedState', () => {
  it('rejeita entrada inválida', () => {
    expect(sanitizeImportedState(null)).toBeNull();
    expect(sanitizeImportedState({})).toBeNull();
    expect(sanitizeImportedState({ pacientes: 'x' })).toBeNull();
  });

  it('aceita estado válido mínimo', () => {
    const raw = {
      terapeutas: [], salas: [], usuarios: [], pacientes: [],
      solicitacoes: [], agendamentos: [], usoSalas: []
    };
    const r = sanitizeImportedState(raw);
    expect(r).not.toBeNull();
    expect(Array.isArray(r.pacientes)).toBe(true);
  });

  it('rejeita paciente com idade inválida', () => {
    const raw = {
      terapeutas: [], salas: [], usuarios: [], pacientes: [
        { id: 'p1', nome: 'Ana', idade: 200, status: 'triagem' }
      ],
      solicitacoes: [], agendamentos: [], usoSalas: []
    };
    expect(sanitizeImportedState(raw)).toBeNull();
  });

  it('rejeita id inválido', () => {
    const raw = {
      terapeutas: [{ id: 'bad id!', nome: 'T' }],
      salas: [], usuarios: [], pacientes: [],
      solicitacoes: [], agendamentos: [], usoSalas: []
    };
    expect(sanitizeImportedState(raw)).toBeNull();
  });
});
