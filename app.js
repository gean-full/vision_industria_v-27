'use strict';
/*
 * VisioIndústria: camada de aplicação. Liga a interface, a câmera, o modelo COCO-SSD, a voz e o ciclo de vida.
 * Toda a lógica de decisão é PURA e fica em js/nucleo.js (window.VisioNucleo); aqui ficam só os efeitos colaterais.
 * Nada é gravado nem enviado: os quadros ficam na memória do navegador durante a análise.
 */
(() => {
  const $ = id => document.getElementById(id);
  const N = window.VisioNucleo;
  if (!N){ const s = $('status'); if (s) s.textContent = 'Erro: arquivos do aplicativo incompletos (js/nucleo.js não carregou). Recarregue a página.'; return; }
  const {CLASSES, criarAgendador, ladosConfirmados, estadoAnalise, regioesDeMascara, validarFonteExterna, ZTXT, ZONAS, LIM, configurarLimites,
    resolverLados, ladoUsuario, rotulosLados, zonaDe, limiar, avaliarPassagemPorCor, criarEstabilizadorAlt, decidirOrientacao, planejar, planejarSemObjetos,
    atualizarTracks, validarPredicoes, criarCicloDeVida, mensagemErroInicio} = N;
  const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');

  let modeloAtual = '', modeloEstado = 'nao_carregado', modeloCargaMs = 0, model = null, carga = null, stream = null;
  let voice = null, falhasVoz = 0, audioCtx = null;
  const tracks = new Map();      // chave "nome falado|zona" → estado de estabilização (ver atualizarTracks)
  const metrics = {frames:0, alertas:0, supr:0, falhas:0, rows:[]};
  let falhasSeguidas = 0, avisouFalha = false, ultimoOkEm = 0;

  const status = t => { $('status').textContent = t; };
  const bind = (id, out, fmt = v => v) => { const e = $(id); const u = () => $(out).textContent = fmt(e.value); e.addEventListener('input', u); u(); };
  bind('conf','confV',v=>v+'%'); bind('persist','persistV'); bind('intervalo','intervaloV'); bind('cool','coolV');
  const cfg = () => ({conf:+$('conf').value/100, persist:+$('persist').value, intervalo:+$('intervalo').value, cool:+$('cool').value*1000});

  // ---------- Ciclo de vida ----------
  // Fonte única da verdade sobre a sessão: os botões, o texto de estado e o agendador derivam daqui.
  const ROTULO_VIDA = {ocioso:'Pronta para iniciar', solicitando_camera:'Aguardando a câmera', carregando_modelo:'Carregando o modelo', ativo:'Assistência ativa',
    pausado:'Assistência pausada', camera_indisponivel:'Câmera indisponível', modelo_indisponivel:'Modelo indisponível'};
  const vida = criarCicloDeVida(() => { atualizarControles(); atualizarEstado(); });
  const emSessao = () => vida.emSessao(), ativo = () => vida.estado() === 'ativo';
  function atualizarControles(){
    const e = vida.estado(), sessao = vida.emSessao(), iniciando = vida.iniciando();
    $('btnIniciar').disabled = sessao || iniciando; $('btnIniciar').textContent = iniciando ? 'Iniciando…' : 'Iniciar assistência';
    $('btnPausar').disabled = !sessao; $('btnPausar').textContent = e === 'pausado' ? 'Retomar' : 'Pausar';
    $('btnEncerrar').disabled = !(sessao || iniciando); $('btnEncerrar').textContent = iniciando ? 'Cancelar' : 'Encerrar';
    // Modelo e câmera só valem no início de uma sessão: bloqueá-los evita a impressão de que a troca teve efeito imediato.
    $('modelo').disabled = sessao || iniciando; $('camSel').disabled = sessao || iniciando;
  }
  // Selo de estado: texto sempre presente (a cor só reforça). "Inconclusiva" vem da última decisão: dados ausentes, inválidos ou velhos.
  function atualizarEstado(){
    const e = vida.estado(), inconclusiva = e === 'ativo' && ultimaDecisao && ultimaDecisao.decisao === 'analise_insuficiente';
    const el = $('estado'); el.textContent = ROTULO_VIDA[e] + (inconclusiva ? ' · análise inconclusiva' : '');
    if (el.dataset) el.dataset.estado = inconclusiva ? 'inconclusiva' : e;
  }

  // ---------- Áudio ----------
  const temVoz = () => 'speechSynthesis' in window && !!window.speechSynthesis;
  function pickVoice(){
    const vs = speechSynthesis.getVoices();
    voice = vs.find(v => /pt-BR/i.test(v.lang)) || vs.find(v => /^pt/i.test(v.lang)) || null;
    mostrarVoz();
  }
  function mostrarVoz(){
    $('mVoz').textContent = !temVoz() ? 'indisponível neste navegador: os avisos não são falados'
      : (voice ? 'voz ' + voice.lang + (voice.name ? ' (' + voice.name + ')' : '') : 'sem voz em português instalada: usa a voz padrão do sistema')
        + (falhasVoz ? ' · ' + falhasVoz + ' falha(s) de fala' : '');
  }
  if (temVoz()){ pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; } else mostrarVoz();
  // Urgente interrompe o que está sendo falado; o resto nunca forma fila (evita falar direção velha depois que a cena mudou).
  function falar(texto, urgente = false){
    if (!temVoz()) return false;
    if (urgente) speechSynthesis.cancel();
    else if (speechSynthesis.speaking || speechSynthesis.pending) return false;
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = 'pt-BR'; if (voice) u.voice = voice; u.rate = 1.1;
    u.onerror = ev => { if (ev && (ev.error === 'interrupted' || ev.error === 'canceled')) return; falhasVoz++; mostrarVoz(); };
    speechSynthesis.speak(u);
    return true;
  }
  const calarFala = () => { if (temVoz()) speechSynthesis.cancel(); };
  // O AudioContext só pode tocar depois de um gesto do usuário: é criado (ou retomado) nos cliques de Iniciar e Testar áudio, e reaproveitado.
  function prepararAudio(){
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    try{ if (!audioCtx) audioCtx = new AC(); if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); }
    catch(e){ audioCtx = null; }
  }
  function bipe(freq = 880, ms = 120){
    if (!audioCtx || audioCtx.state === 'closed') return false;
    try{
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; g.gain.value = .15; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + ms/1000);
      return true;
    }catch(e){ return false; }     // bipe é só reforço da fala: sua falha não pode afetar a análise
  }

  // ---------- Câmera ----------
  async function listarCameras(){
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try{
      const sel = $('camSel'), atual = sel.value;
      const ds = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      sel.innerHTML = '<option value="">Padrão (traseira)</option>';
      ds.forEach((d,i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || ('Câmera ' + (i+1)); sel.appendChild(o); });
      if (atual && ds.some(d => d.deviceId === atual)) sel.value = atual;     // a lista é refeita após a permissão: mantém a câmera escolhida
    }catch(e){ log('Não foi possível listar as câmeras: ' + (e && e.message)); }
  }
  async function abrirCamera(s){
    const id = $('camSel').value;
    const c = {audio:false, video: id ? {deviceId:{exact:id}, width:{ideal:640}, height:{ideal:480}}
                                      : {facingMode:{ideal:'environment'}, width:{ideal:640}, height:{ideal:480}}};
    const st = await navigator.mediaDevices.getUserMedia(c);
    // Encerrado enquanto o navegador pedia permissão: esta câmera não pertence a nenhuma sessão e é liberada na hora.
    if (!vida.vale(s)){ st.getTracks().forEach(t => t.stop()); return; }
    stream = st; video.srcObject = st;
    status('Iniciando a câmera…');
    await video.play();
    if (!vida.vale(s)) return;                       // encerrar() já liberou a câmera
    const trk = st.getVideoTracks()[0];
    trk.addEventListener('ended', () => perderCamera(s, 'A câmera foi desconectada ou bloqueada pelo sistema.'));
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    facing = (trk.getSettings && trk.getSettings().facingMode) || '';
    atualizarLados(); if (ladosAtual().motivo === 'câmera frontal detectada') log('Câmera frontal: lados invertidos automaticamente. Confira no seletor "Lados".');
    listarCameras();
  }
  function fecharCamera(){ camParar(); if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; } video.srcObject = null; }

  // ---------- Modelo ----------
  // Uma carga por modelo-base: pedidos repetidos reaproveitam a mesma promessa. Se a sessão que pediu a carga for encerrada, a carga termina
  // e o modelo fica guardado para a próxima sessão, mas não reativa nada (quem decide é o ciclo de vida). Trocar de base libera o modelo antigo.
  function garantirModelo(base){
    if (model && modeloAtual === base) return Promise.resolve(model);
    if (carga && carga.base === base) return carga.promessa;
    if (typeof cocoSsd === 'undefined' || !cocoSsd || typeof cocoSsd.load !== 'function')
      return Promise.reject(Object.assign(new Error('cocoSsd ausente'), {mensagemUsuario:'A biblioteca de detecção não foi carregada (sem internet ou bloqueada pela rede). Recarregue a página com internet.'}));
    if (model && typeof model.dispose === 'function'){ try { model.dispose(); } catch (e) { log('Aviso: falha ao liberar o modelo anterior.'); } }
    model = null; modeloAtual = ''; modeloEstado = 'carregando'; atualizarPainel();
    const tc = performance.now();
    const promessa = Promise.resolve().then(() => cocoSsd.load({base})).then(m => {
      if (!carga || carga.promessa !== promessa){ if (m && typeof m.dispose === 'function') m.dispose(); throw new Error('carga substituída'); }
      carga = null; model = m; modeloAtual = base; modeloCargaMs = performance.now() - tc; modeloEstado = 'pronto'; atualizarPainel(); return m;
    }, e => {
      if (carga && carga.promessa === promessa){ carga = null; modeloEstado = 'erro'; atualizarPainel(); }
      throw e;
    });
    carga = {base, promessa};
    return promessa;
  }

  // ---------- Fluxo ----------
  async function iniciar(){
    if (ativo()) return pausar();
    if (vida.estado() === 'pausado') return retomar();
    if (vida.iniciando()) return;                     // clique ou tecla repetida durante o início: não abre uma segunda câmera
    prepararAudio();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      return falhaInicio(window.isSecureContext === false ? mensagemErroInicio(null, 'camera', {contextoSeguro:false}) : 'Este navegador não permite acesso à câmera. Abra a página por https ou em localhost.');
    if (!temVoz()) return falhaInicio('Este navegador não tem síntese de voz: os avisos não poderiam ser falados.');
    const s = vida.abrir(); if (!s) return;
    try{
      status('Aguardando permissão da câmera…');
      await abrirCamera(s);
      if (!vida.transitar('carregando_modelo', s)) return;
      status('Carregando o modelo de detecção (na primeira vez é baixado pela internet)…');
      await garantirModelo($('modelo').value);
      if (!vida.transitar('ativo', s)) return;        // encerrado durante a carga: o modelo fica pronto, a sessão não volta
      perfRows.length = 0; limparEvidencias();
      status('Assistência ativa.'); falar('Assistência ativada. Os avisos não garantem caminho livre.', true);
      camIniciar(); agendador.iniciar(); iniciarPainel();
    }catch(e){
      if (!vida.vale(s)) return;                      // a sessão já foi encerrada: nada a relatar
      const etapa = vida.estado() === 'carregando_modelo' ? 'modelo' : 'camera';
      vida.transitar(etapa === 'modelo' ? 'modelo_indisponivel' : 'camera_indisponivel', s);
      fecharCamera();
      falhaInicio(mensagemErroInicio(e, etapa, {contextoSeguro: window.isSecureContext}));
    }
  }
  function falhaInicio(msg){
    metrics.falhas++; $('mFa').textContent = metrics.falhas; atualizarPainel();
    status('Erro: ' + msg); log('FALHA ao iniciar — ' + msg);
    falar('Atenção: não foi possível iniciar a análise do ambiente.', true);
  }
  function pausar(motivo){
    if (!vida.transitar('pausado')) return;
    agendador.pausar(); ctx.clearRect(0,0,canvas.width,canvas.height);
    status('Assistência pausada' + (motivo ? ' (' + motivo + ')' : '') + '. Toque em Retomar para continuar.'); falar('Assistência pausada.', true);
  }
  // Ao retomar, a cena pode ser outra: estabilização, alternativas e avisos de ANTES da pausa são evidência velha e não podem orientar nada.
  function limparEvidencias(){ tracks.clear(); estabAlt.reset(); aquecimento = 0; ultimaEscolha = null; ultimaAss = ''; ultimaUrg = ''; vazio = 0; avisouNenhum = false; candCiclos = 0; falhasSeguidas = 0; avisouFalha = false; ultimoErroCodigo = ''; ultimoOkEm = 0; }
  function retomar(){
    if (!stream || !stream.active) return perderCamera(vida.sessao(), 'A câmera não está mais disponível.');
    if (!vida.transitar('ativo')) return;
    limparEvidencias(); status('Assistência ativa.'); falar('Assistência retomada.', true); agendador.retomar();
  }
  function encerrar(){
    const e = vida.estado(); if (!vida.emSessao() && !vida.iniciando()) return;
    const cancelouInicio = vida.iniciando();
    vida.encerrar(); agendador.parar(); pararPainel(); fecharCamera(); ctx.clearRect(0,0,canvas.width,canvas.height); limparEvidencias();
    calarFala();
    status(cancelouInicio ? 'Início cancelado. Assistência encerrada.' : 'Assistência encerrada.'); falar('Assistência encerrada.', true);
    if (e === 'carregando_modelo') atualizarPainel();
  }
  // Câmera perdida no meio da sessão: para tudo, libera o que restou e avisa uma vez. Nada do que foi visto antes continua valendo.
  function perderCamera(s, msg){
    if (!vida.vale(s) || !vida.emSessao()) return;
    agendador.parar(); pararPainel(); fecharCamera(); ctx.clearRect(0,0,canvas.width,canvas.height); limparEvidencias();
    ultimoErroCodigo = 'camera_indisponivel'; vida.transitar('camera_indisponivel', s);
    metrics.falhas++; $('mFa').textContent = metrics.falhas;
    mostrarOrientacao(decidirOrientacao({modo: modoAtual(), agora: performance.now(), deteccao:{estado:'camera_indisponivel', motivo: msg}}));
    status('Falha: ' + msg + ' Toque em "Iniciar assistência" para tentar de novo.');
    falar('Atenção: a análise da câmera foi interrompida. Pare e aguarde.', true); bipe(300, 400); log('FALHA — ' + msg);
    atualizarPainel();
  }
  function falha(msg, cod){
    metrics.falhas++; $('mFa').textContent = metrics.falhas;
    status('Falha: ' + msg);
    const camera = cod === 'camera_indisponivel' || cod === 'sem_quadros_novos';
    if (!avisouFalha){ avisouFalha = true; falar(camera ? 'Atenção: a análise da câmera foi interrompida. Pare e aguarde.' : 'Atenção: não foi possível avaliar a passagem. Pare e aguarde.', true); bipe(300, 400); log('FALHA — ' + msg); }
  }

  // ---------- Detecção ----------
  // FPS da câmera = quadros novos entregues ao elemento <video> (requestVideoFrameCallback), diferente do FPS efetivo da análise.
  const cam = {frames:0, stamps:[], ultimoAnalisado:0, ativo:false, rvfc:false};
  function camTick(){ if (!cam.ativo) return; cam.frames++; cam.stamps.push(performance.now()); if (cam.stamps.length > 200) cam.stamps.shift(); video.requestVideoFrameCallback(camTick); }
  function camIniciar(){ cam.rvfc = typeof video.requestVideoFrameCallback === 'function'; cam.frames = 0; cam.stamps = []; cam.ultimoAnalisado = 0; cam.ativo = cam.rvfc; if (cam.rvfc) video.requestVideoFrameCallback(camTick); }
  function camParar(){ cam.ativo = false; }
  function camFps(){ if (!cam.rvfc || !cam.ativo) return null; const t = performance.now(); return cam.stamps.filter(x => x > t - 2000).length / 2; }
  // Sem imagem = erro. Sem quadro novo (onde o navegador informa isso) = ciclo ignorado, e erro se durar demais.
  function verificarCamera(){
    if (video.readyState < 2 || !stream || !stream.active) return {erro:'Sem imagem da câmera.'};
    if (cam.rvfc && cam.frames === cam.ultimoAnalisado) return {ignorar:'sem_quadro_novo'};
    return {};
  }

  const perfRows = [];
  const ESTADO_POR_CODIGO = {inferencia_expirada:'inferencia_expirada', camera_indisponivel:'camera_indisponivel', sem_quadros_novos:'camera_indisponivel'};
  function registrarCiclo(r){
    perfRows.push([new Date().toISOString(), r.ciclo, r.resultado, r.erro || '', r.tempos['coco-ssd'] ?? '', r.totalMs, modeloAtual, camFps() ?? '', r.codigo || '']);
    if (perfRows.length > 3000) perfRows.shift();
  }
  const agendador = criarAgendador({
    now: () => performance.now(), setTimer: (f, ms) => setTimeout(f, ms), clearTimer: t => clearTimeout(t),
    intervalo: () => cfg().intervalo, verificar: verificarCamera, folgaMin: 30, folgaIgnorado: 20, stallMs: 2500, watchdogMs: 15000,
    aoErro: e => {
      const cod = (e && e.codigo) || 'falha_inferencia'; ultimoErroCodigo = cod; estabAlt.reset(); aquecimento = 0; ultimaAss = '';
      mostrarOrientacao(decidirOrientacao({modo: modoAtual(), agora: performance.now(), deteccao:{estado: ESTADO_POR_CODIGO[cod] || 'falha', motivo: e && e.message}}));
      falhasSeguidas++; if (falhasSeguidas >= 3) falha((e && e.message) || 'Erro de processamento.', cod);
    },
    aoCiclo: registrarCiclo
  });
  // Modelo de detecção. Um segmentador entra com agendador.registrar (ver registrarSegmentador) e roda no mesmo ciclo, sem concorrência.
  // O resultado carrega o instante e o identificador do quadro, as dimensões DAQUELE quadro e (se a avaliação de piso estiver ligada) os pixels do MESMO
  // instante, capturados antes de a inferência começar. Assim caixas e pixels descrevem a mesma cena.
  let seqQuadro = 0, ultimoErroCodigo = '';
  agendador.registrar({
    nome:'coco-ssd', prio:10, pronto: () => model !== null && modeloEstado === 'pronto',
    executar: async () => {
      cam.ultimoAnalisado = cam.frames;
      const tCap = performance.now(), W = video.videoWidth, H = video.videoHeight, quadroId = cam.rvfc ? cam.frames : ++seqQuadro;
      const img = (modoAtual() === 'padrao' && !segAtual && $('passagem').value === 'ligada') ? capturarQuadro() : undefined;
      const preds = await model.detect(video, 20, 0.3);
      return {preds, tCap, tConclusao: performance.now(), W, H, quadroId, img};
    },
    aoConcluir: r => { falhasSeguidas = 0; avisouFalha = false; ultimoErroCodigo = ''; ultimoOkEm = performance.now(); desenhar(analisar(r)); }
  });

  // ---------- Painel de desempenho ----------
  const ROTULO_ESTADO = {parado:'parado', pronto:'pronto', aguardando_camera:'aguardando a câmera', carregando_modelo:'carregando o modelo…', falha_carregamento:'falha ao carregar o modelo', analisando:'analisando', pausado:'pausado', camera_indisponivel:'câmera indisponível', inferencia_expirada:'inferência expirada', falha_na_analise:'falha na análise'};
  const fms = v => v == null ? '–' : v.toFixed(v < 10 ? 1 : 0) + ' ms';
  const fres = r => r ? fms(r.ultimo) + ' · méd ' + fms(r.media) + ' · p95 ' + fms(r.p95) : '–';
  function atualizarPainel(){
    const s = agendador.snapshot(performance.now()), c = s.tarefas['coco-ssd'] || {n:0}, sessao = emSessao();
    $('mModelo').textContent = {nao_carregado:'não carregado', carregando:'carregando…', pronto:'pronto (' + modeloAtual + ')', erro:'erro ao carregar'}[modeloEstado];
    $('mEst').textContent = ROTULO_ESTADO[estadoAnalise({modeloEstado, running: sessao, paused: vida.estado() === 'pausado', emCurso:s.emCurso, ultimoErro:ultimoErroCodigo, vida: vida.estado()})];
    $('mExp').textContent = s.expirados;
    const sgm = s.tarefas['segmentacao']; $('mSeg').textContent = sgm && sgm.n ? fres(sgm) + (sgm.adiadas ? ' · adiada ' + sgm.adiadas + '×' : '') : (segReg ? 'registrado, sem medições' : 'nenhum segmentador registrado');
    $('mBackend').textContent = (typeof tf !== 'undefined' && tf.getBackend && tf.getBackend()) || '–';
    $('mCarga').textContent = modeloCargaMs ? (modeloCargaMs/1000).toFixed(1) + ' s' : '–';
    $('mInf').textContent = c.n ? fres(c) : '–';
    $('mCic').textContent = fres(s.ciclo);
    $('mFps').textContent = s.fpsEfetivo == null ? '–' : s.fpsEfetivo.toFixed(1) + ' /s';
    const cf = camFps(); $('mCam').textContent = !cam.rvfc && !cam.ativo ? (sessao ? 'indisponível neste navegador' : '–') : (cf == null ? '–' : cf.toFixed(0) + ' /s');
    $('mUlt').textContent = !sessao ? '–' : ultimoOkEm ? ((performance.now() - ultimoOkEm)/1000).toFixed(1) + ' s atrás' : 'nenhum ainda';
    $('mFr').textContent = s.concluidos; $('mIgn').textContent = s.ignorados; $('mIgn').title = JSON.stringify(s.motivos);
    $('mErr').textContent = s.erros; $('mAtr').textContent = s.acimaIntervalo; $('mDesc').textContent = s.descartados;
  }
  let uiTimer = null;
  function iniciarPainel(){ if (!uiTimer) uiTimer = setInterval(atualizarPainel, 500); atualizarPainel(); }
  function pararPainel(){ clearInterval(uiTimer); uiTimer = null; atualizarPainel(); }
  // Revogar o endereço no mesmo instante do clique cancela o download em alguns navegadores: libera um pouco depois.
  function baixar(nome, csv){
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = nome; a.click(); const h = a.href; setTimeout(() => URL.revokeObjectURL(h), 10000);
  }
  $('btnPerf').onclick = () => {
    const f = v => typeof v === 'number' ? v.toFixed(1).replace('.', ',') : '"' + String(v).replace(/"/g, '""') + '"';
    baixar('visioindustria_desempenho.csv', '﻿hora;ciclo;resultado;erro;inferencia_coco_ssd_ms;ciclo_total_ms;modelo_base;fps_camera;codigo_erro\n' + perfRows.map(r => r.map(f).join(';')).join('\n'));
  };

  // ---------- Orientação: estado, lados e avaliação de passagem ----------
  let ultimaEscolha = null, aquecimento = 0, facing = '', segAtual = null, segReg = null, profAtual = null, avisouNenhum = false, candCiclos = 0, ultimaDecisao = null, ultimaPassagem = null;
  const estabAlt = criarEstabilizadorAlt();
  const ladosAtual = () => resolverLados($('lados').value || 'auto', facing);
  const modoAtual = () => $('modo').value === 'pista' ? 'pista' : 'padrao';
  function atualizarModo(){ $('avisoPista').hidden = modoAtual() !== 'pista'; ultimaEscolha = null; tracks.clear(); estabAlt.reset(); aquecimento = 0; }
  function atualizarLados(){
    const l = ladosAtual(), r = rotulosLados(l.invertido);
    $('rotE').textContent = r[0]; $('rotD').textContent = r[1];
    $('oLados').textContent = (l.invertido ? 'invertidos' : 'normais') + ' (' + l.motivo + ')' + (ladosConfirmados($('lados').value || 'auto', facing) ? '' : ' — NÃO confirmados: escolha "Normal" ou "Invertido" para liberar alternativas laterais');
    tracks.clear(); estabAlt.reset(); aquecimento = 0; ultimaEscolha = null;
  }
  // Entrada para modelos externos (segmentação semântica e profundidade ainda NÃO implementadas). Se um deles fornecer dados, tem precedência
  // sobre a heurística de cor do piso.
  // Entrada validada (validarFonteExterna): exige estado 'ok', origem, tCaptura (mesmo relógio, performance.now()) e resultado completo. O que faltar vira
  // 'incompleto' e a fonte NÃO é combinada com a detecção. A idade conta a partir da CAPTURA, não do recebimento. null remove a fonte.
  function receberSegmentacao(d){ segAtual = d ? Object.assign({}, validarFonteExterna(d), {recebidoEm: performance.now()}) : null; }
  function receberProfundidade(d){ profAtual = d ? Object.assign({}, validarFonteExterna(d), {recebidoEm: performance.now()}) : null; }
  // Estado de cada fonte, sem fingir o que não existe: não há modelo de segmentação semântica nem de profundidade integrado.
  function estadoFontes(){
    const fx = (x, vazio) => x ? {estado:x.estado, origem:x.origem, motivo:x.motivo, tCaptura:x.tCaptura} : {estado:'indisponivel', motivo:vazio};
    return {deteccao:{estado:modeloEstado, modelo:modeloAtual || null},
      segmentacao: Object.assign(fx(segAtual, segReg ? 'segmentador registrado, ainda sem resultado' : 'nenhum modelo de segmentação semântica integrado'), {registrado: !!segReg}), profundidade: fx(profAtual, 'nenhum modelo de profundidade integrado'),
      pisoPorCor:{estado: modoAtual() === 'padrao' && $('passagem').value === 'ligada' ? 'heuristica_experimental_ligada' : 'desligada_ou_nao_usada', metodo:'heuristica_cor_piso'}};
  }
  // Captura local de um quadro reduzido (64×48) só na memória, para a heurística de piso. Nada é salvo nem enviado.
  const capC = document.createElement('canvas'); capC.width = 64; capC.height = 48;
  const capX = capC.getContext ? capC.getContext('2d', {willReadFrequently:true}) : null;
  // Nunca lança: uma falha de captura não pode derrubar a inferência do ciclo; vira {erro} e a passagem fica 'falha' (indeterminada).
  function capturarQuadro(){ try{ capX.drawImage(video, 0, 0, 64, 48); const id = capX.getImageData(0, 0, 64, 48); return {data:id.data, w:64, h:48}; }catch(err){ return {erro: err.message || 'falha na captura'}; } }
  // Os pixels (img) são do MESMO instante tCap das caixas (ver tarefa 'coco-ssd'); W e H são as dimensões desse quadro.
  function medirPassagem(preds, W, H, inv, img, tCap, quadroId){
    const meta = {origem:'heuristica_cor_piso', tCaptura:tCap, quadroId};
    if (!img || img.erro) return Object.assign({estado:'falha', motivo: (img && img.erro) || 'quadro não capturado'}, meta);
    try{
      const caixas = preds.filter(p => p.score >= .3).map(p => ({x:p.bbox[0]/W, y:p.bbox[1]/H, w:p.bbox[2]/W, h:p.bbox[3]/H}));   // qualquer objeto detectado invalida o piso sob ele
      return Object.assign(avaliarPassagemPorCor(img, caixas, inv), meta);
    }catch(err){ return Object.assign({estado:'falha', motivo:err.message}, meta); }
  }
  // Ponto de integração de um segmentador (NENHUM é incluído nesta versão).
  //   c = {origem, executar(video) → {mascara, w, h}, rotulos:{piso:[ids], ignorado?}, confianca, nome?, pronto?(), cadaN?, prio?, timeoutMs?}
  // - Roda como tarefa OPCIONAL do agendador, por padrão ANTES do COCO-SSD no mesmo ciclo, para o instante de captura ficar próximo ao da detecção.
  //   Com cadaN > 1 o resultado é reaproveitado nos ciclos seguintes e a verificação de compatibilidade o rejeita quando passa de LIM.compatMaxMs.
  // - `confianca` é obrigatória: calibração de campo (ver regioesDeMascara). Sem validação em campo, use 0: a segmentação nunca autoriza alternativa.
  // - Qualquer falha ou demora do segmentador vira resultado 'falha'/'inferencia_expirada' DELE; não derruba os alertas de obstáculo. Não há "fallback"
  //   silencioso para a heurística de cor. timeoutMs (padrão 2000, PROVISÓRIO) não cancela a inferência: só deixa de esperá-la.
  function registrarSegmentador(c){
    if (segReg) throw new Error('já existe um segmentador registrado');
    if (!c || typeof c.executar !== 'function' || !c.origem || !c.rotulos || !Array.isArray(c.rotulos.piso) || !c.rotulos.piso.length || !Number.isFinite(c.confianca))
      throw new Error('segmentador inválido: exige executar, origem, rotulos.piso (ids) e confianca (calibração de campo; use 0 se não houver)');
    segReg = {origem: c.origem, nome: c.nome || c.origem};
    const tmo = c.timeoutMs > 0 ? c.timeoutMs : 2000;
    agendador.registrar({nome:'segmentacao', prio: Number.isFinite(c.prio) ? c.prio : 5, cadaN: c.cadaN > 1 ? c.cadaN : 1, opcional:true, pronto: () => !c.pronto || !!c.pronto(),
      executar: async () => {
        const tCaptura = performance.now(), inv = ladosAtual().invertido; let tid;
        try{
          const m = await Promise.race([Promise.resolve(c.executar(video)), new Promise((_, rej) => { tid = setTimeout(() => rej(Object.assign(new Error('segmentação excedeu ' + tmo + ' ms'), {expirado:true})), tmo); })]);
          return Object.assign(regioesDeMascara(m, {piso:c.rotulos.piso, ignorado:c.rotulos.ignorado, invertido:inv, confianca:c.confianca}), {origem:c.origem, tCaptura, tConclusao:performance.now()});
        }catch(err){ return {estado: err && err.expirado ? 'inferencia_expirada' : 'falha', motivo: (err && err.message) || 'falha na segmentação', origem:c.origem, tCaptura}; }
        finally{ clearTimeout(tid); }
      },
      aoConcluir: r => { segAtual = Object.assign(validarFonteExterna(r), {recebidoEm: performance.now()}); }
    });
  }
  const pct = v => v == null ? '–' : Math.round(v*100) + '%';
  function resumoPassagem(sg){
    if (!sg) return 'desligada';
    if (sg.estado !== 'ok') return sg.estado + (sg.motivo ? ' (' + sg.motivo + ')' : '');
    return ['esquerda','frente','direita'].map(z => z[0].toUpperCase() + ' ' + pct(sg.regioes[z].livre) + '/' + pct(sg.regioes[z].continuidade) + '/' + pct(sg.regioes[z].larguraRel)).join(' · ') + ' (livre/contín./largura)';
  }
  function mostrarOrientacao(dec){
    ultimaDecisao = dec;
    $('oDec').textContent = dec.decisao + (dec.evidencias.modo === 'pista_controlada' ? ' [pista experimental]' : '');
    $('oMot').textContent = dec.motivos.join('; ') || '–'; $('oLim').textContent = dec.limitacoes.join('; ') || '–';
    $('oFontes').textContent = 'detecção ' + dec.fontes.deteccao.estado + ' · passagem ' + dec.fontes.segmentacao.estado + ' · profundidade ' + dec.fontes.profundidade.estado;
    $('oReg').textContent = ZONAS.map(z => z[0].toUpperCase() + ': ' + dec.regioes[z].replace(/_/g, ' ')).join(' · ');
    $('oSeg').textContent = dec.evidencias.modo === 'pista_controlada' ? 'não usada no modo pista' : (segAtual || profAtual ? 'dados externos recebidos' : resumoPassagem(ultimaPassagem));
    atualizarEstado();
  }
  window.VisioIndustria = {receberSegmentacao, receberProfundidade, registrarSegmentador, regioesDeMascara, estadoFontes, configurarLimites, decisaoAtual: () => ultimaDecisao, estadoSessao: () => vida.estado()};

  let ultimaAss = '', ultimaUrg = '', ultimoFalado = -Infinity, vazio = 0;   // -Infinity: nada foi falado ainda (independe da origem do relógio)
  function falarOrientacao(plano, texto, urgente, agora, tCap, nomes, decisao){
    if (!falar(texto, urgente)) return false;
    ultimaAss = plano.ass; ultimaUrg = plano.urg; ultimoFalado = agora;
    const lat = performance.now() - tCap;
    metrics.alertas++; $('mAl').textContent = metrics.alertas; $('mLat').textContent = lat.toFixed(0) + ' ms';
    metrics.rows.push([new Date().toISOString(), nomes, lat.toFixed(0), texto, decisao]);
    if (metrics.rows.length > 5000) metrics.rows.shift();
    log(texto);
    if (urgente) bipe(660, 100);
    return true;
  }
  // Devolve as predições VÁLIDAS do ciclo (para desenhar) ou null quando o resultado não pode ser usado.
  function analisar(r){
    if (!ativo()) return null;                                       // defesa em profundidade: o agendador já descarta gerações antigas
    const {tCap, W, H, quadroId, img} = r;                           // W/H são do quadro analisado, não do vídeo no momento do alerta
    const c = cfg(), agora = performance.now(), inv = ladosAtual().invertido, modo = modoAtual();
    const lados = {confirmado: ladosConfirmados($('lados').value || 'auto', facing)};
    const meta = {origem:'coco-ssd', quadroId, tCaptura:tCap, tConclusao:r.tConclusao};
    const v = validarPredicoes(r.preds, W, H);
    // Resultado inválido do modelo, vídeo sem dimensões ou predição malformada: o resultado inteiro é suspeito e não orienta nada.
    if (!Array.isArray(r.preds) || !(W > 0) || !(H > 0) || v.descartadas){
      estabAlt.reset(); ultimaPassagem = null; const dec = decidirOrientacao({modo, agora, lados, deteccao:Object.assign({estado:'incompleto', motivo: v.motivo}, meta)});
      mostrarOrientacao(dec); const pl = planejarSemObjetos(dec);
      if (pl.ass !== ultimaAss && agora - ultimoFalado >= 1500) falarOrientacao(pl, pl.texto, false, agora, tCap, 'análise incompleta', dec.decisao);
      return null;
    }
    const preds = v.validas;
    const grupos = new Map(), candidatos = [];
    for (const p of preds){
      const info = CLASSES[p.class]; if (!info) continue;
      const z = zonaDe(p.bbox, W, inv), area = p.bbox[2]*p.bbox[3]/(W*H);
      if (p.score < limiar(info, c.conf)){ if (area >= LIM.candAreaMin) candidatos.push({z, area, nome:info.s}); continue; }
      const k = info.s+'|'+z, g = grupos.get(k) || {cls:p.class, info, z, n:0, area:0};
      g.n++; g.area = Math.max(g.area, area); grupos.set(k, g);     // todas as detecções entram, não só a de maior prioridade
    }
    aquecimento++;
    const estaveis = atualizarTracks(tracks, grupos, c.persist);
    const pendentes = [...grupos.values()].filter(g => !estaveis.some(t => t.info.s === g.info.s && t.z === g.z)).map(g => ({z:g.z, nome:g.info.s}));
    candCiclos = candidatos.length ? candCiclos + 1 : 0;           // baixa confiança só conta se persistir (evita piscar)
    let seg = null;                                                 // modo padrão: modelo externo tem precedência; senão, a heurística de piso. No modo pista, não é usada.
    if (modo === 'padrao'){ seg = segAtual || (img !== undefined ? medirPassagem(preds, W, H, inv, img, tCap, quadroId) : null); }
    ultimaPassagem = seg;
    const dec = decidirOrientacao({modo, agora, lados, ultimaEscolha, grupos: estaveis, pendentes, candidatos: candCiclos >= c.persist ? candidatos : [], deteccao:Object.assign({estado:'ok'}, meta), seg, prof: profAtual, estab: estabAlt});
    mostrarOrientacao(dec); if (dec.escolha) ultimaEscolha = dec.escolha;
    if (estaveis.length || dec.decisao === 'analise_insuficiente') { vazio = 0; avisouNenhum = false; }
    else {
      // Sem objeto: silêncio, exceto UM aviso quando os objetos somem. Nunca é "caminho livre", e o texto diz isso.
      if (++vazio > 8){
        if (ultimaAss !== '' && !avisouNenhum){ const pl = planejarSemObjetos(dec); if (falar(pl.texto, false)){ avisouNenhum = true; log(pl.texto); ultimaAss = ''; ultimaUrg = ''; } }
        else { ultimaAss = ''; ultimaUrg = ''; }
      }
      return preds;
    }
    const plano = estaveis.length ? planejar(estaveis, dec) : planejarSemObjetos(dec), mudou = plano.ass !== ultimaAss;
    if (modo === 'padrao' && aquecimento < LIM.kOn && !plano.urgente) return preds;                // o estabilizador de passagens ainda está confirmando: não fala "sem passagem" cedo demais (alerta urgente não espera)
    if (!mudou && agora - ultimoFalado < c.cool*2){ metrics.supr++; $('mSup').textContent = metrics.supr; return preds; }
    const urgente = plano.urgente && plano.urg !== ultimaUrg;                 // só interrompe a fala quando surge um novo item urgente
    if (mudou && !urgente && agora - ultimoFalado < 1500) return preds;       // evita metralhar mensagens; tenta de novo no próximo ciclo
    const nomes = estaveis.length ? estaveis.map(g => g.info.s+' x'+g.n+' '+g.z).join(' + ') : dec.decisao;
    falarOrientacao(plano, mudou ? plano.texto : plano.curto, urgente, agora, tCap, nomes, dec.decisao);   // repetição por tempo: só o obstáculo
    return preds;
  }

  // Barras na base da imagem, nas posições da IMAGEM: vermelho = obstruída, verde = passagem validada, cinza = não confirmada.
  function barrasRegioes(){
    const d = ultimaDecisao; if (!d || !canvas.width) return;
    const inv = ladosAtual().invertido, bw = canvas.width/3, hh = Math.max(8, canvas.height*.02);
    ['esquerda','frente','direita'].forEach((raw, b) => {
      const z = ladoUsuario(raw, inv);
      ctx.fillStyle = d.bloqueadas.includes(z) ? '#ff5a5a' : (d.passagens.includes(z) ? '#3ddc84' : '#8a8f94');
      ctx.fillRect(b*bw + 4, canvas.height - hh - 2, bw - 8, hh);
    });
  }
  // `preds` já validadas e recortadas ao quadro (validarPredicoes). O rótulo é desenhado no canvas, nunca inserido no DOM.
  function desenhar(preds){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!Array.isArray(preds)) return;
    barrasRegioes();
    ctx.lineWidth = 3; ctx.font = '600 16px system-ui'; const c = cfg();
    for (const p of preds){
      const info = CLASSES[p.class]; if (!info || p.score < limiar(info, c.conf)) continue;
      const [x,y,w,h] = p.bbox;
      ctx.strokeStyle = info.prio >= 3 ? '#ff5a5a' : '#ffc14d'; ctx.strokeRect(x,y,w,h);
      const rot = info.s + ' ' + Math.round(p.score*100) + '%', ty = y >= 22 ? y - 22 : y;   // rótulo dentro do quadro quando a caixa encosta no topo
      ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(x, ty, ctx.measureText(rot).width + 10, 22);
      ctx.fillStyle = '#000'; ctx.fillText(rot, x+5, ty+17);
    }
  }

  // ---------- Registro / métricas ----------
  function log(t){
    const li = document.createElement('li'); li.textContent = new Date().toLocaleTimeString('pt-BR') + ' — ' + t;
    $('log').prepend(li); while ($('log').children.length > 50) $('log').lastChild.remove();
  }
  $('btnCsv').onclick = () => {
    const cel = v => '"' + String(v).replace(/"/g, '""') + '"';
    baixar('visioindustria_metricas.csv', '﻿hora;objetos_e_zonas;latencia_ms;mensagem;decisao\n' + metrics.rows.map(r => r.map(cel).join(';')).join('\n'));
  };

  // ---------- Controles ----------
  $('btnIniciar').onclick = iniciar;
  $('btnPausar').onclick = () => vida.estado() === 'pausado' ? retomar() : pausar();
  $('btnEncerrar').onclick = encerrar;
  $('btnTeste').onclick = () => {
    prepararAudio(); const tocou = bipe();
    if (!temVoz()) return status('Síntese de voz indisponível neste navegador: os avisos não podem ser falados.' + (tocou ? ' O bipe funciona.' : ''));
    falar('Teste de áudio. Atenção: possível obstáculo à frente.', true);
  };
  // Atalhos: Espaço inicia, pausa ou retoma; Esc encerra (ou cancela o início). Ignorados enquanto o foco está num controle de formulário,
  // e Espaço também sobre um botão (ali ele já aciona o próprio botão; tratar os dois duplicaria a ação).
  const CAMPOS = new Set(['SELECT', 'INPUT', 'TEXTAREA', 'OPTION']);
  document.addEventListener('keydown', e => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target || {}, tag = t.tagName;
    if (CAMPOS.has(tag) || t.isContentEditable) return;
    if (e.code === 'Space'){ if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A') return; e.preventDefault(); iniciar(); }
    else if (e.code === 'Escape') encerrar();
  });
  // Página em segundo plano (aba trocada, tela bloqueada): o navegador pode congelar a câmera e os timers. Pausa e exige retomada explícita,
  // que descarta as evidências anteriores.
  document.addEventListener('visibilitychange', () => { if (document.hidden && ativo()) pausar('página em segundo plano'); });
  video.addEventListener('resize', () => { if (video.videoWidth > 0 && video.videoHeight > 0){ canvas.width = video.videoWidth; canvas.height = video.videoHeight; } });   // rotação do aparelho
  $('lados').addEventListener('change', atualizarLados); atualizarLados();
  $('modo').addEventListener('change', atualizarModo); atualizarModo();
  if (typeof cocoSsd === 'undefined' || typeof tf === 'undefined') { const r = $('avisoRede'); if (r) r.hidden = false; }
  atualizarControles(); atualizarEstado(); atualizarPainel();
})();
