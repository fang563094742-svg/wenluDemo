(function (global) {
  function firstNonEmptyString(values) {
    var list = Array.isArray(values) ? values : [];
    for (var i = 0; i < list.length; i += 1) {
      var value = list[i];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  function isProbablyImageUrl(value) {
    var text = String(value || '').trim();
    if (!text) return false;
    return /^data:image\//i.test(text) || /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(text);
  }

  function isProbablyUrl(value) {
    var text = String(value || '').trim();
    if (!text) return false;
    return /^(https?:)?\/\//i.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text) || text.charAt(0) === '/';
  }

  function toQrDataUrl(text, options) {
    var payload = String(text || '').trim();
    if (!payload) return '';
    try {
      if (global.WenluQRCode && typeof global.WenluQRCode.toDataUrl === 'function') {
        return global.WenluQRCode.toDataUrl(payload, Object.assign({
          cellSize: 8,
          margin: 4,
          darkColor: '#111827',
          lightColor: '#ffffff'
        }, options || {}));
      }
    } catch (_) {}
    return '';
  }


  function getPendingOrderStatusText() {
    return '订单已创建，请扫码支付';
  }

  function buildCopyText(parts) {
    var lines = [];
    var items = Array.isArray(parts) ? parts : [];
    for (var i = 0; i < items.length; i += 1) {
      var value = String(items[i] || '').trim();
      if (value) lines.push(value);
    }
    return lines.join('\n');
  }

  global.WenluPayment = Object.assign({}, global.WenluPayment || {}, {
    firstNonEmptyString: firstNonEmptyString,
    isProbablyImageUrl: isProbablyImageUrl,
    isProbablyUrl: isProbablyUrl,
    toQrDataUrl: toQrDataUrl,
    buildCopyText: buildCopyText,
    getPendingOrderStatusText: getPendingOrderStatusText
  });
})(typeof window !== 'undefined' ? window : globalThis);
