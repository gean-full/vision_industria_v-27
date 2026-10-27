# VisioIndústria

Protótipo experimental, no navegador, de **alertas falados de obstáculos** a partir da câmera do celular: o modelo COCO-SSD (TensorFlow.js) reconhece algumas classes de objetos, o app indica se estão à esquerda, à frente ou à direita **na imagem** e fala o aviso em português.

> **Ferramenta complementar.** Não confirma que o caminho está livre, não mede distância, não evita colisões e não substitui bengala, cão-guia, EPI, procedimentos de segurança ou avaliação profissional. Não tem certificação de segurança industrial e não controla máquinas. Ausência de detecção **não** é ausência de obstáculo.

## O que funciona hoje

| Capacidade | Situação |
|---|---|
| Câmera traseira/escolhida, prévia e caixas sobre a imagem | Implementado |
| Detecção COCO-SSD (modelo Leve ou Preciso) | Implementado; precisão em cena industrial **não validada** |
| Avisos falados (pt-BR) com prioridade, sem fila e com intervalo entre repetições | Implementado; voz real só verificável no aparelho |
| Pausar, retomar (descarta evidências antigas), encerrar (libera a câmera) | Implementado e testado com simulação |
| “Possível passagem” pela heurística de cor do piso (modo padrão) | **Experimental**, sem validação em campo |
| Modo pista controlada | **Experimental**: assume disponibilidade, não comprova |
| Segmentação semântica, profundidade, distância em metros, rastreamento | **Não existem** (há só o ponto de integração `registrarSegmentador`) |
| Instalação como app (PWA) | Implementado; **a detecção exige internet** (ver abaixo) |

## Como rodar

A câmera só funciona em **contexto seguro** (https ou `localhost`).

```bash
python3 -m http.server 8080      # ou: npm run serve
# abra http://localhost:8080/visioindustria.html
```

No celular, publique por https (por exemplo, GitHub Pages: Settings → Pages → branch `main`, pasta raiz) e abra `https://<usuário>.github.io/<repositório>/`. O `index.html` redireciona para `visioindustria.html`. Não há etapa de build nem backend.

### O que é baixado pela rede

| Arquivo | Origem | Tamanho medido |
|---|---|---|
| TensorFlow.js 4.22.0 (`tf.min.js`) | cdn.jsdelivr.net (SRI sha384) | — |
| COCO-SSD 2.2.3 (`coco-ssd.min.js`) | cdn.jsdelivr.net (SRI sha384) | — |
| Pesos do modelo **Leve** (`ssdlite_mobilenet_v2`) | storage.googleapis.com | 18,6 MB |
| Pesos do modelo **Preciso** (`ssd_mobilenet_v2`) | storage.googleapis.com | 67,8 MB |

Os tamanhos dos pesos foram medidos baixando os arquivos listados no `model.json` de cada modelo em 27/10/2026. Os hashes SRI foram calculados sobre os arquivos dos pacotes publicados no npm, que é de onde o jsDelivr os serve; a equivalência com o que o jsDelivr entrega precisa ser conferida num navegador com acesso ao CDN (se o hash não bater, o navegador recusa o script e a página mostra o aviso “Sem a biblioteca de detecção”).

A política de segurança (CSP, no `<meta>` do HTML) só permite scripts da mesma origem e do jsDelivr, conexões só com a mesma origem e com o Google Storage (pesos do modelo), e proíbe scripts e estilos embutidos. Ela inclui `'unsafe-eval'` porque o TensorFlow.js 4.22 usa `Function()` internamente: sem isso a carga do modelo falha (verificado no Chromium). Se a hospedagem permitir cabeçalhos HTTP, a mesma política pode ir para o cabeçalho `Content-Security-Policy`.

Nenhuma imagem sai do aparelho: a inferência é local e nada é gravado (o app não usa armazenamento local nem envia dados; isso é verificado por teste estático).

## Testes

```bash
npm test          # = node --test testes/*.test.js   (Node 21 ou mais novo; sem dependências)
npm run check     # verificação de sintaxe dos scripts
```

| Arquivo | O que cobre |
|---|---|
| `testes/visioindustria.test.js` | Suíte original: agendador, decisão de orientação, mensagens, estabilização, modo pista, contratos de fonte, app com stubs |
| `testes/nucleo.test.js` | Validação de predições, máquina de estados do ciclo de vida, mensagens de erro, invariantes de segurança |
| `testes/ciclo-de-vida.test.js` | App inteiro com câmera, modelo e voz simulados: início repetido, cancelar durante permissão/carga, permissão negada, câmera perdida, teclado, predições malformadas |
| `testes/pwa-e-publicacao.test.js` | Manifesto, ícones, CSP, referências do HTML, service worker em ambiente falso |
| `testes/navegador/verificar.js` | **Opcional**, fora do `npm test`: Chromium real (Playwright) com câmera falsa e o modelo real. Instruções no topo do arquivo |

Todos os testes usam dados **sintéticos**: validam a lógica, não a precisão do COCO-SSD, a câmera física, a voz real nem o desempenho em celular.

## Arquitetura

```
visioindustria.html   marcação, CSP, carregamento dos scripts (sem JS nem CSS embutidos)
css/visioindustria.css
js/nucleo.js          lógica PURA (sem DOM, câmera, voz ou relógio global), testável no Node:
                        CLASSES · agendador de inferência · contrato temporal das fontes · decisão de orientação
                        · texto falado · validação das predições · ciclo de vida (máquina de estados)
js/app.js             efeitos colaterais: interface, câmera, carga do modelo, voz, painel; usa window.VisioNucleo
js/pwa.js             registro do service worker
sw.js                 cache só da casca do app (rede primeiro), com versão
manifest.webmanifest, icones/
```

Decisões principais:

- **Ciclo de vida explícito** (`criarCicloDeVida`): `ocioso → solicitando_camera → carregando_modelo → ativo ⇄ pausado`, com `camera_indisponivel` e `modelo_indisponivel`. Cada sessão tem um número; encerrar troca o número, então permissão ou carga do modelo que chegam atrasadas não reativam nada, e a câmera que chegar depois é liberada na hora. Botões e selo de estado derivam desse estado.
- **Uma cadeia de inferência** (`criarAgendador`): nunca há duas inferências ao mesmo tempo; o próximo ciclo só é agendado quando o atual termina; resultados de uma geração pausada/encerrada são descartados; watchdog para inferência travada.
- **Saída do modelo é dado não confiável** (`validarPredicoes`): `score` NaN, caixas com NaN, vazias ou fora do quadro invalidam o resultado do ciclo, que vira “análise insuficiente”.
- **Observação ≠ conclusão** (`decidirOrientacao`): só um objeto detectado e estável vira obstáculo; uma direção só é sugerida com evidência positiva, recente e do mesmo quadro. Dados velhos, incompletos ou com falha resultam em “Não foi possível avaliar… / Pare e aguarde”.
- **Sem framework nem build**: o app continua sendo arquivos estáticos publicáveis no GitHub Pages.

Histórico das etapas anteriores: `docs/historico/` (patches de referência, não fazem parte da execução). Procedimento de medição em celular e análise de PWA/APK: [`MEDICAO_E_PWA.md`](MEDICAO_E_PWA.md).

## PWA: o que funciona offline

O service worker guarda **só a casca** (HTML, CSS, JS do app, manifesto e ícones). Sem internet a página abre e mostra que a biblioteca de detecção não carregou; **a análise não funciona offline**, porque o TensorFlow.js, o COCO-SSD e os pesos vêm da rede e não são guardados. Ao publicar uma versão nova, altere `VERSAO` em `sw.js`.

## Limitações conhecidas

- Nenhuma medição em aparelho real foi feita (latência, FPS, bateria, aquecimento): ver `MEDICAO_E_PWA.md`.
- O COCO-SSD não reconhece parede, porta, palete, carrinho, degrau ou buraco.
- Limiares (`LIM`) são provisórios e não calibrados em campo.
- Voz, vibração de câmera, rotação do aparelho e interrupções do sistema (chamada, tela bloqueada) precisam de verificação manual no celular.
