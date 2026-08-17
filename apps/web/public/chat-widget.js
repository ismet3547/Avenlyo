/* global document, fetch, URL, window */

(function () {
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-avenlyo-key');
  if (!key) return;
  var api = script.getAttribute('data-avenlyo-api-url') || 'https://api.avenlyo.com';
  var source = new URL(script.src, window.location.href);
  fetch(api + '/v1/chat/session', {
    body: JSON.stringify({ widgetPublicKey: key }),
    headers: { 'Content-Type': 'text/plain' },
    method: 'POST',
  })
    .then(function (response) {
      return response.ok ? response.json() : Promise.reject(new Error('session'));
    })
    .then(function (session) {
      var frame = document.createElement('iframe');
      frame.title = 'Chat with us';
      // Keep the bearer token out of iframe URLs, browser history, referrers, and server logs.
      frame.src =
        source.origin +
        '/chat/widget?api=' +
        encodeURIComponent(api) +
        '&parentOrigin=' +
        encodeURIComponent(window.location.origin);
      frame.style.cssText =
        'position:fixed;right:20px;bottom:20px;width:360px;height:520px;border:0;border-radius:16px;box-shadow:0 12px 36px rgba(15,23,42,.25);z-index:2147483647;background:#fff';
      frame.addEventListener('load', function () {
        frame.contentWindow.postMessage(
          {
            type: 'avenlyo.chat.initialize',
            token: session.token,
            welcomeMessage: session.welcomeMessage || '',
          },
          source.origin,
        );
      });
      document.body.appendChild(frame);
    })
    .catch(function () {
      // Embed setup deliberately fails closed without exposing an internal error to site visitors.
    });
})();
