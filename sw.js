'use strict';
/*
 * Service worker do VisioIndústria: cache SÓ da casca do aplicativo (mesma origem), com versão.
 * - Rede primeiro: com internet, sempre a versão publicada mais nova; o cache só responde quando a rede falha.
 * - Bibliotecas do CDN e pesos do modelo NÃO passam por aqui (outra origem): a detecção exige internet e isso não é escondido.
 * - Nenhuma imagem da câmera passa por fetch; nada além dos arquivos listados em CASCA é guardado.
 * Ao publicar uma versão nova, troque VERSAO: a ativação apaga os caches antigos deste app.
 */
const VERSAO = 'visioindustria-casca-v1';
const CASCA = ['index.html', 'visioindustria.html', 'css/visioindustria.css', 'js/nucleo.js', 'js/app.js', 'js/pwa.js',
  'manifest.webmanifest', 'icones/icone.svg', 'icones/icone-192.png', 'icones/icone-512.png'];
const caminhosCasca = () => new Set(CASCA.map(c => new URL(c, self.registration ? self.registration.scope : self.location.href).pathname));

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSAO).then(c => c.addAll(CASCA)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('visioindustria-') && k !== VERSAO).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', ev => {
  const req = ev.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !caminhosCasca().has(url.pathname)) return;   // o navegador trata normalmente
  ev.respondWith(fetch(req).then(r => {
    if (r && r.ok){ const copia = r.clone(); ev.waitUntil(caches.open(VERSAO).then(c => c.put(req, copia))); }
    return r;
  }).catch(() => caches.match(req, {ignoreSearch:true}).then(r => r || Response.error())));
});
