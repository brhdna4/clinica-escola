/*!
 * Clínica-Escola de Psicologia — Camada de dados (Supabase)
 * ---------------------------------------------------------------------------
 * Este arquivo é o ÚNICO ponto do sistema que fala com o banco.
 *   index.html (Portal do Paciente) e panel.html (Painel da Equipe) usam a
 *   mesma API (window.ClinicaDB), portanto operam sobre a MESMA fonte de verdade.
 *
 * Papel do localStorage agora:
 *   - apenas CACHE de leitura (pintura instantânea + funcionamento se a rede cair);
 *   - a fonte de verdade dos dados é a tabela correspondente no Supabase.
 *
 * API pública (todas as funções devolvem Result: {ok:true,data} | {ok:false,error:{code,message}})
 *   ClinicaDB.iniciar()            -> conecta no Supabase, faz o 1º load e liga o realtime
 *   ClinicaDB.cache()              -> estado do cache local (síncrono, para a 1ª pintura)
 *   ClinicaDB.salvar(state[,opts]) -> grava o diff do estado (assíncrono, otimista)
 *   ClinicaDB.substituir(state)    -> apaga tudo e regrava o estado (reset/importação)
 *   ClinicaDB.carregar()           -> refaz a leitura completa a partir do Supabase
 *   ClinicaDB.atualizar()          -> recarrega e dispara onChange('remoto')
 *   ClinicaDB.limparCache()        -> limpa o cache local
 *   ClinicaDB.estadoConexao()      -> diagnóstico (modo, url, tabelas, contagens)
 *   hooks: ClinicaDB.onErro(msg), ClinicaDB.onChange(origem), ClinicaDB.onAviso(msg)
 *
 * Colunas: cada tabela usa exatamente os mesmos nomes de campo usados pelo app
 *   (ver supabase/migrations/20261027_clinica_schema.sql). Campos desconhecidos
 *   são preservados automaticamente na coluna jsonb "extra" — nada é perdido.
 */
(function (global) {
  'use strict';

  /* ==================== CONTRATO DE DADOS ==================== */
  var TABELAS = ['terapeutas', 'salas', 'pacientes', 'solicitacoes', 'agendamentos', 'usoSalas', 'usuarios'];

  var COLUNAS = {
    terapeutas:   ['id', 'nome', 'disponibilidade', 'ativo', 'tipo', 'semestre', 'professor', 'turma', 'codigo', 'periodo', 'professorId'],
    salas:        ['id', 'nome', 'ativa'],
    pacientes:    ['id', 'nome', 'idade', 'dataNascimento', 'cpf', 'nomeSocial', 'sexo', 'nomeMae', 'email', 'endereco', 'prontuario', 'telefone', 'terapeutaId', 'diaFix', 'horaFix', 'status', 'responsavel'],
    solicitacoes: ['id', 'pacienteId', 'terapeutaId', 'data', 'hora', 'status', 'mensagem', 'salaId'],
    agendamentos: ['id', 'pacienteId', 'terapeutaId', 'data', 'hora', 'salaId', 'status'],
    usoSalas:     ['id', 'alunoId', 'salaId', 'data', 'horaInicio', 'duracaoMin', 'pacienteId', 'nota'],
    usuarios:     ['id', 'nome', 'tipo', 'terapeutaId', 'codigo', 'ativo', 'extra']
  };

  var NUMERICAS = { pacientes: ['idade'], usoSalas: ['duracaoMin'] };

  var CACHE_KEY = 'clinicaPsicoDB_v2';        // mesma chave usada antes (compatível com dados existentes)
  var CACHE_CORROMPIDO = 'clinicaPsicoDB_v2_corrupt';
  var CDN = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js'
  ];
  var JANELA_ECO = 2000;      // ignora eventos realtime das próprias gravações (ms)
  var AUTH_TIMEOUT = 20000;   // limite de espera do login no Supabase Auth (ms)
  var LOTE_UPSERT = 400;
  var LOTE_DELETE = 200;

  /* ==================== ESTADO INTERNO ==================== */
  var cliente = null;
  var iniciado = false;
  var modo = 'local';                 // 'local' | 'supabase'
  var ultimaCarga = {};               // tabela -> { id: JSON canônico }
  var fila = Promise.resolve();       // serializa gravações (evita corrida entre diffs)
  var ultimaGravacao = 0;
  var recargaTimer = null;
  var recargaEmAndamento = null;
  var canal = null;
  var api = { onErro: null, onChange: null, onAviso: null, onSessaoExpirada: null };

  /* ==================== UTILITÁRIOS ==================== */
  function ok(data) { return { ok: true, data: data }; }
  function falha(code, message, details) {
    return { ok: false, error: { code: code, message: message, details: details || null } };
  }
  function clonar(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function tipoLista(v) { return Array.isArray(v) ? v : []; }
  function avisar(handler, msg) { if (typeof handler === 'function') { try { handler(msg); } catch (e) {} } }
  function log() { try { console.info.apply(console, ['[ClinicaDB]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }
  function alerta() { try { console.warn.apply(console, ['[ClinicaDB]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }
  function mensagemErro(e) { return (e && (e.message || e.error_description || e.hint)) || String(e || 'erro desconhecido'); }

  /* ==================== CONFIGURAÇÃO ==================== */
  function config() {
    var env = global.CLINICA_ENV || global.CLINICA_SUPABASE || {};
    var url = String(env.SUPABASE_URL || env.url || '').trim().replace(/\/+$/, '');
    var chave = String(env.SUPABASE_ANON_KEY || env.anonKey || env.chave || '').trim();
    var valido = /^https?:\/\/.+/i.test(url) && chave.length > 20 && chave.indexOf('<') < 0;
    return { url: url, chave: chave, valido: valido };
  }

  /* ==================== CANONIZAÇÃO (estado <-> linhas) ==================== */
  function canonizar(entidade, tabela) {
    var nums = NUMERICAS[tabela] || [];
    var saida = {};
    var obj = (entidade && typeof entidade === 'object') ? entidade : {};
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (nums.indexOf(k) >= 0) {
        if (v === null || v === undefined || v === '') saida[k] = null;
        else { var n = Number(v); saida[k] = isNaN(n) ? null : n; }
      } else {
        saida[k] = v;
      }
    });
    if (saida.id) saida.id = String(saida.id);
    return saida;
  }

  function paraLinha(canonico, tabela) {
    var cols = COLUNAS[tabela] || [];
    var linha = {}, extra = {};
    Object.keys(canonico).forEach(function (k) {
      if (cols.indexOf(k) >= 0) linha[k] = canonico[k];
      else extra[k] = canonico[k];
    });
    linha.extra = extra;                                  // nada é descartado
    linha.atualizadoEm = new Date().toISOString();
    return linha;
  }

  function paraEntidade(linha, tabela) {
    var ent = {};
    Object.keys(linha || {}).forEach(function (k) {
      if (k === 'extra' || k === 'criadoEm' || k === 'atualizadoEm') return;
      ent[k] = linha[k];
    });
    var extra = linha && linha.extra;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      Object.keys(extra).forEach(function (k) { ent[k] = extra[k]; });
    }
    if (ent.id) ent.id = String(ent.id);
    return ent;
  }

  function mapaTabela(lista, tabela) {
    var mapa = {};
    tipoLista(lista).forEach(function (ent) {
      if (!ent || !ent.id) return;
      mapa[String(ent.id)] = JSON.stringify(canonizar(ent, tabela));
    });
    return mapa;
  }

  function mapaDoEstado(estado) {
    var mapa = {};
    TABELAS.forEach(function (t) { mapa[t] = mapaTabela(estado && estado[t], t); });
    return mapa;
  }

  function estadoVazio(estado) {
    return TABELAS.every(function (t) { return Object.keys((estado && estado[t]) || {}).length === 0; });
  }

  function temDados(estado) {
    return TABELAS.some(function (t) { return tipoLista(estado && estado[t]).length > 0; });
  }

  /* ==================== CACHE LOCAL (leitura) ==================== */
  function cache() {
    var raw = null;
    try {
      raw = global.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (e) {
      try { if (raw) global.localStorage.setItem(CACHE_CORROMPIDO, String(raw).slice(0, 1000000)); } catch (_) {}
      return null;
    }
  }

  function gravarCache(estado) {
    try { global.localStorage.setItem(CACHE_KEY, JSON.stringify(estado)); return true; }
    catch (e) { return false; }
  }

  function limparCache() {
    try { global.localStorage.removeItem(CACHE_KEY); return true; } catch (e) { return false; }
  }

  /* ==================== CARGA DO SDK ==================== */
  function carregarSDK() {
    if (global.supabase && typeof global.supabase.createClient === 'function') return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var i = 0;
      function tentar() {
        if (i >= CDN.length) { reject(new Error('Não foi possível carregar o cliente Supabase (CDN indisponível).')); return; }
        var s = global.document.createElement('script');
        s.src = CDN[i++];
        s.async = true;
        s.onload = function () {
          if (global.supabase && typeof global.supabase.createClient === 'function') resolve();
          else tentar();
        };
        s.onerror = tentar;
        global.document.head.appendChild(s);
      }
      tentar();
    });
  }

  /* ==================== LEITURA ==================== */
  function carregar() {
    if (!cliente) return Promise.resolve(falha('CONFIG_MISSING', 'Supabase não configurado — operando somente com o cache local.'));

    var buscas = TABELAS.map(function (t) {
      return cliente.from(t).select('*').then(function (r) {
        if (r.error) {
          // Permissão negada (ex.: anon não lê 'pacientes' após hardening) não derruba a carga.
          if (r.error.code === '42501' || /permission|row-level security/i.test(r.error.message || '')) {
            // Sessão possivelmente expirada: avisa para re-login
            if (/jwt|invalid.*token|not.*authenticated/i.test(r.error.message || '')) {
              avisar(api.onSessaoExpirada, 'Sessão expirada. Faça login novamente.');
            }
            return { tabela: t, linhas: [] };
          }
          if (r.error.code === 'PGRST301' || /jwt expired|invalid jwt/i.test(r.error.message || '')) {
            avisar(api.onSessaoExpirada, 'Sessão expirada. Faça login novamente.');
          }
          throw new Error(t + ': ' + (r.error.message || 'falha na leitura'));
        }
        return { tabela: t, linhas: tipoLista(r.data) };
      }).catch(function (e) {
        // Rede/instância: mantém a tabela vazia em vez de abortar toda a carga.
        return { tabela: t, linhas: [] };
      });
    });

    return Promise.all(buscas).then(function (partes) {
      var estado = {};
      partes.forEach(function (p) {
        estado[p.tabela] = p.linhas.map(function (l) { return paraEntidade(l, p.tabela); });
      });
      TABELAS.forEach(function (t) { ultimaCarga[t] = mapaTabela(estado[t], t); });
      gravarCache(estado);
      return ok(estado);
    }).catch(function (e) {
      return falha('NETWORK_ERROR', 'Falha ao ler os dados do Supabase: ' + mensagemErro(e));
    });
  }

  /* ==================== ESCRITA ==================== */
  function emLotes(lista, tamanho) {
    var lotes = [];
    for (var i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
    return lotes;
  }

  function gravarTabela(tabela, linhas) {
    if (!linhas.length) return Promise.resolve();
    if (!cliente) return Promise.resolve();
    return (cliente.auth ? cliente.auth.getSession() : Promise.resolve({ data: { session: null } })).then(function (res) {
      var session = (res && res.data && res.data.session) ? res.data.session : null;
      if (session) {
        // autenticado (equipe): upsert normal
        return Promise.all(emLotes(linhas, LOTE_UPSERT).map(function (parte) {
          return cliente.from(tabela).upsert(parte).then(function (r) {
            if (r.error) {
              if (r.error.code === 'PGRST301' || /jwt expired|invalid jwt|permission|row-level security/i.test(r.error.message || '')) {
                avisar(api.onSessaoExpirada, 'Sessão expirada. Faça login novamente.');
              }
              throw new Error(r.error.message || 'falha ao gravar');
            }
          });
        }));
      }
      // anônimo (portal): insert sem retorno, para respeitar RLS de pacientes
      var cfg = config();
      return Promise.all(emLotes(linhas, LOTE_UPSERT).map(function (parte) {
        return fetch(cfg.url + '/rest/v1/' + encodeURIComponent(tabela), {
          method: 'POST',
          headers: {
            'apikey': cfg.chave,
            'Authorization': 'Bearer ' + cfg.chave,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(parte)
        }).then(function (r) {
          if (r.status === 409) return; // já existe
          if (r.status === 401 || r.status === 403) {
            avisar(api.onSessaoExpirada, 'Sessão expirada. Faça login novamente.');
          }
          if (!r.ok) {
            return r.text().then(function (txt) {
              var msg = txt;
              try { var j = JSON.parse(txt); msg = (j && (j.message || j.hint || j.details)) || txt; } catch (e) {}
              throw new Error(msg || ('HTTP ' + r.status));
            });
          }
        });
      }));
    });
  }

  function apagarIds(tabela, ids) {
    if (!ids.length) return Promise.resolve();
    return Promise.all(emLotes(ids, LOTE_DELETE).map(function (parte) {
      return cliente.from(tabela).delete().in('id', parte).then(function (r) {
        if (r.error) throw new Error(r.error.message || 'falha ao excluir');
      });
    }));
  }

  function apagarTabela(tabela) {
    // filtro sempre verdadeiro: necessário porque o PostgREST exige uma condição no DELETE
    return cliente.from(tabela).delete().not('id', 'is', null).then(function (r) {
      if (r.error) throw new Error(r.error.message || 'falha ao limpar');
    });
  }

  function empurrar(estado, opcoes) {
    var substituirTudo = !!(opcoes && opcoes.substituir);
    var mapa = mapaDoEstado(estado);
    var falhas = [];
    var cadeia = Promise.resolve();

    TABELAS.forEach(function (tabela) {
      cadeia = cadeia.then(function () {
        var agora = mapa[tabela];
        var antes = substituirTudo ? {} : (ultimaCarga[tabela] || {});
        var linhas = [], remover = [];

        Object.keys(agora).forEach(function (id) {
          if (substituirTudo || antes[id] !== agora[id]) {
            linhas.push(paraLinha(JSON.parse(agora[id]), tabela));
          }
        });
        if (!substituirTudo) {
          Object.keys(antes).forEach(function (id) { if (!(id in agora)) remover.push(id); });
        }

        var trabalho = substituirTudo ? apagarTabela(tabela) : Promise.resolve();
        return trabalho.then(function () {
          return gravarTabela(tabela, linhas).then(function () {
            return apagarIds(tabela, remover);
          });
        }).then(function () {
          ultimaCarga[tabela] = clonar(agora);
        }).catch(function (e) {
          falhas.push(tabela + ': ' + mensagemErro(e));   // mantém o diff pendente para nova tentativa
        });
      });
    });

    return cadeia.then(function () {
      if (falhas.length) {
        return falha('STORAGE_ERROR', 'Não foi possível sincronizar com o Supabase (' + falhas[0] + '). Os dados seguem salvos neste navegador.', falhas);
      }
      return ok({ sincronizado: true });
    });
  }

  function salvar(estado, opcoes) {
    if (!estado || typeof estado !== 'object') return Promise.resolve(falha('VALIDATION_ERROR', 'Estado inválido para gravação.'));

    gravarCache(estado);                                  // cache sempre atualizado (pintura/offline)
    if (!cliente) return Promise.resolve(ok({ modo: 'local' }));

    var copia = clonar(estado);
    ultimaGravacao = Date.now();
    var job = function () { return empurrar(copia, opcoes); };
    fila = fila.then(job, job);
    return fila.then(function (r) {
      if (r && !r.ok) avisar(api.onErro, r.error.message);
      return r;
    });
  }

  function substituir(estado) {
    if (!estado || typeof estado !== 'object') return Promise.resolve(falha('VALIDATION_ERROR', 'Estado inválido.'));
    gravarCache(estado);
    if (!cliente) return Promise.resolve(ok({ modo: 'local' }));
    var copia = clonar(estado);
    ultimaGravacao = Date.now();
    var job = function () { ultimaCarga = {}; return empurrar(copia, { substituir: true }); };
    fila = fila.then(job, job);
    return fila.then(function (r) {
      if (r && !r.ok) avisar(api.onErro, r.error.message);
      return r;
    });
  }

  /* ==================== TEMPO REAL ==================== */
  function agendarRecarga() {
    if (Date.now() - ultimaGravacao < JANELA_ECO) return;   // eco da própria gravação
    if (recargaTimer) clearTimeout(recargaTimer);
    recargaTimer = setTimeout(function () { recargaTimer = null; atualizar(); }, 400);
  }

  function atualizar() {
    if (!cliente) return Promise.resolve(falha('CONFIG_MISSING', 'Supabase não configurado.'));
    if (recargaEmAndamento) return recargaEmAndamento;
    recargaEmAndamento = carregar().then(function (r) {
      recargaEmAndamento = null;
      if (r.ok) avisar(api.onChange, 'remoto');
      return r;
    });
    return recargaEmAndamento;
  }

  function inscrever() {
    if (!cliente || canal) return;
    try {
      canal = cliente.channel('clinica-db');
      TABELAS.forEach(function (t) {
        canal.on('postgres_changes', { event: '*', schema: 'public', table: t }, function () { agendarRecarga(); });
      });
      canal.subscribe(function (status, err) {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          alerta('tempo real indisponível (' + status + ') — a sincronização continua ao focar a janela.', err || '');
        }
      });
    } catch (e) {
      alerta('tempo real indisponível:', mensagemErro(e));
    }
  }

  /* ==================== MIGRAÇÃO DO CACHE LOCAL ==================== */
  function migrarCacheParaBanco(localCapturado) {
    var local = temDados(localCapturado) ? localCapturado : cache();
    if (!temDados(local)) return Promise.resolve(ok({ migrado: false }));
    // a leitura inicial já espelhou o banco (vazio) no cache: devolve a cópia local
    // antes de importar, para não perder dados se a importação falhar.
    gravarCache(local);
    log('banco vazio — importando os dados que já estavam neste navegador…');
    return substituir(local).then(function (r) {
      if (r.ok) avisar(api.onAviso, 'Dados locais importados para a nuvem.');
      return r;
    });
  }

  /* ==================== INICIALIZAÇÃO ==================== */
  function iniciar() {
    if (iniciado) return Promise.resolve(ok({ modo: modo }));
    iniciado = true;

    var cfg = config();
    if (!cfg.valido) {
      modo = 'local';
      alerta('Supabase não configurado (config.js / .env). Operando com o cache local do navegador.');
      return Promise.resolve(falha('CONFIG_MISSING', 'Informe SUPABASE_URL e SUPABASE_ANON_KEY em config.js para ativar a nuvem.'));
    }

    // guarda o conteúdo local ANTES da primeira leitura do banco (a leitura
    // espelha o banco no cache; se o banco estiver vazio, este é o dado a importar)
    var cacheInicial = cache();

    // acorda a instância (REST + Auth) em paralelo com o download da SDK
    aquecer();

    return carregarSDK().then(function () {
      cliente = global.supabase.createClient(cfg.url, cfg.chave, {
        auth: { persistSession: true, autoRefreshToken: true },
        realtime: { params: { eventsPerSecond: 5 } }
      });
      modo = 'supabase';
      return carregar();
    }).then(function (r) {
      if (!r.ok) {
        // instância hibernando costuma falhar só na 1ª leitura: tenta mais uma vez
        return carregar().then(function (r2) {
          if (r2.ok) { modo = 'supabase'; return r2; }
          modo = 'local';
          avisar(api.onErro, r2.error.message);
          return r2;
        });
      }
      if (!estadoVazio(r.data)) return r;
      return migrarCacheParaBanco(cacheInicial).then(function () { return carregar(); }).then(function (r2) { return r2.ok ? r2 : r; });
    }).then(function (r) {
      if (r && r.ok) { inscrever(); log('conectado em ' + cfg.url + ' (' + modo + ')'); }
      return r;
    }).catch(function (e) {
      modo = 'local';
      return falha('UNKNOWN_ERROR', 'Falha ao iniciar a conexão com o Supabase: ' + mensagemErro(e));
    });
  }

  /* ==================== DIAGNÓSTICO ==================== */
  function estadoConexao() {
    var cfg = config();
    var contagens = {};
    try {
      var c = cache() || {};
      TABELAS.forEach(function (t) { contagens[t] = tipoLista(c[t]).length; });
    } catch (e) {}
    return {
      modo: modo,
      iniciado: iniciado,
      url: cfg.url || null,
      configurado: cfg.valido,
      tempoReal: !!canal,
      tabelas: TABELAS.slice(),
      cache: contagens
    };
  }

  /* ==================== AUTENTICAÇÃO (Supabase Auth) ==================== */
  /* Limita a espera de uma promessa: se o projeto estiver "dormindo", o login
     avisa em vez de ficar travado para sempre. */
  function comTimeout(promessa, ms) {
    return new Promise(function (resolve) {
      var terminou = false;
      var t = setTimeout(function () {
        if (terminou) return;
        terminou = true;
        resolve(falha('TIMEOUT', 'O Supabase demorou para responder. Tente novamente em alguns segundos.'));
      }, ms);
      promessa.then(function (r) { if (!terminou) { terminou = true; clearTimeout(t); resolve(r); } },
                    function (e) { if (!terminou) { terminou = true; clearTimeout(t); resolve(falha('AUTH_ERROR', mensagemErro(e))); } });
    });
  }

  function authSignUp(email, senha) {
    if (!cliente || !cliente.auth) return Promise.resolve(falha('NO_CLIENT', 'Cliente Supabase não inicializado'));
    // Pequeno atraso para reduzir colisão com rate limit do Supabase Auth
    return new Promise(function (resolve) { setTimeout(resolve, 400); }).then(function () {
      return cliente.auth.signUp({ email: String(email || '').trim(), password: String(senha || '') })
        .then(function (res) {
          if (res.error) return falha('AUTH_ERROR', res.error.message || 'Falha ao criar conta');
          return ok({ user: res.data.user, session: res.data.session });
        })
        .catch(function (e) { return falha('AUTH_ERROR', mensagemErro(e)); });
    });
  }

  function bloquearUsuarioAuth(email) {
    if (!cliente) return Promise.resolve(falha('CONFIG_MISSING', 'Supabase não configurado.'));
    return cliente.rpc('bloquear_usuario_auth', { p_email: String(email || '').trim() }).then(function (r) {
      if (r.error) return falha('NETWORK_ERROR', 'Falha ao bloquear conta: ' + mensagemErro(r.error));
      return ok(true);
    }).catch(function (e) { return falha('NETWORK_ERROR', 'Falha ao bloquear conta: ' + mensagemErro(e)); });
  }

  function desbloquearUsuarioAuth(email) {
    if (!cliente) return Promise.resolve(falha('CONFIG_MISSING', 'Supabase não configurado.'));
    return cliente.rpc('desbloquear_usuario_auth', { p_email: String(email || '').trim() }).then(function (r) {
      if (r.error) return falha('NETWORK_ERROR', 'Falha ao desbloquear conta: ' + mensagemErro(r.error));
      return ok(true);
    }).catch(function (e) { return falha('NETWORK_ERROR', 'Falha ao desbloquear conta: ' + mensagemErro(e)); });
  }

  function authSignIn(email, senha) {
    if (!cliente || !cliente.auth) return Promise.resolve(falha('NO_CLIENT', 'Cliente Supabase não inicializado'));
    var tentativa = function () {
      return cliente.auth.signInWithPassword({ email: email, password: senha })
        .then(function (res) {
          if (res.error) return falha('AUTH_ERROR', res.error.message || 'Falha na autenticação');
          return ok({ user: res.data.user, session: res.data.session });
        })
        .catch(function (e) { return falha('AUTH_ERROR', mensagemErro(e)); });
    };
    return comTimeout(tentativa(), AUTH_TIMEOUT).then(function (r) {
      // falha de rede (sem resposta do servidor): uma nova tentativa costuma resolver
      if (!r.ok && r.error.code === 'AUTH_ERROR' && /fetch|network|failed/i.test(r.error.message)) {
        return comTimeout(tentativa(), 10000);
      }
      return r;
    });
  }

  /* Aquece a instância do Supabase (REST + Auth) assim que a página abre.
     O projeto hiberna quando fica sem uso; o primeiro acesso chega a levar
     ~20s. Disparando isso no carregamento, o usuário digita a senha enquanto
     a instância acorda, em vez de esperar tudo no clique de "Entrar". */
  function aquecer() {
    var cfg = config();
    if (!cfg.valido) return Promise.resolve(falha('CONFIG_MISSING', 'Supabase não configurado.'));
    var url = cfg.url.replace(/\/$/, '');
    var cab = { apikey: cfg.chave, Authorization: 'Bearer ' + cfg.chave };
    var pings = [
      fetch(url + '/auth/v1/health', { headers: cab, cache: 'no-store' }).catch(function () {}),
      fetch(url + '/rest/v1/' + TABELAS[TABELAS.length - 1] + '?select=id&limit=1', { headers: cab, cache: 'no-store' }).catch(function () {})
    ];
    return Promise.all(pings).then(function () { return ok({ aquecido: true }); });
  }

  function authResetPassword(email) {
    if (!cliente || !cliente.auth) return Promise.resolve(falha('NO_CLIENT', 'Cliente Supabase não inicializado'));
    var url = window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + 'panel.html';
    return cliente.auth.resetPasswordForEmail(String(email || '').trim(), { redirectTo: url })
      .then(function (res) {
        if (res.error) return falha('AUTH_ERROR', res.error.message || 'Falha ao enviar e-mail de recuperação');
        return ok(true);
      })
      .catch(function (e) { return falha('AUTH_ERROR', mensagemErro(e)); });
  }

  function auditLog(acao, alvo, detalhes) {
    if (!cliente) return Promise.resolve(falha('CONFIG_MISSING', 'Supabase não configurado.'));
    return cliente.from('audit_log').insert({ ator: (window.__CLINICA_AUTH && window.__CLINICA_AUTH.email) || localStorage.getItem('clinicaAuthUser') || null, acao: String(acao || ''), alvo: alvo ? String(alvo) : null, detalhes: detalhes || null }).then(function (r) {
      if (r.error) return falha('NETWORK_ERROR', mensagemErro(r.error));
      return ok(true);
    }).catch(function (e) { return falha('NETWORK_ERROR', mensagemErro(e)); });
  }

  function authSignOut() {
    if (!cliente || !cliente.auth) return Promise.resolve(ok(null));
    return cliente.auth.signOut().then(function () { return ok(null); }).catch(function () { return ok(null); });
  }

  function authGetSession() {
    if (!cliente || !cliente.auth) return Promise.resolve(ok(null));
    return cliente.auth.getSession().then(function (res) { return ok(res.data.session || null); }).catch(function () { return ok(null); });
  }

  function authGetUser() {
    if (!cliente || !cliente.auth) return Promise.resolve(ok(null));
    return cliente.auth.getUser().then(function (res) { return ok(res.data.user || null); }).catch(function () { return ok(null); });
  }

  function getClient() { return cliente; }

  /* ==================== ADMIN (alteração de senha via Supabase Auth) ==================== */
  function alterarSenhaUsuario(email, novaSenha) {
    if (!cliente) return Promise.resolve(falha('CONFIG_MISSING', 'Supabase não configurado.'));
    var em = String(email || '').trim();
    var sn = String(novaSenha || '');
    return cliente.rpc('alterar_senha_usuario', { p_email: em, p_nova_senha: sn }).then(function (r) {
      if (r.error) {
        // Se o usuário não existe no Auth, tenta criar a conta primeiro (signUp)
        if (/não encontrado|not found/i.test(r.error.message || '')) {
          return authSignUp(em, sn).then(function (rs) {
            if (!rs.ok) return falha('AUTH_ERROR', 'Conta não existia e não foi possível criar: ' + (rs.error && rs.error.message));
            // tenta novamente a RPC (agora o usuário existe)
            return cliente.rpc('alterar_senha_usuario', { p_email: em, p_nova_senha: sn }).then(function (r2) {
              if (r2.error) return falha('NETWORK_ERROR', 'Falha ao alterar senha: ' + mensagemErro(r2.error));
              return ok(true);
            });
          });
        }
        return falha('NETWORK_ERROR', 'Falha ao alterar senha: ' + mensagemErro(r.error));
      }
      return ok(true);
    }).catch(function (e) { return falha('NETWORK_ERROR', 'Falha ao alterar senha: ' + mensagemErro(e)); });
  }

  /* ==================== PORTAL (busca pública mínima) ==================== */
  function buscarPacientePortal(termo) {
    if (!cliente) return Promise.resolve(falha('CONFIG_MISSING', 'Supabase não configurado.'));
    return cliente.rpc('portal_buscar_paciente', { termo: String(termo || '').trim() }).then(function (r) {
      if (r.error) return falha('NETWORK_ERROR', 'Falha na busca: ' + mensagemErro(r.error));
      var linhas = tipoLista(r.data).map(function (l) {
        return { id: String(l.id), nome: l.nome, status: l.status, terapeutaId: l.terapeutaId };
      });
      return ok(linhas);
    }).catch(function (e) { return falha('NETWORK_ERROR', 'Falha na busca: ' + mensagemErro(e)); });
  }

  /* ==================== EXPORTAÇÃO ==================== */
  global.ClinicaDB = {
    TABELAS: TABELAS,
    COLUNAS: COLUNAS,
    iniciar: iniciar,
    cache: cache,
    gravarCache: gravarCache,
    limparCache: limparCache,
    salvar: salvar,
    substituir: substituir,
    carregar: carregar,
    atualizar: atualizar,
    buscarPacientePortal: buscarPacientePortal,
    alterarSenhaUsuario: alterarSenhaUsuario,
    estadoConexao: estadoConexao,
    authSignIn: authSignIn,
    authSignUp: authSignUp,
    bloquearUsuarioAuth: bloquearUsuarioAuth,
    desbloquearUsuarioAuth: desbloquearUsuarioAuth,
    authResetPassword: authResetPassword,
    auditLog: auditLog,
    aquecer: aquecer,
    authSignOut: authSignOut,
    authGetSession: authGetSession,
    authGetUser: authGetUser,
    getClient: getClient,
    get modo() { return modo; },
    set onErro(fn) { api.onErro = fn; },
    set onChange(fn) { api.onChange = fn; },
    set onAviso(fn) { api.onAviso = fn; },
    set onSessaoExpirada(fn) { api.onSessaoExpirada = fn; }
  };
})(window);
