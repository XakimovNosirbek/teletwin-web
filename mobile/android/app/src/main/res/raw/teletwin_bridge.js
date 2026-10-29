// TeleTwin Android shell bridge. Injected at document start into https://dtwin.uz pages only.
// Android WebView has no Notification API and no download manager for blob/service-worker URLs,
// so both are forwarded to the native app through an origin-restricted message channel.
(function () {
  var nativeBridge = window.TeleTwinNative;
  if (!nativeBridge || window.__teletwinBridgeInstalled) return;
  window.__teletwinBridgeInstalled = true;

  var CHUNK_SIZE = 512 * 1024;
  var MAX_ACTIVE = 200;
  var permission = 'default';
  var permissionWaiters = [];
  var activeNotifications = {};
  var activeIds = [];
  var nextId = 1;
  // Notification ids restart on every page load; the session keeps a stale tap from hitting a new page.
  var session = Math.random().toString(36).slice(2);

  function send(message) {
    try {
      nativeBridge.postMessage(JSON.stringify(message));
    } catch (e) {
      // The channel is gone (page is unloading).
    }
  }

  nativeBridge.onmessage = function (event) {
    var message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (message.type === 'permission') {
      permission = message.value;
      var waiters = permissionWaiters;
      permissionWaiters = [];
      waiters.forEach(function (resolve) { resolve(permission); });
    } else if (message.type === 'notification-click') {
      if (message.session !== session) return;
      var notification = activeNotifications[message.id];
      if (!notification) return;
      forget(message.id);
      var clickEvent = new Event('click');
      if (typeof notification.onclick === 'function') notification.onclick.call(notification, clickEvent);
      notification.dispatchEvent(clickEvent);
    }
  };

  function forget(id) {
    delete activeNotifications[id];
    var index = activeIds.indexOf(id);
    if (index >= 0) activeIds.splice(index, 1);
  }

  class TeleTwinNotification extends EventTarget {
    constructor(title, options) {
      super();
      options = options || {};
      this.title = String(title);
      this.body = options.body ? String(options.body) : '';
      this.tag = options.tag ? String(options.tag) : '';
      this.icon = options.icon || '';
      this.data = options.data;
      this.silent = Boolean(options.silent);
      this.onclick = null;
      this.onshow = null;
      this.onclose = null;
      this.onerror = null;
      this._id = nextId++;

      activeNotifications[this._id] = this;
      activeIds.push(this._id);
      if (activeIds.length > MAX_ACTIVE) forget(activeIds[0]);

      // `onshow` is not fired on purpose: the web app plays its own sound there,
      // while the Android notification channel already plays the system sound.
      send({
        type: 'notification-show',
        session: session,
        id: this._id,
        title: this.title,
        body: this.body,
        tag: this.tag,
        silent: this.silent,
      });
    }

    close() {
      forget(this._id);
      send({ type: 'notification-close', session: session, id: this._id });
      var closeEvent = new Event('close');
      if (typeof this.onclose === 'function') this.onclose.call(this, closeEvent);
      this.dispatchEvent(closeEvent);
    }

    static get permission() {
      return permission;
    }

    static requestPermission(callback) {
      return new Promise(function (resolve) {
        permissionWaiters.push(function (value) {
          if (typeof callback === 'function') callback(value);
          resolve(value);
        });
        send({ type: 'notification-request-permission' });
      });
    }
  }
  TeleTwinNotification.maxActions = 0;

  Object.defineProperty(window, 'Notification', {
    value: TeleTwinNotification,
    configurable: true,
    writable: true,
  });
  // Web Push needs Google services that WebView does not provide; without PushManager the web app
  // falls back to `new Notification(...)`, which is the native bridge above.
  try {
    delete window.PushManager;
  } catch (e) {
    // Ignore
  }

  // Downloads: the web app saves files through `<a download>.click()` on blob: or service-worker URLs.
  // The page fetches the bytes (so the service worker still serves them) and streams them to native.
  var nextDownloadId = 1;

  function toBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function saveToDevice(url, filename) {
    var id = nextDownloadId++;
    return fetch(url)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.blob();
      })
      .then(function (blob) {
        send({
          type: 'download-start',
          id: id,
          name: filename || 'file',
          mime: blob.type || 'application/octet-stream',
          size: blob.size,
        });
        var offset = 0;
        function next() {
          if (offset >= blob.size) {
            send({ type: 'download-end', id: id });
            return undefined;
          }
          var part = blob.slice(offset, offset + CHUNK_SIZE);
          offset += CHUNK_SIZE;
          return part.arrayBuffer().then(function (buffer) {
            send({ type: 'download-chunk', id: id, data: toBase64(new Uint8Array(buffer)) });
            return next();
          });
        }
        return next();
      })
      .catch(function (error) {
        send({ type: 'download-error', id: id, name: filename || 'file', message: String(error) });
      });
  }

  var originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = this.href;
    if (this.hasAttribute('download') && href && /^(blob:|data:|https:\/\/dtwin\.uz\/)/.test(href)) {
      saveToDevice(href, this.getAttribute('download'));
      return;
    }
    originalClick.call(this);
  };

  send({ type: 'init' });
})();
