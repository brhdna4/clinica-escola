/* ==========================================================================
   js/utils.js — funções puras compartilhadas (Clínica-Escola)
   Carregado como script clássico (globals) em index.html e panel.html.
   Também utilizado pelos testes via tests/setup.js (escopo global).
   ========================================================================== */
(function (root) {
  'use strict';

  const uid = () => (root.crypto && typeof root.crypto.randomUUID === 'function')
    ? root.crypto.randomUUID()
    : ('id_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4));

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const onlyDigits = v => String(v == null ? '' : v).replace(/\D/g, '');

  const normalizaNome = v => String(v == null ? '' : v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();

  const normalizar = normalizaNome;
  const onlyDigitsNorm = s => onlyDigits(s);

  const validaTel = v => {
    const d = onlyDigits(v);
    return (d.length === 10 || d.length === 11) && !/^(\d)\1+$/.test(d);
  };

  const validaCpf = v => {
    const c = onlyDigits(v);
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    let soma = 0;
    for (let i = 0; i < 9; i++) soma += Number(c[i]) * (10 - i);
    let d1 = (soma * 10) % 11;
    if (d1 === 10) d1 = 0;
    if (d1 !== Number(c[9])) return false;
    soma = 0;
    for (let i = 0; i < 10; i++) soma += Number(c[i]) * (11 - i);
    let d2 = (soma * 10) % 11;
    if (d2 === 10) d2 = 0;
    return d2 === Number(c[10]);
  };

  const validaEmail = v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());

  const validaHora = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));

  const SLOTS = ['08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30','19:00','19:30','20:00','20:30'];

  function sanitizeImportedState(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.pacientes)) return null;
    try { if (JSON.stringify(raw).length > 2000000) return null; } catch (e) { return null; }
    const safeId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
    const safeDate = v => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
      const [y, m, d] = v.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
    };
    const safeTime = v => validaHora(v);
    const lim = arr => Array.isArray(arr) ? arr.slice(0, 5000) : [];
    const s = {
      terapeutas: lim(raw.terapeutas), salas: lim(raw.salas),
      usuarios: lim(raw.usuarios), pacientes: lim(raw.pacientes),
      solicitacoes: lim(raw.solicitacoes), agendamentos: lim(raw.agendamentos),
      usoSalas: lim(raw.usoSalas)
    };
    const todos = [...s.terapeutas, ...s.salas, ...s.usuarios, ...s.pacientes, ...s.solicitacoes, ...s.agendamentos, ...s.usoSalas];
    if (todos.some(x => !x || typeof x !== 'object' || !safeId(x.id))) return null;
    const stPac = new Set(['agendado', 'triagem', 'vinculado', 'desistiu']);
    const stSol = new Set(['pendente', 'aprovada', 'recusada', 'sugerida']);
    const stAg = new Set(['agendado', 'compareceu', 'falta_justificada', 'desistiu']);
    s.pacientes.forEach(p => { p.idade = Number(p.idade); });
    s.usoSalas.forEach(u => { u.duracaoMin = Number(u.duracaoMin); });
    if (s.pacientes.some(p => typeof p.nome !== 'string' || p.nome.length < 1 || p.nome.length > 200 || !Number.isFinite(p.idade) || p.idade < 0 || p.idade > 120 || !stPac.has(p.status))) return null;
    if (s.solicitacoes.some(x => !safeDate(x.data) || !safeTime(x.hora) || !stSol.has(x.status))) return null;
    if (s.agendamentos.some(x => !safeDate(x.data) || !safeTime(x.hora) || !stAg.has(x.status))) return null;
    if (s.usoSalas.some(x => !safeDate(x.data) || !safeTime(x.horaInicio) || !Number.isFinite(x.duracaoMin) || x.duracaoMin < 1 || x.duracaoMin > 600)) return null;
    if (s.terapeutas.some(t => typeof t.nome !== 'string' || t.nome.length > 200 || (t.disponibilidade && Object.values(t.disponibilidade).some(arr => !Array.isArray(arr) || arr.some(h => !SLOTS.includes(h)))))) return null;
    return s;
  }

  // Expor como globals (navegador) e também em root (testes)
  const api = { uid, esc, onlyDigits, normalizaNome, normalizar, onlyDigitsNorm, validaTel, validaCpf, validaEmail, validaHora, SLOTS, sanitizeImportedState };
  Object.keys(api).forEach(k => { root[k] = api[k]; });

  // Suporte a módulo (ESM/CJS) para testes
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof define === 'function' && define.amd) { define(function () { return api; }); }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
