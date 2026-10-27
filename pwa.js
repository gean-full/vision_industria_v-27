'use strict';
// Registro do service worker (sw.js). Ele guarda só a "casca" do aplicativo (HTML, CSS, JS do app, manifesto e ícones) para a instalação e para
// a página abrir mesmo sem rede. NÃO guarda o TensorFlow.js, o COCO-SSD nem os pesos do modelo: sem internet a página abre, mas a detecção
// não funciona, e a página diz isso (aviso "Sem a biblioteca de detecção").
(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('VisioIndústria: service worker não registrado:', e && e.message));
  });
})();
