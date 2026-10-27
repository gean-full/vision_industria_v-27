# VisioIndústria — medição em celular e decisão de plataforma

**Status: nenhuma medição em aparelho real foi feita.** Este documento é o procedimento. Todos os resultados estão **pendentes**.

## 1. Linha de base de desempenho (4 execuções)

| # | Modelo | Intervalo de análise |
|---|--------|----------------------|
| 1 | Leve (`lite_mobilenet_v2`) | 300 ms |
| 2 | Leve | 100 ms |
| 3 | Preciso (`mobilenet_v2`) | 300 ms |
| 4 | Preciso | 100 ms |

Para cada execução:

1. Registrar **aparelho, sistema operacional, navegador e versão**, modo economia de energia (sim/não) e se está carregando.
2. Registrar **bateria no início** (%) e a temperatura percebida (frio / morno / quente).
3. Fechar outros apps. Abrir a página, escolher modelo e intervalo, **iniciar** e aguardar o carregamento. Anotar "Carga do modelo" e "Backend do TensorFlow.js" do painel.
4. Apontar a câmera para uma **cena padronizada e sempre a mesma** (marcar a posição do aparelho). Manter por **3 minutos**.
5. Ao fim, anotar do painel: inferência (última/média/p95), ciclo total (média/p95), FPS efetivo, FPS da câmera, ciclos concluídos/ignorados/com erro/acima do intervalo/descartados e **inferências expiradas**.
6. **Baixar desempenho (CSV)** e **Baixar alertas (CSV)**. O CSV de desempenho tem a coluna `codigo_erro` (separa `falha_inferencia`, `inferencia_expirada`, `camera_indisponivel`, `sem_quadros_novos`, `falha_callback`).
7. Registrar **bateria no fim**, sinais de aquecimento e se a taxa de quadros caiu ao longo dos 3 minutos (comparar o 1º minuto com o 3º no CSV: sinal de *throttling*).
8. Repetir a execução 1 após aquecer o aparelho (3 minutos já rodando) para ver o comportamento "pós-aquecimento".

Campos ausentes aparecem como `–` ou vazios: **ausência de medição não é zero**.

## 2. Limites provisórios que a medição deve calibrar

Nenhum foi calibrado. Estão em `LIM` e podem ser alterados sem editar o código, via `VisioIndustria.configurarLimites({...})` no console:

| Limite | Valor inicial | Como calibrar |
|---|---|---|
| `deteccaoIdadeMaxMs`, `segIdadeMaxMs`, `profIdadeMaxMs` | 1500 | Deve ser maior que o **p95 do ciclo** medido e pequeno frente à velocidade com que a cena muda no uso real. |
| `compatMaxMs` | 300 | Diferença máxima entre os instantes de captura da detecção e da segmentação. **Dois efeitos opostos:** se for menor que a diferença normal entre as tarefas (≈ p95 da inferência do segmentador, que roda antes do COCO-SSD no mesmo ciclo), a fonte **nunca** será compatível (seguro, mas inútil); se for grande frente ao **período do ciclo**, uma segmentação de 1 ou 2 ciclos atrás ainda é combinada, e o estabilizador pode confirmar uma alternativa com dado de outro quadro. Com ciclo de ~110 ms, 300 ms aceita até ~2 ciclos de defasagem. Calibre com o período e o p95 medidos. |

## 3. Web instalada (PWA): o que existe e o que falta

Estado atual verificado no código (ver `sw.js`, `manifest.webmanifest`, `js/pwa.js`):

- **Existe:** manifesto, ícones (SVG, 192 e 512 px, inclusive "maskable"), service worker com cache **só da casca** (HTML, CSS, JS do app, manifesto, ícones), estratégia **rede primeiro** e versão (`VERSAO` em `sw.js`; a ativação apaga as versões antigas deste app). O registro só acontece em contexto seguro.
- **Não existe:** funcionamento offline da detecção. Os scripts do jsDelivr (TensorFlow.js 4.22.0 e COCO-SSD 2.2.3, com SRI) e os **pesos do modelo** (URL padrão da biblioteca: `https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/` para o Leve e `.../ssd_mobilenet_v2/` para o Preciso, verificada no pacote publicado) vêm da rede e **não** são guardados pelo service worker. Sem internet, a página abre, mostra o aviso "Sem a biblioteca de detecção" e o início termina em "Modelo indisponível".
- Tamanho medido dos pesos (soma dos arquivos do `model.json`, 27/10/2026): **Leve 18,6 MB**, **Preciso 67,8 MB**.

Para a detecção funcionar offline de verdade ainda seria preciso:

- **Hospedar localmente** `tf.min.js` e `coco-ssd.min.js` (mesma origem) e incluí-los na casca.
- **Hospedar os pesos** do modelo escolhido, passar `modelUrl` ao `cocoSsd.load` e decidir se entram no pré-cache (o Leve já soma 18,6 MB; o Preciso, 67,8 MB): avaliar a cota de armazenamento e a remoção de cache pelo navegador/SO.
- Testar com o aparelho em **modo avião**, depois de instalado.

**Cache de interface não é funcionamento offline**: só vale se os modelos também carregarem sem rede.

## 4. Quando considerar um APK nativo

Uma web instalada **não** tem pipeline nativo de câmera nem inferência nativa. Só considerar migração se a medição (ou um requisito operacional) mostrar algo **concreto**, por exemplo:

- FPS efetivo ou p95 do ciclo **abaixo do mínimo que o uso exige**, mesmo no modelo Leve e com intervalo de 300 ms;
- *throttling* térmico ou queda de FPS nos 3 minutos que inviabilize o turno de uso;
- necessidade de API que a web não oferece (execução com a tela apagada ou em segundo plano, botões físicos, controle fino da câmera);
- modelos de segmentação/profundidade escolhidos que não rodem de forma aceitável em TensorFlow.js nos aparelhos suportados.

O mínimo exigido (FPS, latência, autonomia da bateria) **é decisão operacional sua**; não foi definido aqui. Sem esses números, "nativo é mais rápido" não é justificativa.

## 5. Segmentação e profundidade

**Nenhum modelo está incluído nem foi validado.** O que existe é a estrutura de integração, testada só com máscaras e um segmentador *sintéticos*.

**O que foi verificado sobre modelos (busca nesta etapa):** o pacote DeepLab do TensorFlow.js oferece três variantes de pesos (Pascal, Cityscapes e ADE20K). O ADE20K tem 150 classes e inclui parede, piso, porta e escada. **Não verifiquei** as listas completas de Pascal e Cityscapes, nem se existe classe para palete, degrau pequeno ou buraco em qualquer uma delas. Também **não verifiquei o formato exato da saída** do `segment()` do DeepLab (se devolve ids de classe ou uma imagem colorida): o adaptador exige **ids de classe por pixel**, então talvez seja preciso usar a saída em ids do modelo.

**Como integrar (já implementado):**

```js
VisioIndustria.registrarSegmentador({
  origem: 'nome-do-modelo',
  rotulos: { piso: [ /* ids das classes de chão transitável */ ] },   // todas as outras classes contam como NÃO livres
  confianca: 0,            // calibração de campo; 0 = nunca autoriza alternativa
  executar: async (video) => ({ mascara: Uint8Array, w, h }),         // um id de classe por pixel
  // opcionais: cadaN, prio (padrão 5, antes do COCO-SSD), timeoutMs (padrão 2000, provisório), pronto()
});
```

Regras da integração:

- `confianca` é **obrigatória** e vem de validação em campo; a máscara não traz confiança por pixel. Com 0 (ou baixa) o motor trata as regiões como "baixa confiança" e **não indica alternativa**. Teto de 0,9.
- O segmentador é **tarefa opcional**: é adiado se o aparelho está lento, e nesse caso a passagem fica indeterminada enquanto o alerta de obstáculo continua.
- Falha, lixo ou demora do segmentador viram estado dele (`falha`, `incompleto`, `inferencia_expirada`) e **não derrubam** os alertas de obstáculo. Não há retorno silencioso à heurística de cor. O `timeoutMs` não cancela a inferência, só deixa de esperá-la.
- Rodar a cada N ciclos (`cadaN`) reaproveita o resultado, que é rejeitado quando passa de `compatMaxMs`.
- Parede e porta entram só como **área não livre**. O app **não anuncia** "parede" nem "porta": isso exigiria decisão sua sobre mensagens, pois sem distância "parede à frente" tende a repetir o tempo todo num corredor.

**Antes de escolher um modelo, verificar:** classes reais, conjunto de treino, pertinência para ambiente industrial (chão, desníveis, buracos, limites de plataforma), custo no aparelho, compatibilidade com TensorFlow.js e o formato real da saída.

**Profundidade relativa:** continua só como veto opcional (`receberProfundidade`), com as mesmas exigências de contrato. Nunca é requisito e nunca vira metros.

**Palete, carrinho, degrau e buraco** exigem outra solução (detector treinado com fotos da sua fábrica; profundidade real ou sensor dedicado). O adaptador de máscara não resolve esses casos.
