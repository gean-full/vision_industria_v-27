'use strict';
/*
 * VisioIndústria: núcleo de lógica PURA (sem câmera, DOM, fala nem relógio global).
 *  - CLASSES: classes monitoradas do COCO-SSD e como são faladas;
 *  - AGENDADOR: cadeia única de ciclos de inferência, sem sobreposição, com watchdog e métricas medidas;
 *  - PERCEPCAO: contrato e validade temporal das fontes (detecção, segmentação, profundidade);
 *  - PLANEJADOR: decisão de orientação, estabilização e texto falado;
 *  - VALIDACAO DO MODELO: só predições bem formadas entram na decisão;
 *  - CICLO DE VIDA: estados da sessão e transições permitidas.
 * Cada chamada de criarNucleoVisio() devolve uma instância nova e independente (os limites em LIM são por instância).
 * No navegador o arquivo é um script clássico que publica window.VisioNucleo; no Node (testes) exporta criarNucleoVisio.
 */
function criarNucleoVisio(){
  // ==== CLASSES ====
  // s/p = singular/plural, g = gênero, prio = relevância como obstáculo,
  // off = ajuste do limiar para a classe (cadeira/mesa são mais difíceis para o modelo; a persistência em quadros compensa).
  const CLASSES = {
    person:{s:'pessoa',p:'pessoas',g:'f',prio:3,off:0},
    truck:{s:'veículo',p:'veículos',g:'m',prio:3,off:0}, car:{s:'veículo',p:'veículos',g:'m',prio:3,off:0},
    bus:{s:'veículo',p:'veículos',g:'m',prio:3,off:0}, motorcycle:{s:'moto',p:'motos',g:'f',prio:3,off:0},
    bicycle:{s:'bicicleta',p:'bicicletas',g:'f',prio:2,off:0},
    chair:{s:'cadeira',p:'cadeiras',g:'f',prio:2,off:-.15},
    'dining table':{s:'mesa',p:'mesas',g:'f',prio:2,off:-.15},
    bench:{s:'banco',p:'bancos',g:'m',prio:2,off:-.1}, couch:{s:'sofá',p:'sofás',g:'m',prio:2,off:-.1},
    bed:{s:'cama',p:'camas',g:'f',prio:2,off:-.1},
    suitcase:{s:'caixa ou mala',p:'caixas ou malas',g:'f',prio:2,off:0},
    backpack:{s:'volume',p:'volumes',g:'m',prio:1,off:0},
    refrigerator:{s:'equipamento grande',p:'equipamentos grandes',g:'m',prio:2,off:0},
    tv:{s:'equipamento',p:'equipamentos',g:'m',prio:1,off:0}, 'potted plant':{s:'planta',p:'plantas',g:'f',prio:1,off:0}
  };
  // LIMITE DO MODELO: o COCO-SSD (80 classes) NÃO tem "parede" nem "porta" (nem palete/carrinho).
  // Baixar o limiar não cria classes que o modelo nunca aprendeu. Ver aviso no painel e no resumo.
  // ==== FIM CLASSES ====

  // ==== AGENDADOR ====
  // Uma única cadeia de ciclos. Dentro de cada ciclo as tarefas (modelos) rodam EM SEQUÊNCIA, nunca em paralelo.
  // Trabalho atrasado não se acumula: o próximo ciclo só é agendado quando o atual termina.
  // Tarefas: {nome, prio (menor roda antes), cadaN (roda a cada N ciclos), opcional (adiada se o aparelho está lento),
  //           pronto(), executar(ctx) → resultado, aoConcluir(resultado, ctx)}
  // Opções: now, setTimer, clearTimer, intervalo(), verificar() → {ok}|{ignorar:motivo}|{erro:msg}, aoErro(e), aoCiclo(rec),
  //         folgaMin, folgaIgnorado, stallMs, watchdogMs, setWatch/clearWatch (opcionais).
  function criarAgendador(o){
    const now = o.now, JAN = 5000, N = 120, FOLGA = o.folgaMin ?? 30, FOLGA_IGN = o.folgaIgnorado ?? 20,
          STALL = o.stallMs ?? 2500, WATCHDOG = o.watchdogMs ?? 15000;
    const setW = o.setWatch || o.setTimer, clrW = o.clearWatch || o.clearTimer;
    const tarefas = [];
    let gen = 0, curso = 0, ativo = false, pausado = false, emCurso = false, timer = null, n = 0;
    let inicioJanela = 0, semQuadroDesde = null, ultimoCicloMs = 0, st, cicloMs, fim;
    const ring = (a, v, max = N) => { a.push(v); if (a.length > max) a.shift(); };
    const resumo = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y);
      return {n:a.length, ultimo:a[a.length-1], media:a.reduce((x, y) => x + y, 0) / a.length, p95:s[Math.max(0, Math.ceil(.95*s.length) - 1)]}; };
    const seguro = (f, a) => { try { if (f) f(a); } catch (e) { /* um callback do app não pode derrubar o agendador */ } };
    const ignorar = m => { st.ignorados++; st.motivos[m] = (st.motivos[m] || 0) + 1; };
    // Cada falha carrega um CÓDIGO que separa causas diferentes: falha_inferencia, inferencia_expirada (watchdog), camera_indisponivel,
    // sem_quadros_novos e falha_callback (erro no código do app que trata o resultado). A mensagem original é preservada.
    const comCodigo = (e, c) => { if (e && typeof e === 'object' && !e.codigo) e.codigo = c; return e; };
    const contar = e => { const c = (e && e.codigo) || 'falha_tarefa'; st.errosPorCodigo[c] = (st.errosPorCodigo[c] || 0) + 1; };
    function zerar(){
      st = {concluidos:0, ignorados:0, erros:0, descartados:0, acimaIntervalo:0, motivos:{}, errosPorCodigo:{}}; cicloMs = []; fim = []; n = 0; ultimoCicloMs = 0;
      for (const t of tarefas) t.stat = {amostras:[], adiadas:0, indisponivel:0};
    }
    zerar();
    function reagendar(g, ms){ if (g === gen && ativo && !pausado) timer = o.setTimer(() => ciclo(g), ms); }
    function recomecar(){ const g = ++gen; o.clearTimer(timer); inicioJanela = now(); fim = []; semQuadroDesde = null; ciclo(g); }
    // Inferência que nunca retorna: abandona o ciclo, conta erro, invalida a geração antiga e recomeça.
    // Se o watchdog dispara com a assistência pausada ou encerrada, só libera o ciclo: nada para alarmar na sessão atual.
    function abandonar(meu){
      if (curso !== meu || !emCurso) return;
      emCurso = false; curso++;
      if (!ativo || pausado) return;
      const g = ++gen, e = comCodigo(new Error('Inferência travada: ciclo abandonado.'), 'inferencia_expirada');
      st.erros++; contar(e); seguro(o.aoErro, e);
      ciclo(g);
    }
    async function ciclo(g){
      if (g !== gen || !ativo || pausado) return;
      if (emCurso){ ignorar('ciclo_anterior_em_curso'); return reagendar(g, FOLGA_IGN); }
      emCurso = true; const meu = ++curso, t0 = now(), numero = ++n, tempos = {};
      let resultado = 'ok', erro = null, espera = null, executou = false;
      const wd = setW(() => abandonar(meu), WATCHDOG);
      try{
        const v = o.verificar ? o.verificar() : {};
        if (v.erro) throw comCodigo(new Error(v.erro), v.codigo || 'camera_indisponivel');
        if (v.ignorar){
          if (semQuadroDesde === null) semQuadroDesde = t0;
          if (t0 - semQuadroDesde > STALL) throw comCodigo(new Error('Sem quadros novos da câmera.'), 'sem_quadros_novos');
          ignorar(v.ignorar); resultado = 'ignorado'; espera = FOLGA_IGN; n--;
        } else {
          semQuadroDesde = null;
          for (const t of tarefas){
            if (t.cadaN > 1 && numero % t.cadaN !== 0) continue;
            if (!t.pronto()){ t.stat.indisponivel++; continue; }
            if (t.opcional && ultimoCicloMs > o.intervalo() * 1.5){ t.stat.adiadas++; continue; }
            const a = now(); let r; try { r = await t.executar({ciclo:numero}); } catch (e) { throw comCodigo(e, 'falha_inferencia'); } const dt = now() - a;
            if (g !== gen){ st.descartados++; resultado = 'descartado'; break; }     // pausa/encerramento durante a inferência: resultado obsoleto
            tempos[t.nome] = dt; ring(t.stat.amostras, dt); executou = true;
            if (t.aoConcluir){ try { t.aoConcluir(r, {ciclo:numero, ms:dt}); } catch (e) { throw comCodigo(e, 'falha_callback'); } }
          }
          if (resultado === 'ok' && !executou){ ignorar('nenhuma_tarefa_pronta'); resultado = 'ignorado'; espera = FOLGA_IGN; n--; }
        }
      }catch(e){
        if (curso === meu){
          // Falha de uma geração já encerrada (pausa/encerramento durante a inferência): é resultado obsoleto, não erro da sessão atual.
          if (g !== gen){ st.descartados++; resultado = 'descartado'; }
          else { resultado = 'erro'; erro = e; st.erros++; contar(e); seguro(o.aoErro, e); }
        }
      }finally{
        clrW(wd);
        if (curso !== meu) return;                          // ciclo já abandonado pelo watchdog: não mexe em mais nada
        emCurso = false;
        const total = now() - t0;
        if (resultado === 'ok'){ st.concluidos++; ring(cicloMs, total); ultimoCicloMs = total; ring(fim, now(), 400); if (total > o.intervalo()) st.acimaIntervalo++; }
        else if (resultado === 'erro') ultimoCicloMs = total;
        if (resultado === 'ok' || resultado === 'erro') seguro(o.aoCiclo, {ciclo:numero, resultado, erro:erro && erro.message, codigo:erro && erro.codigo, tempos, totalMs:total});
        reagendar(g, espera ?? Math.max(FOLGA, o.intervalo() - total));
      }
    }
    return {
      registrar(t){ tarefas.push(Object.assign({prio:0, cadaN:1, opcional:false, pronto:() => true}, t, {stat:{amostras:[], adiadas:0, indisponivel:0}})); tarefas.sort((x, y) => x.prio - y.prio); },
      iniciar(){ zerar(); ativo = true; pausado = false; recomecar(); },
      pausar(){ pausado = true; gen++; o.clearTimer(timer); timer = null; },
      retomar(){ if (!ativo) return; pausado = false; recomecar(); },
      parar(){ ativo = false; pausado = false; gen++; o.clearTimer(timer); timer = null; },
      estado(){ return {ativo, pausado, emCurso, geracao:gen}; },
      snapshot(t = now()){
        const janela = Math.min(JAN, t - inicioJanela), c = fim.filter(x => x > t - JAN).length, por = {};
        for (const x of tarefas) por[x.nome] = Object.assign({n:0}, resumo(x.stat.amostras), {adiadas:x.stat.adiadas, indisponivel:x.stat.indisponivel});
        return Object.assign({ativo, pausado, emCurso, fpsEfetivo:(ativo && !pausado && janela >= 1000) ? c / (janela/1000) : null, ciclo:resumo(cicloMs), tarefas:por}, st, {motivos:{...st.motivos}, errosPorCodigo:{...st.errosPorCodigo}, expirados:st.errosPorCodigo.inferencia_expirada || 0});
      }
    };
  }
  // ==== FIM AGENDADOR ====

  // ==== PERCEPCAO ====
  // Contrato e validade temporal dos resultados das fontes de percepção (detecção, segmentação, profundidade).
  // Funções PURAS: sem câmera, DOM, fala nem relógio global (o instante atual entra como argumento `agora`).
  // Uma fonte entrega: {estado, origem, quadroId, tCaptura, tConclusao, completo, motivo, ...dados}
  //   estado: 'ok' | 'carregando' | 'pronto' | 'analisando' | 'falha_carregamento' | 'inferencia_expirada' | 'camera_indisponivel'
  //         | 'incompleto' | 'desatualizado' | 'incompativel' | 'indisponivel' | 'falha'
  //   tCaptura: instante (ms, mesmo relógio da detecção) em que o QUADRO analisado foi capturado. Sem ele não há como saber se dois resultados
  //             descrevem a mesma cena, então a fonte NÃO é combinada com a detecção (nunca se presume que sejam compatíveis).
  //   quadroId: identificador do quadro de origem quando o navegador o fornece (contador do requestVideoFrameCallback); null = desconhecido.
  // Idade = agora - tCaptura (ou idadeMs, se o chamador já a calculou). Idade DESCONHECIDA ou negativa nunca é tratada como "recente".
  function idadeDe(f, agora){
    if (!f) return null;
    const i = Number.isFinite(f.idadeMs) ? f.idadeMs : (Number.isFinite(f.tCaptura) && Number.isFinite(agora) ? agora - f.tCaptura : null);
    return i !== null && i >= 0 ? i : null;
  }
  // Duas fontes só podem ser combinadas se os quadros de origem foram capturados com diferença de no máximo maxMs.
  function compativel(a, b, maxMs){
    if (!a || !b || !Number.isFinite(a.tCaptura) || !Number.isFinite(b.tCaptura)) return {ok:false, motivo:'sem instante de captura em uma das fontes: compatibilidade temporal não verificável'};
    const delta = Math.abs(a.tCaptura - b.tCaptura);
    return delta <= maxMs ? {ok:true, deltaMs:delta} : {ok:false, deltaMs:delta, motivo:'quadros de origem diferentes demais (' + Math.round(delta) + ' ms; máximo ' + maxMs + ' ms)'};
  }
  // Porta de entrada de modelos EXTERNOS (segmentação, profundidade): exige estado 'ok' explícito, origem, instante de captura e resultado completo.
  // O que faltar vira estado 'incompleto' com o motivo; falhas informadas pela própria fonte seguem como estão.
  function validarFonteExterna(d){
    if (!d || typeof d !== 'object') return {estado:'incompleto', motivo:'resultado inválido'};
    if (d.estado !== 'ok') return Object.assign({}, d, {estado: d.estado || 'incompleto', motivo: d.motivo || 'fonte sem estado ok'});
    if (d.completo === false) return Object.assign({}, d, {estado:'incompleto', motivo: d.motivo || 'resultado marcado como incompleto pela fonte'});
    if (!d.origem) return Object.assign({}, d, {estado:'incompleto', motivo:'sem origem (modelo ou método) informada'});
    if (!Number.isFinite(d.tCaptura)) return Object.assign({}, d, {estado:'incompleto', motivo:'sem instante de captura (tCaptura): não é possível verificar a compatibilidade com a detecção'});
    return Object.assign({}, d);
  }
  // Os lados (esquerda/direita) só têm correspondência física confirmada se o usuário os escolheu ou se o navegador informou qual câmera é (frontal/traseira).
  // Com seleção automática e câmera desconhecida o app apenas PRESUME câmera voltada para a frente: o centro vale, mas nenhuma alternativa lateral é indicada.
  const ladosConfirmados = (sel, facing) => sel !== 'auto' || facing === 'user' || facing === 'environment';
  // Estado único da análise para o painel (derivado; não decide nada).
  // `vida` (opcional) é o estado do ciclo de vida; quando informado, as falhas de início e a perda da câmera têm precedência.
  function estadoAnalise({modeloEstado, running, paused, emCurso, ultimoErro, vida}){
    if (vida === 'solicitando_camera') return 'aguardando_camera';
    if (vida === 'camera_indisponivel') return 'camera_indisponivel';
    if (modeloEstado === 'carregando') return 'carregando_modelo';
    if (modeloEstado === 'erro') return 'falha_carregamento';
    if (!running) return modeloEstado === 'pronto' ? 'pronto' : 'parado';
    if (paused) return 'pausado';
    if (ultimoErro === 'camera_indisponivel' || ultimoErro === 'sem_quadros_novos') return 'camera_indisponivel';
    if (ultimoErro === 'inferencia_expirada') return 'inferencia_expirada';
    if (ultimoErro) return 'falha_na_analise';
    return emCurso ? 'analisando' : 'pronto';
  }
  // Converte uma MÁSCARA de classes (um id por pixel, na orientação BRUTA da imagem) no formato `seg` que o motor de decisão já consome.
  //   m = {mascara, w, h};  opc = {piso:[ids de chão transitável], ignorado:255, invertido, confianca, topo:.5, corridaMin:.6}
  // Só as classes de `piso` contam como livres: parede, porta, escada, objetos e qualquer classe desconhecida contam como NÃO livres (conservador).
  // Pixels `ignorado` também não são livres e reduzem `cobertura`. Mesma análise da heurística de cor (terços da imagem, metade inferior, corrida contínua a partir
  // da base), mas SEM referência de cor: depende só do que o modelo classificou.
  // `confianca` é uma CALIBRAÇÃO DE CAMPO informada por quem integra o modelo; a máscara não traz confiança por pixel. Sem ela (0) a decisão trata a região como
  // "baixa confiança" (desconhecida): uma segmentação sem validação em campo nunca autoriza alternativa. Limitada a 0,9, como a heurística.
  function regioesDeMascara(m, opc = {}){
    const {mascara, w, h} = m || {}, piso = new Set(opc.piso || []), ign = opc.ignorado ?? 255, topo = opc.topo ?? .5, corrida = opc.corridaMin ?? .6;
    if (!mascara || !(w > 0) || !(h > 0) || mascara.length < w*h) return {estado:'incompleto', motivo:'máscara inválida ou de tamanho diferente de w×h'};
    if (!piso.size) return {estado:'incompleto', motivo:'nenhuma classe de piso informada'};
    const y0 = Math.floor(h*topo), alt = h - y0;
    if (!(alt >= 1)) return {estado:'incompleto', motivo:'região de análise vazia'};
    let validos = 0; for (let y = y0; y < h; y++) for (let x = 0; x < w; x++) if (mascara[y*w + x] !== ign) validos++;
    const conf = Math.max(0, Math.min(.9, Number.isFinite(opc.confianca) ? opc.confianca : 0)), bandas = ['esquerda','frente','direita'], regioes = {};
    for (let b = 0; b < 3; b++){
      const xa = Math.floor(b*w/3), xb = Math.floor((b+1)*w/3); let livres = 0, cel = 0; const boas = [];
      for (let x = xa; x < xb; x++){
        let run = 0; for (let y = h-1; y >= y0 && piso.has(mascara[y*w + x]); y--) run++;
        for (let y = y0; y < h; y++){ if (piso.has(mascara[y*w + x])) livres++; cel++; }
        boas.push(run/alt >= corrida);
      }
      let melhor = 0, atual = 0; for (const ok of boas){ atual = ok ? atual + 1 : 0; if (atual > melhor) melhor = atual; }
      regioes[ladoUsuario(bandas[b], !!opc.invertido)] = {livre: livres/cel, continuidade: boas.filter(Boolean).length/boas.length, larguraRel: melhor/boas.length, confianca: conf};
    }
    return {estado:'ok', metodo:'mascara_de_classes', cobertura: validos/(w*alt), regioes};
  }
  // ==== FIM PERCEPCAO ====

  // ==== PLANEJADOR ====
  const ZTXT = {esquerda:'à esquerda', frente:'à frente', direita:'à direita'};
  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const limiar = (info, conf) => clamp(conf + info.off, .3, .95);

  // ---- Lados: esquerda/direita são SEMPRE do ponto de vista de quem usa o equipamento. ----
  // A imagem bruta de uma câmera voltada para a frente tem esquerda = esquerda do usuário (o <video> aqui não tem espelhamento CSS,
  // então o que se vê na tela é o quadro bruto). Câmera frontal (facingMode "user") aponta para o usuário: o quadro bruto fica invertido.
  function resolverLados(sel, facing){
    if (sel === 'invertido') return {invertido:true,  motivo:'escolha do usuário'};
    if (sel === 'normal')    return {invertido:false, motivo:'escolha do usuário'};
    return facing === 'user' ? {invertido:true,  motivo:'câmera frontal detectada'}
                             : {invertido:false, motivo:facing ? 'câmera traseira' : 'câmera voltada para a frente (presumido)'};
  }
  const ladoUsuario = (z, inv) => (!inv || z === 'frente') ? z : (z === 'esquerda' ? 'direita' : 'esquerda');
  // Rótulos a desenhar sobre a imagem: [canto esquerdo da imagem, canto direito da imagem], já do ponto de vista do usuário.
  const rotulosLados = inv => inv ? ['direita', 'esquerda'] : ['esquerda', 'direita'];
  // Posição HORIZONTAL na imagem (não é distância). Objeto largo que cobre metade da faixa central conta como "à frente".
  function zonaDe(b, W, inv = false){
    const x1 = b[0]/W, x2 = (b[0]+b[2])/W, cx = (x1+x2)/2;
    const ov = Math.max(0, Math.min(x2,.66) - Math.max(x1,.33));
    const z = (ov >= .165 || (cx >= .33 && cx <= .66)) ? 'frente' : (cx < .33 ? 'esquerda' : 'direita');
    return ladoUsuario(z, inv);
  }

  // ---- Avaliação de passagem pela cor do piso: heurística REAL sobre os pixels, NÃO é segmentação semântica ----
  // Ideia: a faixa inferior central da imagem (onde costuma estar o piso à frente) vira referência de cor. Células parecidas com ela, fora das
  // caixas de objetos detectados, são "piso provável". Para cada região (esq./centro/dir.), na metade inferior da imagem, mede:
  //   livre        fração de piso provável;
  //   continuidade fração de colunas em que o piso provável se estende sem interrupção a partir da base (>= 60% da altura analisada);
  //   larguraRel   maior trecho contínuo dessas colunas, como fração da região (largura RELATIVA na imagem, NÃO metros).
  // LIMITES: parede ou objeto da mesma cor do piso parecem "livres"; piso manchado, faixa pintada ou sombra parecem "ocupados"; se a referência
  // estiver coberta por um objeto não detectado (palete, carrinho) o método erra sem saber. Não mede distância. Precisa de validação em campo.
  const PASS = {topo:.5, refL:[.82,.98], refC:[.4,.6], refUsoMin:.6, refStdMax:28, tolMin:30, tolK:3, lumMin:25, lumMax:235, corridaMin:.6, confMax:.9};
  // img = {data: RGBA, w, h}; caixas = [{x,y,w,h}] normalizadas (0..1) na orientação BRUTA da imagem; inv = lados do usuário invertidos em relação à imagem.
  function avaliarPassagemPorCor(img, caixas = [], inv = false){
    const {data, w, h} = img || {};
    if (!data || !(w > 0) || !(h > 0) || data.length < w*h*4) return {estado:'falha', motivo:'quadro inválido'};
    const ocup = new Uint8Array(w*h);
    for (const c of caixas){
      const x0 = Math.max(0, Math.floor(c.x*w)), x1 = Math.min(w, Math.ceil((c.x + c.w)*w)), y0 = Math.max(0, Math.floor(c.y*h)), y1 = Math.min(h, Math.ceil((c.y + c.h)*h));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ocup[y*w + x] = 1;
    }
    let soma = 0; for (let k = 0; k < w*h; k++) soma += .299*data[4*k] + .587*data[4*k+1] + .114*data[4*k+2];
    const lum = soma/(w*h);
    if (lum < PASS.lumMin || lum > PASS.lumMax) return {estado:'incompleto', motivo:'imagem muito escura ou muito clara'};
    const rx0 = Math.floor(PASS.refC[0]*w), rx1 = Math.ceil(PASS.refC[1]*w), ry0 = Math.floor(PASS.refL[0]*h), ry1 = Math.min(h, Math.ceil(PASS.refL[1]*h));
    let n = 0, tot = 0; const sm = [0,0,0], q = [0,0,0];
    for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++){
      tot++; if (ocup[y*w + x]) continue; n++;
      for (let ch = 0; ch < 3; ch++){ const v = data[4*(y*w + x) + ch]; sm[ch] += v; q[ch] += v*v; }
    }
    const uso = tot ? n/tot : 0;
    if (uso < PASS.refUsoMin) return {estado:'incompleto', motivo:'referência de piso coberta por objeto'};
    const m = sm.map(v => v/n), std = Math.sqrt(q.reduce((a, v, ch) => a + Math.max(0, v/n - m[ch]*m[ch]), 0)/3);
    if (std > PASS.refStdMax) return {estado:'incompleto', motivo:'referência de piso não homogênea'};
    const tol = Math.max(PASS.tolMin, PASS.tolK*std), piso = new Uint8Array(w*h);
    for (let k = 0; k < w*h; k++){
      if (ocup[k]) continue;
      if (Math.hypot(data[4*k] - m[0], data[4*k+1] - m[1], data[4*k+2] - m[2]) <= tol) piso[k] = 1;
    }
    const y0 = Math.floor(h*PASS.topo), alt = h - y0, conf = Math.min(PASS.confMax, (1 - .5*std/PASS.refStdMax)*uso);
    const bandas = ['esquerda','frente','direita'], regioes = {};
    for (let b = 0; b < 3; b++){
      const xa = Math.floor(b*w/3), xb = Math.floor((b+1)*w/3); let livres = 0, cel = 0; const boas = [];
      for (let x = xa; x < xb; x++){
        let run = 0; for (let y = h-1; y >= y0 && piso[y*w + x]; y--) run++;
        for (let y = y0; y < h; y++){ livres += piso[y*w + x]; cel++; }
        boas.push(run/alt >= PASS.corridaMin);
      }
      let melhor = 0, atual = 0; for (const ok of boas){ atual = ok ? atual + 1 : 0; if (atual > melhor) melhor = atual; }
      regioes[ladoUsuario(bandas[b], inv)] = {livre: livres/cel, continuidade: boas.filter(Boolean).length/boas.length, larguraRel: melhor/boas.length, confianca: conf};
    }
    return {estado:'ok', metodo:'heuristica_cor_piso', cobertura: uso, regioes, referencia:{rgb: m.map(Math.round), desvio: std, tolerancia: tol}};
  }

  // ---- Decisão de orientação: 3 regiões (esquerda, frente = centro, direita) ----
  // Região OBSTRUÍDA = há objeto reconhecido estável nela. Região com PASSAGEM VALIDADA = sem objeto, sem possível objeto de baixa confiança
  // e COM evidência positiva (livre, continuidade, largura, confiança, atualidade, compatibilidade com o quadro da detecção). Falta de caixas NÃO valida nada.
  // O contrato completo de entrada e saída está documentado em decidirOrientacao, mais abaixo. Uma segmentação semântica futura entra pelo mesmo
  // formato de `seg` (receberSegmentacao); profundidade relativa por `prof` (receberProfundidade).
  const ZONAS = ['esquerda','frente','direita'];
  // LIMITES PROVISÓRIOS: nenhum foi calibrado em aparelho real nem em cena industrial; não são valores universalmente seguros. São configuráveis
  // (configurarLimites) e devem ser recalibrados com as medições do painel. Justificativa de partida:
  //  - deteccaoIdadeMaxMs / segIdadeMaxMs / profIdadeMaxMs: idade máxima de um resultado; 1500 ms foi o valor herdado da etapa anterior (não medido).
  //  - compatMaxMs: diferença máxima entre os instantes de captura de duas fontes. A heurística de piso usa o MESMO quadro da inferência (diferença ~0).
  //    Um modelo futuro rodando em sequência captura DEPOIS do COCO-SSD, logo a diferença ≈ p95 da inferência medida no painel: se este limite for
  //    menor que isso, a fonte nunca será compatível e a decisão ficará indeterminada (comportamento seguro, porém inútil). 300 ms é só ponto de partida.
  const LIM = {segCobMin:.6, segConfMin:.6, segLivreMin:.6, segContMin:.6, segLargMin:.5, segIdadeMaxMs:1500, deteccaoIdadeMaxMs:1500, profIdadeMaxMs:1500, compatMaxMs:300, profProxMax:.7, margemEscolha:.2, candAreaMin:.04, kOn:3, kOff:3};
  // Atualiza limites conhecidos (exceto kOn/kOff, que só valem ao criar um estabilizador). Tudo ou nada: um valor inválido rejeita a chamada inteira.
  function configurarLimites(novos){
    const ent = Object.entries(novos || {}), ruins = ent.filter(([k, v]) => !(k in LIM) || k === 'kOn' || k === 'kOff' || !Number.isFinite(v) || v < 0).map(([k]) => k);
    if (!ent.length || ruins.length) return {aplicado:false, rejeitados: ruins, limites:{...LIM}};
    for (const [k, v] of ent) LIM[k] = v;
    return {aplicado:true, rejeitados:[], limites:{...LIM}};
  }
  const OPOSTO = {esquerda:'direita', direita:'esquerda'};
  function criarEstabilizadorAlt(kOn = LIM.kOn, kOff = LIM.kOff){
    const novo = () => ({on:false, a:0, b:0}), st = {esquerda:novo(), frente:novo(), direita:novo()};
    return {
      // brutas: zonas com passagem validada neste ciclo; imediatos: zonas que devem cair já (objeto detectado nelas)
      filtrar(brutas, imediatos = []){
        for (const z of ZONAS){
          const x = st[z];
          if (imediatos.includes(z)){ x.on = false; x.a = x.b = 0; }
          else if (brutas.includes(z)){ x.a++; x.b = 0; if (x.a >= kOn) x.on = true; }
          else { x.b++; x.a = 0; if (x.b >= kOff) x.on = false; }
        }
        return ZONAS.filter(z => st[z].on);
      },
      reset(){ for (const z of ZONAS) st[z] = novo(); }
    };
  }
  // Uma fonte de passagem/profundidade só é COMBINADA com a detecção atual se: estado ok, completa, idade conhecida e dentro do limite, e capturada
  // num instante compatível com o da detecção. Senão a decisão que dependeria dela fica indeterminada (nunca vira evidência positiva) e o motivo é registrado.
  function validarSeg(sg, det, agora){
    if (!sg) return {usavel:false, estado:'indisponivel', motivo:'sem avaliação de passagem: falta de caixas não prova espaço livre'};
    if (sg.estado !== 'ok') return {usavel:false, estado:sg.estado || 'indisponivel', motivo:'avaliação de passagem ' + (sg.estado || 'indisponível') + (sg.motivo ? ' (' + sg.motivo + ')' : '')};
    if (!(sg.cobertura >= LIM.segCobMin)) return {usavel:false, estado:'incompleto', motivo:'avaliação de passagem incompleta'};
    const idade = idadeDe(sg, agora);
    if (idade === null) return {usavel:false, estado:'incompleto', motivo:'avaliação de passagem sem referência temporal (idade desconhecida)'};
    if (!(idade <= LIM.segIdadeMaxMs)) return {usavel:false, estado:'desatualizado', idadeMs:idade, motivo:'dados de passagem desatualizados'};
    const c = compativel(det, sg, LIM.compatMaxMs);
    if (!c.ok) return {usavel:false, estado:'incompativel', idadeMs:idade, motivo:'passagem incompatível com a detecção: ' + c.motivo};
    return {usavel:true, estado:'ok', idadeMs:idade, deltaMs:c.deltaMs};
  }
  // Profundidade relativa NUNCA é requisito: só pode VETAR uma passagem. Se estiver inválida, a decisão não depende dela, e isso fica em `limitacoes`.
  function validarProf(pf, det, agora){
    if (!pf) return {usavel:false, estado:'indisponivel'};
    if (pf.estado !== 'ok') return {usavel:false, estado:pf.estado || 'indisponivel', motivo:'profundidade ' + (pf.estado || 'indisponível') + (pf.motivo ? ' (' + pf.motivo + ')' : '')};
    const idade = idadeDe(pf, agora);
    if (idade === null) return {usavel:false, estado:'incompleto', motivo:'profundidade sem referência temporal (idade desconhecida)'};
    if (!(idade <= LIM.profIdadeMaxMs)) return {usavel:false, estado:'desatualizado', idadeMs:idade, motivo:'profundidade desatualizada'};
    const c = compativel(det, pf, LIM.compatMaxMs);
    if (!c.ok) return {usavel:false, estado:'incompativel', idadeMs:idade, motivo:'profundidade incompatível com a detecção: ' + c.motivo};
    return {usavel:true, estado:'ok', idadeMs:idade, deltaMs:c.deltaMs};
  }
  // Estado de cada região (campo `estado` de evidencias.zonas e `regioes` da decisão):
  //   'obstaculo'              objeto reconhecido, estável, na região;
  //   'avaliada_favoravel'     há evidência suficiente e ela atende todos os critérios (ainda não é permissão: falta o estabilizador);
  //   'avaliada_desfavoravel'  há evidência suficiente, mas ela NÃO atende (pouca área livre, sem continuidade, largura curta, veto da profundidade);
  //   'desconhecida'           sem evidência suficiente (sem dados, desatualizados, incompatíveis, baixa confiança, possível objeto, lados não confirmados).
  // Falta de caixas NUNCA leva a 'avaliada_favoravel'.
  function avaliarRegiao(z, e, ocupado, incerto, vs, vp, ladosOk){
    if (ocupado) return {estado:'obstaculo', valida:false, motivo:'há objeto reconhecido nessa região'};
    if (incerto) return {estado:'desconhecida', valida:false, motivo: incerto === 'pendente' ? 'há detecção ainda não confirmada (persistência) nessa região' : 'há possível objeto, de baixa confiança, nessa região'};
    if (z !== 'frente' && !ladosOk) return {estado:'desconhecida', valida:false, motivo:'orientação dos lados (esquerda/direita) não confirmada'};
    if (!vs.usavel) return {estado:'desconhecida', valida:false, motivo:vs.motivo};
    const r = e.seg.regioes && e.seg.regioes[z];
    if (!r || !(r.livre >= 0) || !(r.continuidade >= 0) || !(r.larguraRel >= 0)) return {estado:'desconhecida', valida:false, motivo:'sem dados da região'};
    const med = {livre:r.livre, continuidade:r.continuidade, larguraRel:r.larguraRel, confianca:r.confianca};
    if (!(r.confianca >= LIM.segConfMin)) return Object.assign({estado:'desconhecida', valida:false, motivo:'baixa confiança na avaliação'}, med);
    if (r.livre < LIM.segLivreMin) return Object.assign({estado:'avaliada_desfavoravel', valida:false, motivo:'pouca área livre na região'}, med);
    if (r.continuidade < LIM.segContMin) return Object.assign({estado:'avaliada_desfavoravel', valida:false, motivo:'sem continuidade visual da região'}, med);
    if (r.larguraRel < LIM.segLargMin) return Object.assign({estado:'avaliada_desfavoravel', valida:false, motivo:'largura contínua insuficiente'}, med);
    const pf = vp.usavel && e.prof.regioes && e.prof.regioes[z];
    if (pf && pf.proximidade > LIM.profProxMax) return Object.assign({estado:'avaliada_desfavoravel', valida:false, motivo:'estrutura próxima na profundidade relativa'}, med);
    // critério objetivo de escolha entre passagens: largura × continuidade × confiança (todas relativas, sem metros)
    return Object.assign({estado:'avaliada_favoravel', valida:true, motivo:'área livre, contínua e larga o bastante na região', pontuacao: r.larguraRel*r.continuidade*r.confianca}, med);
  }
  // decidirOrientacao(e) → decisão DETERMINÍSTICA (sem câmera, DOM, fala nem relógio global).
  // Entrada: {grupos, candidatos, pendentes, deteccao, seg, prof, estab, modo, lados, agora, ultimaEscolha}
  //   pendentes: [{z}] detecções confiantes deste ciclo que ainda não atingiram a persistência mínima. Não contam como obstáculo (não geram aviso), mas VETAM
  //              alternativa naquela região (uma região com objeto aparecendo não é evidência de passagem) e não ativam a análise insuficiente.
  //   deteccao: {estado, motivo, tCaptura, (idadeMs)}  agora: instante atual (mesmo relógio de tCaptura)  lados: {confirmado}
  // Saída: {decisao, passagens, bloqueadas, obstaculos, motivos, limitacoes, evidencias,
  //   permiteDirecao  true só se alguma alternativa pode ser mencionada (passagens não vazio); NUNCA significa passagem segura,
  //   regioes         {esquerda|frente|direita: 'obstaculo'|'avaliada_favoravel'|'avaliada_desfavoravel'|'desconhecida'},
  //   fontes          estado de cada fonte: {deteccao, segmentacao, profundidade, lados} (com idadeMs/motivo quando houver),
  //   ausentes        informações ausentes ou inválidas que impediram uma conclusão}
  // Decisões: obstaculo_esquerda|direita, possivel_passagem_esquerda|direita|centro, possiveis_passagens_esquerda_e_direita, passagem_nao_confirmada,
  //   obstaculos_todas_direcoes, nenhum_objeto_reconhecido (nunca implica caminho livre), analise_insuficiente (dados faltando, inválidos ou antigos).
  // Evidência ausente, expirada ou incompatível derruba qualquer alternativa NA HORA, inclusive a que o estabilizador vinha mantendo.
  function decidirOrientacao(e){
    const grupos = e.grupos || [], cands = e.candidatos || [], det = e.deteccao || {estado:'indisponivel', motivo:'sem informações da detecção'};
    const motivos = [], limitacoes = ['distancia_nao_medida', 'objetos_fora_do_modelo_nao_reconhecidos'], ausentes = [];
    const ladosOk = !e.lados || e.lados.confirmado !== false, pista = e.modo === 'pista';
    const idadeDet = idadeDe(det, e.agora);
    const detEstado = det.estado !== 'ok' ? (det.estado || 'indisponivel') : idadeDet === null ? 'incompleto' : idadeDet > LIM.deteccaoIdadeMaxMs ? 'desatualizado' : 'ok';
    const vs = validarSeg(e.seg, det, e.agora), vp = e.prof ? validarProf(e.prof, det, e.agora) : {usavel:false, estado:'indisponivel'};
    if (!e.seg) limitacoes.push('passagem_nao_avaliada_pelo_sistema'); else if (!vs.usavel) limitacoes.push('passagem_nao_avaliada');
    if (!e.prof) limitacoes.push('profundidade_indisponivel'); else if (!vp.usavel) limitacoes.push('profundidade_descartada');
    if (!ladosOk) limitacoes.push('orientacao_dos_lados_nao_confirmada');
    if (!pista && !vs.usavel) ausentes.push('passagem: ' + vs.motivo);
    if (e.prof && !vp.usavel) ausentes.push('profundidade: ' + (vp.motivo || vp.estado));
    if (!ladosOk) ausentes.push('orientação dos lados (esquerda/direita) não confirmada');
    const fontes = {deteccao:{estado:detEstado, idadeMs:idadeDet, motivo:det.motivo},
      segmentacao: pista ? {estado:'nao_usada_no_modo_pista'} : {estado:vs.estado, idadeMs:vs.idadeMs, deltaMs:vs.deltaMs, motivo:vs.motivo, origem:e.seg && e.seg.origem},
      profundidade:{estado:vp.estado, idadeMs:vp.idadeMs, motivo:vp.motivo}, lados:{confirmado:ladosOk}};
    const obst = {esquerda:[], frente:[], direita:[]};
    for (const g of grupos) obst[g.z].push({nome:g.info.s, n:g.n, area:g.area, prio:g.info.prio});
    const evid = {objetos:grupos.length, candidatos:cands.length, zonas:{}, usouAvaliacaoDePassagem:false};
    if (pista) evid.modo = 'pista_controlada';          // vale também para as falhas: o texto de parada depende do modo
    // Sem detecção válida nenhuma região é conhecida: as marcas de obstáculo vêm de dados que não podem ser confiados.
    const mapa = () => { const r = {}; for (const z of ZONAS) r[z] = detEstado !== 'ok' ? 'desconhecida' : obst[z].length ? 'obstaculo' : ((evid.zonas[z] && evid.zonas[z].estado) || 'desconhecida'); return r; };
    const fim = (decisao, passagens = [], bloqueadas = []) => ({decisao, bloqueadas, passagens, obstaculos:obst, motivos, limitacoes, evidencias:evid,
      permiteDirecao: passagens.length > 0, regioes: mapa(), fontes, ausentes});

    // Falha, resultado incompleto, desatualizado, sem referência temporal ou fonte indisponível → não inventa direção e esquece alternativas anteriores.
    if (detEstado !== 'ok'){
      if (e.estab) e.estab.reset();
      motivos.push(detEstado === 'desatualizado' ? 'dados da detecção desatualizados'
        : idadeDet === null && det.estado === 'ok' ? 'detecção sem referência temporal (idade desconhecida)'
        : 'detecção ' + (det.estado === 'falha' ? 'falhou' : det.estado === 'incompleto' ? 'incompleta' : 'indisponível (' + detEstado + ')') + (det.motivo ? ': ' + det.motivo : ''));
      limitacoes.push(detEstado === 'desatualizado' ? 'deteccao_desatualizada' : idadeDet === null && det.estado === 'ok' ? 'deteccao_sem_referencia_temporal' : 'deteccao_' + detEstado);
      ausentes.push('detecção: ' + detEstado);
      return fim('analise_insuficiente');
    }
    const inc = z => cands.some(c => c.z === z), pend = z => (e.pendentes || []).some(x => x.z === z), bloq = ZONAS.filter(z => obst[z].length);
    if (pista) return decidirPista(e, {obst, cands, bloq, motivos, limitacoes, evid, fim, inc, ladosOk});
    const brutas = [];
    for (const z of ZONAS){
      const av = avaliarRegiao(z, e, obst[z].length > 0, inc(z) ? 'baixa' : pend(z) ? 'pendente' : false, vs, vp, ladosOk); evid.zonas[z] = av;
      if (av.valida){ brutas.push(z); evid.usouAvaliacaoDePassagem = true; }
    }
    // Cai na hora: zona com objeto/possível objeto, e TODAS as zonas se a evidência de passagem sumiu, expirou ou ficou incompatível (sem histerese).
    const semEvidencia = z => !vs.usavel || (z !== 'frente' && !ladosOk);
    const imediatos = ZONAS.filter(z => obst[z].length || inc(z) || pend(z) || semEvidencia(z));
    const val = e.estab ? e.estab.filtrar(brutas, imediatos) : brutas;
    for (const z of ZONAS) if (brutas.includes(z) && !val.includes(z)) evid.zonas[z].emEstabilizacao = true;
    for (const z of bloq) motivos.push('obstáculo ' + ZTXT[z] + ': ' + obst[z].map(o => o.nome).join(', '));

    if (!grupos.length){
      if (cands.length){                                                              // baixa confiança
        const zs = [...new Set(cands.map(c => c.z))];
        motivos.push('possível objeto com baixa confiança ' + zs.map(z => ZTXT[z]).join(' e ')); limitacoes.push('baixa_confianca'); evid.zonasIncertas = zs;
        return fim('analise_insuficiente');
      }
      // Cenário E: nenhum objeto reconhecido NÃO é evidência de passagem. Mesmo com avaliação de piso favorável não se indica direção nem "passagem".
      motivos.push('nenhuma classe monitorada reconhecida'); limitacoes.push('ausencia_de_deteccao_nao_indica_caminho_livre');
      return fim('nenhum_objeto_reconhecido');
    }
    if (bloq.length === 3){ motivos.push('obstáculos em todas as regiões analisadas'); return fim('obstaculos_todas_direcoes', [], bloq); }   // todas obstruídas
    if (bloq.length === 2){                                                            // duas regiões obstruídas: só a restante, e só com evidência
      const livre = ZONAS.find(z => !bloq.includes(z));
      if (val.includes(livre)){ motivos.push('passagem validada ' + (livre === 'frente' ? 'pelo centro' : ZTXT[livre])); return fim('possivel_passagem_' + (livre === 'frente' ? 'centro' : livre), [livre], bloq); }
      motivos.push('nenhuma região restante com passagem validada'); return fim('passagem_nao_confirmada', [], bloq);
    }
    const z = bloq[0];
    if (z === 'frente'){                                                               // só o centro obstruído
      const lados = val.filter(l => l !== 'frente');
      if (lados.length === 2){
        const pe = evid.zonas.esquerda.pontuacao, pd = evid.zonas.direita.pontuacao;
        if (Math.abs(pe - pd) >= LIM.margemEscolha){
          const l = pe > pd ? 'esquerda' : 'direita'; evid.criterio = 'largura×continuidade×confiança: ' + pe.toFixed(2) + ' (esq.) contra ' + pd.toFixed(2) + ' (dir.)';
          motivos.push('passagem à ' + l + ' claramente melhor que à ' + OPOSTO[l]); return fim('possivel_passagem_' + l, [l], bloq);
        }
        motivos.push('passagens validadas nos dois lados, com pontuação parecida'); return fim('possiveis_passagens_esquerda_e_direita', lados, bloq);
      }
      if (lados.length === 1){ motivos.push('passagem validada à ' + lados[0]); return fim('possivel_passagem_' + lados[0], lados, bloq); }
      motivos.push('frente obstruída e nenhuma lateral com passagem validada'); return fim('passagem_nao_confirmada', [], bloq);
    }
    // Obstáculo só em uma lateral. O lado oposto só é indicado com passagem validada, nunca por falta de detecção.
    const op = OPOSTO[z];
    if (val.includes(op)){ motivos.push('passagem validada à ' + op); return fim('possivel_passagem_' + op, [op], bloq); }
    motivos.push(op + ': ' + evid.zonas[op].motivo);
    return fim('obstaculo_' + z, [], bloq);
  }

  // ---- Modo PISTA CONTROLADA (EXPERIMENTAL, opt-in) ----
  // Premissa da DEMONSTRAÇÃO (não é capacidade da visão computacional): a pista é montada com 1 ou 2 passagens disponíveis em cada situação planejada.
  // Por isso, aqui uma região conta como DISPONÍVEL quando NÃO tem obstáculo confirmado (estável) e NÃO tem possível objeto de baixa confiança.
  // Isso é uma suposição da pista: a ausência de detecção NÃO prova que a região esteja livre ou segura, e o modelo não reconhece paletes, paredes etc.
  // Por isso, no relatório de regiões essas regiões aparecem como 'desconhecida' (com assumidaDisponivelPelaPista), nunca como evidência.
  // A heurística de cor do piso NÃO participa da decisão neste modo (não pode bloquear a orientação). Falhas, dados velhos e baixa confiança continuam
  // gerando "análise insuficiente", nunca uma direção inventada. Se houver duas passagens, a escolha é consistente: mantém a anterior enquanto valer;
  // senão segue PRIORIDADE_PISTA (fixa), para não alternar esquerda/direita a cada análise. Lados não confirmados: nenhuma alternativa lateral.
  const PRIORIDADE_PISTA = ['esquerda', 'direita'];
  function decidirPista(e, c){
    const {obst, cands, bloq, motivos, limitacoes, evid, fim, inc, ladosOk} = c;
    limitacoes.push('pista_controlada_experimental', 'disponibilidade_assumida_pela_pista_nao_comprovada_pela_camera');
    evid.modo = 'pista_controlada';
    const disp = z => !bloq.includes(z) && !inc(z) && (z === 'frente' || ladosOk);
    for (const z of ZONAS) evid.zonas[z] = {estado: bloq.includes(z) ? 'obstaculo' : 'desconhecida', obstruida: bloq.includes(z), incerta: inc(z), disponivel: disp(z), assumidaDisponivelPelaPista: disp(z)};
    for (const z of bloq) motivos.push('obstáculo ' + ZTXT[z] + ': ' + obst[z].map(o => o.nome).join(', '));
    if (!bloq.length){
      if (cands.length){
        const zs = [...new Set(cands.map(x => x.z))];
        motivos.push('possível objeto com baixa confiança ' + zs.map(z => ZTXT[z]).join(' e ')); limitacoes.push('baixa_confianca'); evid.zonasIncertas = zs;
        return fim('analise_insuficiente');
      }
      motivos.push('nenhuma classe monitorada reconhecida'); limitacoes.push('ausencia_de_deteccao_nao_indica_caminho_livre');
      return fim('nenhum_obstaculo_reconhecido');
    }
    if (bloq.length === 3){ motivos.push('obstáculos em todas as regiões analisadas'); return fim('obstaculos_todas_direcoes', [], bloq); }
    const opcoes = bloq.length === 2 ? ZONAS.filter(disp)
                 : bloq[0] === 'frente' ? ['esquerda', 'direita'].filter(disp)
                 : [OPOSTO[bloq[0]]].filter(disp);
    evid.opcoes = opcoes;
    if (!opcoes.length){
      motivos.push(ladosOk ? 'nenhuma região alternativa disponível (possível objeto de baixa confiança)' : 'orientação dos lados não confirmada: alternativas laterais não indicadas');
      if (ladosOk) limitacoes.push('baixa_confianca');
      return fim('analise_insuficiente');
    }
    let escolha = opcoes[0];
    if (opcoes.length > 1){
      const manteve = opcoes.includes(e.ultimaEscolha);
      escolha = manteve ? e.ultimaEscolha : PRIORIDADE_PISTA.find(z => opcoes.includes(z));
      motivos.push('duas passagens disponíveis; ' + (manteve ? 'mantida a escolha anterior (estabilidade)' : 'escolhida por prioridade fixa da pista') + ': ' + escolha);
    } else motivos.push('passagem disponível pela regra da pista: ' + escolha);
    const r = fim((bloq.includes('frente') ? 'desvio_' : 'seguir_') + (escolha === 'frente' ? 'centro' : escolha), [escolha], bloq);
    r.escolha = escolha; return r;
  }

  // ---- Fala ----
  const NUM = {f:['uma','duas','três'], m:['um','dois','três']};
  function nomeN(g){ return g.n === 1 ? g.info.s : ((g.n <= 3 ? NUM[g.info.g][g.n-1] : 'várias') + ' ' + g.info.p); }
  const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
  const MSG = {
    todas: 'Obstáculos em todas as direções analisadas. Pare e solicite auxílio.',
    naoConfirmada: 'Não foi possível confirmar uma passagem.',
    naoAvaliada: 'Não foi possível avaliar a passagem adequadamente.',
    pistaTodas: 'Pare. Obstáculos identificados em todas as direções.',
    pistaInconclusiva: 'Não foi possível avaliar a passagem. Pare e aguarde.',
    nenhum: 'Nenhum obstáculo reconhecido nas classes monitoradas. Isso não indica caminho livre.'
  };
  const semPassagem = dec => dec.limitacoes.includes('passagem_nao_avaliada') ? MSG.naoAvaliada : MSG.naoConfirmada;
  function cabecalho(B){
    const e = B.includes('esquerda'), c = B.includes('frente'), d = B.includes('direita');
    if (c && d && !e) return 'Obstáculo à frente e à direita';
    if (c && e && !d) return 'Obstáculo à frente e à esquerda';
    if (e && d && !c) return 'Obstáculos nas laterais';
    if (c) return 'Obstáculo à frente';
    return e ? 'Obstáculo à esquerda' : 'Obstáculo à direita';
  }
  function sufixoPassagens(P){
    if (P.length === 2) return 'Passagens possíveis à esquerda e à direita.';
    return P[0] === 'frente' ? 'Possível passagem pelo centro.' : 'Possível passagem ' + ZTXT[P[0]] + '.';
  }
  // Texto da orientação. "texto" = completo (quando a situação muda); "curto" = só o obstáculo (repetições por tempo),
  // para não martelar a mesma ressalva em todo alerta. Nunca afirma passagem livre.
  function planejar(grupos, dec){
    dec = dec || decidirOrientacao({grupos, deteccao:{estado:'ok', idadeMs:0}});   // atalho para testes/ferramentas: o chamador afirma dados recém-capturados
    if (dec.decisao === 'analise_insuficiente') return planejarSemObjetos(dec);   // dados incompletos: nada de direção nem de lista de objetos
    if (dec.evidencias.modo === 'pista_controlada') return planejarPista(grupos, dec);
    const rel = g => g.info.prio*10 + (g.z === 'frente' ? 15 : 0) + Math.min(g.area,.5)*20;
    const ord = [...grupos].sort((a,b) => rel(b) - rel(a));
    const ass = [...grupos].map(g => g.info.s+'|'+g.z+'|'+g.n).sort().join(';') + '#' + dec.decisao + ':' + [...dec.passagens].sort().join(',');
    let urg = grupos.filter(g => g.z === 'frente' && g.info.prio >= 3).map(g => g.info.s).sort().join(';');
    if (dec.decisao === 'obstaculos_todas_direcoes') return {texto:MSG.todas, curto:MSG.todas, ass, urg:'parar', urgente:true};   // Regra 5: parar
    const usados = ord.slice(0,4), resto = ord.length - usados.length;
    const zonas = [...new Set(usados.map(g => g.z))];
    const frases = zonas.map(z => usados.filter(g => g.z === z).map(nomeN).join(' e ') + ' ' + ZTXT[z]);
    let t = frases.length > 2 ? frases.slice(0,-1).join(', ') + ' e ' + frases[frases.length-1] : frases.join(' e ');
    if (resto > 0) t += ', e mais ' + resto + (resto === 1 ? ' objeto' : ' objetos');
    const nomeado = cap(t) + '.';
    if (dec.passagens.length){                                                      // Regras 1 a 4, 6 e 7: texto genérico e curto, como especificado
      const head = cabecalho(dec.bloqueadas);
      return {texto: head + '. ' + sufixoPassagens(dec.passagens), curto: head + '.', ass, urg, urgente: urg !== ''};
    }
    if (dec.decisao === 'passagem_nao_confirmada') return {texto: nomeado + ' ' + semPassagem(dec), curto: nomeado, ass, urg, urgente: urg !== ''};
    return {texto:nomeado, curto:nomeado, ass, urg, urgente: urg !== ''};          // obstáculo só numa lateral: sem sugerir o lado oposto (Regra 7)
  }
  // Modo pista: instrução de direção curta e genérica (sem tamanho do obstáculo). A mesma instrução é repetida por completo, pois a direção é o que importa;
  // o controle de repetição vem do cooldown em analisar. A assinatura ignora contagem e nomes: mais um objeto na mesma região não gera nova fala.
  function planejarPista(grupos, dec){
    const B = dec.bloqueadas, urg = grupos.filter(g => g.z === 'frente' && g.info.prio >= 3).map(g => g.info.s).sort().join(';');
    const ass = 'pista|' + dec.decisao + '|' + [...B].sort().join(',') + '|' + urg;
    if (dec.decisao === 'obstaculos_todas_direcoes') return {texto:MSG.pistaTodas, curto:MSG.pistaTodas, ass, urg:'parar', urgente:true};
    const rota = dec.passagens[0];
    const head = (B.length === 2 && !B.includes('frente')) ? 'Laterais obstruídas' : cabecalho(B);
    const t = head + '. ' + (B.includes('frente') ? 'Desvie' : 'Siga') + ' ' + (rota === 'frente' ? 'pelo centro' : 'pela ' + rota) + '.';
    return {texto:t, curto:t, ass, urg, urgente: urg !== ''};
  }
  // Decisões sem objetos estáveis: análise insuficiente ou nenhum objeto reconhecido. Nunca dizem "caminho livre".
  function planejarSemObjetos(dec){
    let t;
    if (dec.evidencias.modo === 'pista_controlada') t = dec.decisao === 'analise_insuficiente' ? MSG.pistaInconclusiva : MSG.nenhum;
    else if (dec.decisao === 'analise_insuficiente') t = MSG.naoAvaliada;
    else t = MSG.nenhum;                       // sem objetos: só informa o que o modelo não reconheceu; nunca direção nem "passagem"

    return {texto:t, curto:t, ass:'#'+dec.decisao, urg:'', urgente:false};
  }
  // Estabilização por grupo (chave "nome falado|zona"), chamada uma vez por ciclo:
  //  - ativa após `persist` presenças dentro de uma janela de persist+2 ciclos, estando presente agora (tolera 1 falha isolada);
  //  - permanece ativa até AUS_MAX ciclos seguidos de ausência (um ciclo perdido não faz o objeto "sumir" e voltar);
  //  - a contagem só muda após K_N ciclos seguidos com o novo valor.
  const AUS_MAX = 3, K_N = 3;
  function atualizarTracks(tr, grupos, persist){
    for (const k of new Set([...tr.keys(), ...grupos.keys()])){
      const g = grupos.get(k), t = tr.get(k) || {hist:[], ativo:false, aus:0, nEst:0, cand:0, cnt:0, area:0};
      t.hist.push(g ? g.n : 0); if (t.hist.length > persist + 2) t.hist.shift();
      if (g){
        t.aus = 0; t.info = g.info; t.cls = g.cls; t.z = g.z; t.area = g.area;
        if (!t.nEst) t.nEst = g.n;
        else if (g.n === t.nEst) t.cnt = 0;
        else { t.cnt = (t.cand === g.n) ? t.cnt + 1 : 1; t.cand = g.n; if (t.cnt >= K_N){ t.nEst = g.n; t.cnt = 0; } }
        if (!t.ativo && t.hist.filter(v => v > 0).length >= persist) t.ativo = true;
      } else if (t.ativo && ++t.aus >= AUS_MAX){ t.ativo = false; t.nEst = 0; }
      if (!g && !t.ativo && t.hist.every(v => v === 0)) tr.delete(k); else tr.set(k, t);
    }
    return [...tr.values()].filter(t => t.ativo).map(t => ({cls:t.cls, info:t.info, z:t.z, n:t.nEst, area:t.area}));
  }
  // ==== FIM PLANEJADOR ====

  // ==== VALIDACAO DO MODELO ====
  // A saída do modelo é dado NÃO confiável e só entra na decisão o que tiver formato válido. Sem isto, um `score` NaN passaria por
  // "score < limiar" (comparação com NaN é sempre falsa) e viraria detecção CONFIANTE, e um bbox com NaN cairia sempre na zona "direita".
  // Caixas um pouco além da borda são recortadas ao quadro; as que passam de PRED.margemRel do quadro, ou têm largura/altura <= 0, são descartadas.
  const PRED = {margemRel:.1};
  function validarPredicoes(preds, W, H){
    if (!Array.isArray(preds)) return {validas:[], descartadas:0, motivo:'resultado do modelo inválido'};
    if (!(W > 0) || !(H > 0)) return {validas:[], descartadas:preds.length, motivo:'sem dimensões do vídeo'};
    const mx = PRED.margemRel*W, my = PRED.margemRel*H, validas = [];
    let descartadas = 0;
    for (const p of preds){
      const b = p && p.bbox;
      const formato = p && typeof p.class === 'string' && Number.isFinite(p.score) && p.score >= 0 && p.score <= 1
        && Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > 0 && b[3] > 0;
      if (!formato || b[0] < -mx || b[1] < -my || b[0] + b[2] > W + mx || b[1] + b[3] > H + my){ descartadas++; continue; }
      const x0 = Math.max(0, b[0]), y0 = Math.max(0, b[1]), x1 = Math.min(W, b[0] + b[2]), y1 = Math.min(H, b[1] + b[3]);
      if (!(x1 > x0) || !(y1 > y0)){ descartadas++; continue; }
      validas.push({class:p.class, score:p.score, bbox:[x0, y0, x1 - x0, y1 - y0]});
    }
    return {validas, descartadas, motivo: descartadas ? descartadas + (descartadas === 1 ? ' predição malformada descartada' : ' predições malformadas descartadas') : ''};
  }
  // ==== FIM VALIDACAO DO MODELO ====

  // ==== CICLO DE VIDA ====
  // Estados da sessão e as únicas transições aceitas. Cada abertura de sessão recebe um número: trabalho assíncrono (permissão da câmera,
  // carga do modelo) guarda o número da sua sessão e só pode mudar o estado se ela ainda for a atual. Encerrar troca o número, então uma
  // promessa atrasada nunca "ressuscita" uma sessão que o usuário já encerrou.
  //   ocioso → solicitando_camera → carregando_modelo → ativo ⇄ pausado → ocioso
  //   falhas: camera_indisponivel (permissão negada, câmera ausente ou perdida) e modelo_indisponivel (biblioteca ou pesos não carregaram).
  const TRANSICOES = {
    ocioso:              ['solicitando_camera'],
    solicitando_camera:  ['carregando_modelo', 'camera_indisponivel', 'ocioso'],
    carregando_modelo:   ['ativo', 'modelo_indisponivel', 'ocioso'],
    ativo:               ['pausado', 'camera_indisponivel', 'ocioso'],
    pausado:             ['ativo', 'camera_indisponivel', 'ocioso'],
    camera_indisponivel: ['solicitando_camera', 'ocioso'],
    modelo_indisponivel: ['solicitando_camera', 'ocioso']
  };
  const ESTADOS_INICIANDO = ['solicitando_camera', 'carregando_modelo'], ESTADOS_EM_SESSAO = ['ativo', 'pausado'];
  function criarCicloDeVida(aoMudar){
    let estado = 'ocioso', sessao = 0;
    const mudar = para => { const de = estado; estado = para; if (aoMudar){ try { aoMudar(para, de); } catch (e) { /* a interface não pode travar o ciclo de vida */ } } };
    return {
      estado: () => estado,
      sessao: () => sessao,
      vale: s => s === sessao,
      iniciando: () => ESTADOS_INICIANDO.includes(estado),
      emSessao: () => ESTADOS_EM_SESSAO.includes(estado),
      // Abre uma sessão nova (só a partir de um estado de repouso). Devolve o número dela, ou 0 se já há uma sessão iniciando ou rodando.
      abrir(){ if (!TRANSICOES[estado].includes('solicitando_camera')) return 0; sessao++; mudar('solicitando_camera'); return sessao; },
      // Transição validada: falha (false) se a sessão informada não é mais a atual ou se a transição não existe.
      transitar(para, s = sessao){ if (s !== sessao || !(TRANSICOES[estado] || []).includes(para)) return false; mudar(para); return true; },
      // Encerra de qualquer estado e invalida todo trabalho pendente da sessão anterior.
      encerrar(){ sessao++; if (estado !== 'ocioso') mudar('ocioso'); }
    };
  }
  // Mensagens de falha ao iniciar, sem jogar exceções técnicas (em inglês) na tela.
  function mensagemErroInicio(e, etapa, ambiente = {}){
    if (etapa === 'modelo') return (e && e.mensagemUsuario) || 'Não foi possível carregar o modelo de detecção. Verifique a internet e tente de novo.';
    if (ambiente.contextoSeguro === false) return 'A câmera exige conexão segura: abra a página por https ou em localhost.';
    switch (e && e.name){
      case 'NotAllowedError': case 'PermissionDeniedError': return 'Permissão da câmera negada. Libere a câmera nas configurações do navegador e tente de novo.';
      case 'NotFoundError': case 'DevicesNotFoundError': return 'Nenhuma câmera foi encontrada neste aparelho.';
      case 'OverconstrainedError': case 'ConstraintNotSatisfiedError': return 'A câmera escolhida não está disponível. Escolha "Padrão" no seletor de câmera.';
      case 'NotReadableError': case 'TrackStartError': return 'A câmera está em uso por outro aplicativo ou não pôde ser aberta.';
      case 'SecurityError': return 'O navegador bloqueou o acesso à câmera nesta página.';
      case 'AbortError': return 'A abertura da câmera foi interrompida. Tente de novo.';
      default: return (e && e.mensagemUsuario) || 'Não foi possível abrir a câmera.';
    }
  }
  // ==== FIM CICLO DE VIDA ====

  return {CLASSES, criarAgendador, idadeDe, compativel, validarFonteExterna, ladosConfirmados, estadoAnalise, regioesDeMascara,
    ZTXT, ZONAS, LIM, PASS, MSG, configurarLimites, resolverLados, ladoUsuario, rotulosLados, zonaDe, limiar, avaliarPassagemPorCor,
    criarEstabilizadorAlt, decidirOrientacao, planejar, planejarSemObjetos, atualizarTracks,
    PRED, validarPredicoes, TRANSICOES, criarCicloDeVida, mensagemErroInicio};
}
if (typeof module === 'object' && module.exports) module.exports = {criarNucleoVisio};
else globalThis.VisioNucleo = criarNucleoVisio();
