(function () {
  var TOKEN_KEY = 'auth_token';
  var REFRESH_TOKEN_KEY = 'auth_refresh_token';
  var USER_KEY = 'auth_user';
  var EXPIRES_AT_KEY = 'auth_expires_at';
  var REFRESH_EXPIRES_AT_KEY = 'auth_refresh_expires_at';
  var SESSION_ID_KEY = 'auth_session_id';
  var AUTO_REFRESH_TIMER = null;
  var AUTO_REFRESH_LEAD_MS = 60 * 1000;
  var MAX_TIMEOUT_MS = 2147483647;
  var ORDER_POLL_TIMER = null;
  var ORDER_POLL_INTERVAL_MS = 8000;
  var ORDER_POLL_ENABLED = true;
  var ORDER_POLL_IN_FLIGHT = false;
  var ORDER_AUTO_RECONCILE_ENABLED = true;
  var ORDER_AUTO_RECONCILE_COOLDOWN_MS = 20000;
  var ORDER_RECONCILE_LAST_ATTEMPT = Object.create(null);
  var ORDER_RECONCILE_IN_FLIGHT = Object.create(null);
  var ORDER_LAST_SWEEP_SUMMARY = null;
  var PASSWORD_PUBLIC_KEY_CACHE = null;
  var PASSWORD_PUBLIC_KEY_PROMISE = null;
  var PASSWORD_CRYPTO_KEY_CACHE = null;
  var memoryStorage = Object.create(null);
  var captchaInstance = null;
  var captchaConfig = null;
  var captchaLoading = null;
  var captchaChallengeLoading = null;
  var captchaReady = false;
  var captchaChecking = false;
  var captchaVerified = false;
  var captchaTicket = '';
  var captchaKey = '';
  var captchaValue = '';
  var captchaVerifiedAt = '';
  var captchaLastError = null;
  var captchaModalState = null;
  var pendingAuthSubmit = null;

  function $(id) {
    return document.getElementById(id);
  }

  function on(el, eventName, handler, options) {
    if (!el || typeof el.addEventListener !== 'function' || typeof handler !== 'function') return false;
    el.addEventListener(eventName, handler, options);
    return true;
  }

  function setText(id, value) {
    var el = $(id);
    if (!el) return null;
    el.textContent = value == null ? '' : String(value);
    return el;
  }

  function toggleHidden(el, hidden) {
    if (!el || !el.classList) return;
    el.classList[hidden ? 'add' : 'remove']('hidden');
  }

  function safeParse(json, fallback) {
    try {
      return json ? JSON.parse(json) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function getStorage() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage;
      }
    } catch (_) {}
    return null;
  }

  function storageGet(key) {
    var storage = getStorage();
    if (storage) {
      try {
        return storage.getItem(key) || '';
      } catch (_) {}
    }
    return Object.prototype.hasOwnProperty.call(memoryStorage, key) ? memoryStorage[key] : '';
  }

  function storageSet(key, value) {
    var normalized = value == null ? '' : String(value);
    var storage = getStorage();
    if (storage) {
      try {
        storage.setItem(key, normalized);
        return;
      } catch (_) {}
    }
    memoryStorage[key] = normalized;
  }

  function storageRemove(key) {
    var storage = getStorage();
    if (storage) {
      try {
        storage.removeItem(key);
      } catch (_) {}
    }
    delete memoryStorage[key];
  }

  function getToken() {
    return storageGet(TOKEN_KEY);
  }

  function getUser() {
    return safeParse(storageGet(USER_KEY), null);
  }

  function getRefreshToken() {
    return storageGet(REFRESH_TOKEN_KEY);
  }

  function getExpiresAt() {
    return storageGet(EXPIRES_AT_KEY);
  }

  function getRefreshExpiresAt() {
    return storageGet(REFRESH_EXPIRES_AT_KEY);
  }

  function normalizeUserPayload(payload) {
    if (!payload) return null;
    return payload.user || payload.data || payload;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char];
    });
  }

  function normalizeAuthPayload(payload) {
    if (!payload) return null;
    var data = payload.data || payload;
    return {
      token: data.accessToken || data.token || '',
      accessToken: data.accessToken || data.token || '',
      refreshToken: data.refreshToken || '',
      expiresAt: data.expiresAt || '',
      refreshExpiresAt: data.refreshExpiresAt || '',
      sessionId: data.sessionId || '',
      user: normalizeUserPayload(data.user || data.profile || data)
    };
  }

  function saveAuth(payload) {
    var normalized = normalizeAuthPayload(payload);
    if (!normalized) return;
    storageSet(TOKEN_KEY, normalized.accessToken || normalized.token || '');
    if (normalized.refreshToken) storageSet(REFRESH_TOKEN_KEY, normalized.refreshToken);
    if (normalized.user) storageSet(USER_KEY, JSON.stringify(normalized.user));
    if (normalized.expiresAt) storageSet(EXPIRES_AT_KEY, normalized.expiresAt);
    if (normalized.refreshExpiresAt) storageSet(REFRESH_EXPIRES_AT_KEY, normalized.refreshExpiresAt);
    if (normalized.sessionId) storageSet(SESSION_ID_KEY, normalized.sessionId);
    scheduleTokenRefresh();
  }

  function clearAuth() {
    storageRemove(TOKEN_KEY);
    storageRemove(REFRESH_TOKEN_KEY);
    storageRemove(USER_KEY);
    storageRemove(EXPIRES_AT_KEY);
    storageRemove(REFRESH_EXPIRES_AT_KEY);
    storageRemove(SESSION_ID_KEY);
    if (AUTO_REFRESH_TIMER) {
      clearTimeout(AUTO_REFRESH_TIMER);
      AUTO_REFRESH_TIMER = null;
    }
  }

  function hasFutureIso(value) {
    if (!value) return false;
    var t = new Date(value).getTime();
    return Number.isFinite(t) && t > Date.now();
  }

  async function request(url, options) {
    var opts = options || {};
    var rawHeaders = opts.headers || {};
    var hasExplicitAuthHeader =
      Object.prototype.hasOwnProperty.call(rawHeaders, 'Authorization') ||
      Object.prototype.hasOwnProperty.call(rawHeaders, 'authorization');
    var headers = Object.assign({ 'Content-Type': 'application/json' }, rawHeaders);
    var token = getToken();
    if (token && !hasExplicitAuthHeader) headers.Authorization = 'Bearer ' + token;
    if (headers.Authorization === '') delete headers.Authorization;
    if (headers.authorization === '') delete headers.authorization;

    var response = null;
    try {
      response = await fetch(url, Object.assign({}, opts, {
        headers: headers,
        credentials: opts.credentials || 'include'
      }));
    } catch (error) {
      var networkError = error instanceof Error ? error : new Error('网络请求失败，请稍后重试');
      networkError.isNetworkError = true;
      throw networkError;
    }
    var data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      var message = data && (data.error || data.message) ? (data.error || data.message) : '请求失败，请稍后重试';
      var requestError = new Error(message);
      requestError.status = response.status;
      requestError.response = data;
      throw requestError;
    }
    return data;
  }

  function getWebCryptoSubtle() {
    if (typeof window === 'undefined' || !window.crypto) return null;
    return window.crypto.subtle || window.crypto.webkitSubtle || null;
  }

  function supportsPasswordEncryption() {
    return !!(getWebCryptoSubtle() && typeof window.TextEncoder === 'function' && typeof window.atob === 'function' && typeof window.btoa === 'function');
  }

  function normalizePasswordPublicKeyResponse(payload) {
    var source = payload && payload.key
      ? payload.key
      : payload && payload.data && payload.data.key
        ? payload.data.key
        : payload && payload.data
          ? payload.data
          : payload;

    if (!source || typeof source !== 'object') return null;

    return {
      enabled: source.enabled !== false,
      algorithm: typeof source.algorithm === 'string' ? source.algorithm : '',
      keyId: typeof source.keyId === 'string' ? source.keyId.trim() : '',
      spkiBase64: typeof source.spkiBase64 === 'string' ? source.spkiBase64.trim() : '',
      publicKeyPem: typeof source.publicKeyPem === 'string' ? source.publicKeyPem : ''
    };
  }

  async function fetchPasswordPublicKey(forceRefresh) {
    if (!forceRefresh && PASSWORD_PUBLIC_KEY_CACHE) {
      return PASSWORD_PUBLIC_KEY_CACHE;
    }
    if (!forceRefresh && PASSWORD_PUBLIC_KEY_PROMISE) {
      return PASSWORD_PUBLIC_KEY_PROMISE;
    }

    PASSWORD_PUBLIC_KEY_PROMISE = request('/api/auth/password/public-key', {
      method: 'GET',
      headers: { Authorization: '' }
    }).then(function (result) {
      var normalized = normalizePasswordPublicKeyResponse(result);
      PASSWORD_PUBLIC_KEY_CACHE = normalized;
      return normalized;
    }).finally(function () {
      PASSWORD_PUBLIC_KEY_PROMISE = null;
    });

    return PASSWORD_PUBLIC_KEY_PROMISE;
  }

  function base64ToUint8Array(base64) {
    var normalized = String(base64 || '').replace(/\s+/g, '');
    if (!normalized) return new Uint8Array(0);
    var binary = window.atob(normalized);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function arrayBufferToBase64(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  async function importPasswordCryptoKey(keyInfo) {
    var subtle = getWebCryptoSubtle();
    if (!subtle || !keyInfo || !keyInfo.spkiBase64) return null;

    var cacheKey = keyInfo.keyId || keyInfo.spkiBase64;
    if (PASSWORD_CRYPTO_KEY_CACHE && PASSWORD_CRYPTO_KEY_CACHE.cacheKey === cacheKey && PASSWORD_CRYPTO_KEY_CACHE.cryptoKey) {
      return PASSWORD_CRYPTO_KEY_CACHE.cryptoKey;
    }

    var sourceBytes = base64ToUint8Array(keyInfo.spkiBase64);
    if (!sourceBytes.length) return null;
    var importBytes = new Uint8Array(sourceBytes.length);
    importBytes.set(sourceBytes);

    var cryptoKey = await subtle.importKey(
      'spki',
      importBytes.buffer,
      {
        name: 'RSA-OAEP',
        hash: 'SHA-256'
      },
      false,
      ['encrypt']
    );

    PASSWORD_CRYPTO_KEY_CACHE = {
      cacheKey: cacheKey,
      cryptoKey: cryptoKey
    };
    return cryptoKey;
  }

  async function encryptPasswordWithPublicKey(password, keyInfo) {
    if (!supportsPasswordEncryption()) return '';
    if (!keyInfo || keyInfo.enabled === false) return '';
    if (keyInfo.algorithm && keyInfo.algorithm !== 'RSA-OAEP-256') return '';

    var cryptoKey = await importPasswordCryptoKey(keyInfo);
    if (!cryptoKey) return '';

    var subtle = getWebCryptoSubtle();
    var encoded = new window.TextEncoder().encode(String(password || ''));
    var encrypted = await subtle.encrypt({ name: 'RSA-OAEP' }, cryptoKey, encoded);
    return arrayBufferToBase64(encrypted);
  }

  async function buildPasswordProtectedPayload(payload, password, options) {
    var prepared = {
      payload: Object.assign({}, payload),
      usedEncryption: false,
      keyEnabled: false,
      keyId: ''
    };

    if (!supportsPasswordEncryption()) {
      return prepared;
    }

    var keyInfo = null;
    try {
      keyInfo = await fetchPasswordPublicKey(!!(options && options.forceRefreshKey));
    } catch (error) {
      console.warn('[auth] failed to fetch password public key, fallback to plaintext password', error);
      return prepared;
    }

    if (!keyInfo || keyInfo.enabled === false) {
      return prepared;
    }

    prepared.keyEnabled = true;
    prepared.keyId = keyInfo.keyId || '';

    try {
      var encrypted = await encryptPasswordWithPublicKey(password, keyInfo);
      if (!encrypted) return prepared;
      delete prepared.payload.password;
      prepared.payload.passwordEncrypted = encrypted;
      if (prepared.keyId) {
        prepared.payload.passwordKeyId = prepared.keyId;
      }
      prepared.usedEncryption = true;
      return prepared;
    } catch (error) {
      console.warn('[auth] failed to encrypt password with public key, fallback to plaintext password', error);
      return prepared;
    }
  }

  function shouldRetryWithFreshPasswordKey(error, prepared) {
    if (!prepared || !prepared.usedEncryption || !prepared.keyEnabled || !error) return false;
    if (error.status !== 400) return false;
    var message = String(error.message || '');
    return message.indexOf('密钥已更新') >= 0
      || message.indexOf('密码加密密钥') >= 0
      || message.indexOf('PASSWORD_KEY_ID_MISMATCH') >= 0;
  }

  async function refreshAccessToken() {
    var refreshToken = getRefreshToken();
    try {
      var body = refreshToken ? { refreshToken: refreshToken } : {};
      var refreshed = await request('/api/auth/refresh', {
        method: 'POST',
        headers: { Authorization: '' },
        body: JSON.stringify(body)
      });
      saveAuth(refreshed);
      return normalizeUserPayload(refreshed && (refreshed.user || refreshed.data && refreshed.data.user)) || getUser();
    } catch (_) {
      clearAuth();
      return null;
    }
  }

  function scheduleTokenRefresh() {
    if (AUTO_REFRESH_TIMER) {
      clearTimeout(AUTO_REFRESH_TIMER);
      AUTO_REFRESH_TIMER = null;
    }
    var expiresAt = getExpiresAt();
    if (!expiresAt) return;
    var ms = new Date(expiresAt).getTime() - Date.now() - AUTO_REFRESH_LEAD_MS;
    if (!Number.isFinite(ms)) return;
    if (ms > MAX_TIMEOUT_MS) {
      AUTO_REFRESH_TIMER = window.setTimeout(function () {
        scheduleTokenRefresh();
      }, MAX_TIMEOUT_MS);
      return;
    }
    AUTO_REFRESH_TIMER = window.setTimeout(function () {
      refreshAccessToken();
    }, Math.max(ms, 0));
  }

  function isAuthError(error) {
    return !!(error && (error.status === 401 || error.status === 403));
  }

  async function validateToken() {
    var cachedUser = getUser();
    try {
      var me = await request('/api/auth/me', { method: 'GET' });
      var user = Object.assign({}, cachedUser || {}, normalizeUserPayload(me) || {});
      storageSet(USER_KEY, JSON.stringify(user));
      scheduleTokenRefresh();
      return user;
    } catch (error) {
      if (isAuthError(error)) {
        return refreshAccessToken();
      }
      if (cachedUser) {
        scheduleTokenRefresh();
        return cachedUser;
      }
      throw error;
    }
  }

  function redirect(url) {
    window.location.replace(url);
  }

  function setStatus(element, message, type) {
    if (!element) return;
    element.textContent = message || '';
    element.className = 'status' + (type ? ' ' + type : '');
  }

  function setButtonLoading(button, loadingText, isLoading) {
    if (!button) return;
    if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
    button.dataset.loading = isLoading ? 'true' : 'false';
    button.disabled = !!isLoading;
    button.textContent = isLoading ? loadingText : button.dataset.defaultText;
  }

  function isCaptchaModalOpen() {
    return !!(typeof document !== 'undefined' && document.body && document.body.classList.contains('captcha-modal-open'));
  }

  function getCaptchaFieldElement(containerEl) {
    return containerEl && typeof containerEl.closest === 'function' ? containerEl.closest('.captcha-field') : null;
  }

  function queuePendingAuthSubmit(handler) {
    pendingAuthSubmit = typeof handler === 'function' ? handler : null;
  }

  function consumePendingAuthSubmit() {
    if (typeof pendingAuthSubmit !== 'function') return false;
    var runner = pendingAuthSubmit;
    pendingAuthSubmit = null;
    window.setTimeout(function () {
      runner();
    }, 120);
    return true;
  }

  function ensureCaptchaModalState(mode, statusEl, containerEl, submitBtn) {
    var state = captchaModalState || {};
    state.mode = mode;
    state.fieldEl = getCaptchaFieldElement(containerEl) || state.fieldEl || null;
    state.closeBtn = $('captcha-close-btn') || state.closeBtn || null;
    captchaModalState = state;

    if (state.closeBtn && !state.closeBtn.__wenluBound) {
      state.closeBtn.__wenluBound = true;
      on(state.closeBtn, 'click', function () {
        closeCaptchaModal(mode, statusEl, containerEl, submitBtn, true);
      });
    }

    if (typeof document !== 'undefined' && !document.__wenluCaptchaEscBound) {
      document.__wenluCaptchaEscBound = true;
      on(document, 'keydown', function (event) {
        if (!event || event.key !== 'Escape' || !isCaptchaModalOpen()) return;
        var modal = captchaModalState || {};
        closeCaptchaModal(modal.mode || mode, statusEl, containerEl, submitBtn, true);
      });
    }

    return state;
  }

  function openCaptchaModal(mode, statusEl, containerEl, submitBtn) {
    if (typeof document === 'undefined' || !document.body) return;
    var state = ensureCaptchaModalState(mode, statusEl, containerEl, submitBtn);
    if (state.fieldEl) {
      state.fieldEl.setAttribute('aria-hidden', 'false');
    }
    document.body.classList.add('captcha-modal-open');
    syncAuthSubmitButton(submitBtn, mode);
  }

  function closeCaptchaModal(mode, statusEl, containerEl, submitBtn, userInitiated) {
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('captcha-modal-open');
    }
    var state = ensureCaptchaModalState(mode, statusEl, containerEl, submitBtn);
    if (state.fieldEl) {
      state.fieldEl.setAttribute('aria-hidden', 'true');
    }
    if (userInitiated) {
      pendingAuthSubmit = null;
      resetCaptchaVerification();
      captchaReady = false;
      setCaptchaShellState(containerEl, 'loading');
      setStatus(statusEl, '你已关闭安全验证，请重新点击' + (mode === 'register' ? '注册' : '登录') + '。', 'info');
    }
    syncAuthSubmitButton(submitBtn, mode);
  }

  function clearOrderPolling() {
    if (ORDER_POLL_TIMER) {
      clearTimeout(ORDER_POLL_TIMER);
      ORDER_POLL_TIMER = null;
    }
  }

  function stashOrderSweepSummary(summary) {
    ORDER_LAST_SWEEP_SUMMARY = summary && typeof summary === 'object' ? summary : null;
  }

  function takeOrderSweepSummary() {
    var summary = ORDER_LAST_SWEEP_SUMMARY;
    ORDER_LAST_SWEEP_SUMMARY = null;
    return summary;
  }

  function getSweepCreditedCount(summary) {
    return summary && Number.isFinite(Number(summary.autoCredited)) ? Number(summary.autoCredited) : 0;
  }

  function getSweepReviewCount(summary) {
    return summary && Number.isFinite(Number(summary.reviewRequired)) ? Number(summary.reviewRequired) : 0;
  }

  function isAutoReconcileStatus(status) {
    var normalized = String(status || 'pending');
    return normalized === 'pending' || normalized === 'review_required' || normalized === 'paid';
  }

  function hasPendingOrder(orders) {
    return Array.isArray(orders) && orders.some(function (order) {
      var status = order && order.status ? String(order.status) : 'pending';
      return isAutoReconcileStatus(status);
    });
  }

  function canAutoReconcileOrder(order) {
    if (!ORDER_AUTO_RECONCILE_ENABLED || !order || !order.id) return false;
    if (!isAutoReconcileStatus(order.status)) return false;
    if (ORDER_RECONCILE_IN_FLIGHT[order.id]) return false;
    var lastAttempt = Number(ORDER_RECONCILE_LAST_ATTEMPT[order.id] || 0);
    return !lastAttempt || (Date.now() - lastAttempt) >= ORDER_AUTO_RECONCILE_COOLDOWN_MS;
  }

  async function autoReconcileOrders(orders, statusEl) {
    var candidates = Array.isArray(orders) ? orders.filter(canAutoReconcileOrder).slice(0, 2) : [];
    if (!candidates.length) {
      return { attempted: 0, changed: false, credited: 0, review: 0 };
    }

    var summary = { attempted: 0, changed: false, credited: 0, review: 0 };
    for (var i = 0; i < candidates.length; i += 1) {
      var order = candidates[i];
      if (!order || !order.id) continue;
      ORDER_RECONCILE_IN_FLIGHT[order.id] = true;
      ORDER_RECONCILE_LAST_ATTEMPT[order.id] = Date.now();
      summary.attempted += 1;
      try {
        var result = await reconcileRemoteOrder(order.id);
        if (result && (result.autoCredited || result.paid || result.needsManualReview || result.matched)) {
          summary.changed = true;
        }
        if (result && result.autoCredited) summary.credited += 1;
        if (result && result.needsManualReview) summary.review += 1;
      } catch (error) {
        if (statusEl && error && error.message && error.status !== 404 && error.status !== 401) {
          setStatus(statusEl, '自动核单暂时失败：' + error.message, 'info');
        }
      } finally {
        delete ORDER_RECONCILE_IN_FLIGHT[order.id];
      }
    }

    return summary;
  }

  function updateOrderPollBadge(active, message) {
    var badge = $('orders-poll-badge');
    var toggle = $('toggle-orders-poll-btn');
    if (badge) {
      badge.textContent = message || (active ? '轮询运行中' : '轮询已关闭');
      badge.className = 'poll-badge' + (active ? ' active' : '');
    }
    if (toggle) {
      toggle.textContent = ORDER_POLL_ENABLED ? '关闭轮询' : '开启轮询';
    }
  }

  function formatDate(value) {
    if (!value) return '-';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { hour12: false });
  }


  var DEFAULT_MEMBERSHIP_PLANS = [
    {
      id: 'free',
      name: '免费体验',
      price_cents: 0,
      duration_days: 0,
      features: { max_sessions: 1, max_messages_per_day: 10, features: ['基础对话'] }
    },
    {
      id: 'member',
      name: '会员',
      price_cents: 300,
      duration_days: 1,
      features: { max_sessions: -1, max_messages_per_day: -1, features: ['深度扫描', '记忆能力', '主动执行'] }
    },
    {
      id: 'monthly',
      name: '月度会员',
      price_cents: 2900,
      duration_days: 30,
      features: { max_sessions: 10, max_messages_per_day: 100, features: ['深度扫描', '记忆能力', '主动执行'] }
    },
    {
      id: 'yearly',
      name: '年度会员',
      price_cents: 19900,
      duration_days: 365,
      features: { max_sessions: -1, max_messages_per_day: -1, features: ['深度扫描', '记忆能力', '主动执行', '优先响应'] }
    }
  ];

  function formatPrice(cents) {
    var num = Number(cents || 0);
    return '¥' + (num / 100).toFixed(2);
  }

  function normalizeMembership(user) {
    return user && user.membership ? user.membership : null;
  }

  function getOrderStorageKey(userId) {
    return 'wenlu_membership_orders_' + (userId || 'guest');
  }

  function readLocalOrders(userId) {
    return safeParse(storageGet(getOrderStorageKey(userId)), []);
  }

  function saveLocalOrders(userId, orders) {
    storageSet(getOrderStorageKey(userId), JSON.stringify(orders || []));
  }

  async function fetchPaymentOptionsSafe() {
    try {
      var result = await request('/api/payment-options', { method: 'GET', headers: { Authorization: '' } });
      var options = result && result.options ? result.options : {};
      try {
        var plansResult = await request('/api/payments/plans', { method: 'GET' });
        if (plansResult && Array.isArray(plansResult.plans)) {
          options.plans = plansResult.plans;
        }
        if (plansResult && plansResult.checkout && !options.merchant) {
          options.merchant = plansResult.checkout;
        }
      } catch (_) {}
      return options;
    } catch (_) {
      try {
        var fallbackPlansResult = await request('/api/payments/plans', { method: 'GET' });
        return {
          plans: fallbackPlansResult && Array.isArray(fallbackPlansResult.plans) ? fallbackPlansResult.plans : DEFAULT_MEMBERSHIP_PLANS.slice(),
          merchant: fallbackPlansResult && fallbackPlansResult.checkout ? fallbackPlansResult.checkout : null
        };
      } catch (_) {
        return null;
      }
    }
  }

  async function fetchOrdersSafe(options) {
    try {
      var query = [];
      if (options && options.autoReconcile) query.push('autoReconcile=1');
      var suffix = query.length ? ('?' + query.join('&')) : '';
      var result = await request('/api/payments/orders' + suffix, { method: 'GET' });
      stashOrderSweepSummary(result && result.autoReconcile ? result.autoReconcile : null);
      if (result && Array.isArray(result.orders)) return result.orders;
      return [];
    } catch (_) {
      stashOrderSweepSummary(null);
      return null;
    }
  }

  async function fetchOrderDetail(orderId, options) {
    if (!orderId) return null;
    var query = [];
    if (options && options.refresh) query.push('refresh=1');
    if (options && options.extractQr) query.push('extractQr=1');
    var suffix = query.length ? ('?' + query.join('&')) : '';
    var result = await request('/api/payments/orders/' + encodeURIComponent(orderId) + suffix, {
      method: 'GET'
    });
    return result || null;
  }

  async function createRemoteOrder(input) {
    var result = await request('/api/payments/orders', {
      method: 'POST',
      body: JSON.stringify(input)
    });
    return result || null;
  }

  async function reconcileRemoteOrder(orderId) {
    var result = await request('/api/payments/orders/' + encodeURIComponent(orderId) + '/reconcile', {
      method: 'POST',
      body: JSON.stringify({})
    });
    return result && result.result ? result.result : result;
  }

  function normalizeOrderStatusLabel(status) {
    return ({
      pending: '订单已创建，请扫码支付',
      paid: '已支付，待到账确认',
      fulfilled: '已开通/已发放',
      review_required: '待人工复核',
      cancelled: '已取消',
      expired: '已过期'
    })[status] || (status || '未知');
  }

  function getFriendlyAuthErrorMessage(error, mode) {
    var fallback = mode === 'register' ? '注册失败，请稍后重试。' : '登录失败，请检查账号密码后重试。';
    if (!error) return fallback;
    if (error.isNetworkError) return '网络连接失败，请确认服务已启动后再重试。';
    var raw = String(error.message || '').trim();
    var lower = raw.toLowerCase();
    var status = error.status;
    if (mode === 'login' && raw.indexOf('用户名或密码错误') >= 0) {
      return '用户名或密码错误，请确认填写的是注册时设置的用户名。';
    }
    if (mode === 'login' && raw.indexOf('用户名不能为空') >= 0) {
      return '请输入注册时设置的用户名。';
    }
    if (raw && (/[用户名账号密码]/.test(raw) || raw.indexOf('验证码') >= 0 || raw.indexOf('账号') >= 0)) return raw;
    if (status === 429) return raw || '请求过于频繁，请稍候 1 分钟后再试。';
    if (status >= 500) return raw || '服务端处理失败，请稍后再试。';
    if (lower.indexOf('password') >= 0 && lower.indexOf('incorrect') >= 0) return '用户名或密码错误，请确认填写的是注册时设置的用户名。';
    if (lower.indexOf('invalid credentials') >= 0) return '用户名或密码错误，请确认填写的是注册时设置的用户名。';
    if (lower.indexOf('user not found') >= 0 || lower.indexOf('not found') >= 0) return raw || '账号不存在，请先注册或确认用户名。';
    if (lower.indexOf('already exists') >= 0 || lower.indexOf('duplicate') >= 0) return raw || '该用户名已被占用，请更换后重试。';
    if (lower.indexOf('geetest') >= 0 || lower.indexOf('captcha') >= 0 || raw.indexOf('极验') >= 0 || raw.indexOf('验证码') >= 0) return raw || '安全验证失败，请重新完成验证码。';
    if (status === 400 && mode === 'login') return raw || '登录信息不完整或格式不正确，请检查用户名和 8-72 位密码。';
    if (status === 401 || status === 403) return raw || (mode === 'login' ? '用户名或密码错误，请确认填写的是注册时设置的用户名。' : '注册校验未通过，请检查输入后重试。');
    if (status === 409) return mode === 'register' ? (raw || '该用户名已被注册，请直接登录或更换用户名。') : (raw || fallback);
    return raw || fallback;
  }

  function buildClientReferenceHint(order) {
    var ref = order && order.client_reference ? String(order.client_reference) : '';
    return ref ? ('付款时请使用联系方式：' + ref) : '';
  }

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

  function isProbablyUrl(value) {
    var text = String(value || '').trim();
    if (!text) return false;
    return /^(https?:)?\/\//i.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text) || text.charAt(0) === '/';
  }

  function copyTextToClipboard(text) {
    var value = String(text || '');
    if (!value) return Promise.resolve(false);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(value).then(function () { return true; }).catch(function () { return false; });
    }
    return new Promise(function (resolve) {
      try {
        var area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var success = false;
        try {
          success = document.execCommand('copy');
        } catch (_) {}
        document.body.removeChild(area);
        resolve(!!success);
      } catch (_) {
        resolve(false);
      }
    });
  }

  function getQueryParam(name) {
    try {
      var params = new URLSearchParams(window.location.search || '');
      return params.get(name) || '';
    } catch (_) {
      return '';
    }
  }

  function getPreferredOrder(orders, requestedId) {
    if (!Array.isArray(orders) || !orders.length) return null;
    if (requestedId) {
      for (var i = 0; i < orders.length; i += 1) {
        if (orders[i] && orders[i].id === requestedId) return orders[i];
      }
    }
    for (var j = 0; j < orders.length; j += 1) {
      var status = orders[j] && orders[j].status ? String(orders[j].status) : '';
      if (status === 'pending' || status === 'review_required' || status === 'paid') {
        return orders[j];
      }
    }
    return orders[0] || null;
  }

  function getCheckoutInfo(options) {
    if (!options) return null;
    if (options.checkout && typeof options.checkout === 'object') return options.checkout;
    if (options.merchant && typeof options.merchant === 'object') return options.merchant;
    if (options.options && options.options.merchant && typeof options.options.merchant === 'object') return options.options.merchant;
    return null;
  }

  function normalizePlanList(paymentOptions) {
    var planSource = null;
    if (Array.isArray(paymentOptions)) {
      planSource = paymentOptions;
    } else if (paymentOptions && Array.isArray(paymentOptions.plans)) {
      planSource = paymentOptions.plans;
    } else if (paymentOptions && paymentOptions.options && Array.isArray(paymentOptions.options.plans)) {
      planSource = paymentOptions.options.plans;
    }
    if (!planSource || !planSource.length) {
      return DEFAULT_MEMBERSHIP_PLANS.slice();
    }
    var normalized = planSource.map(function (plan) {
      return {
        id: plan.id || plan.planId || '',
        name: plan.name || plan.title || '未命名套餐',
        description: plan.description || plan.desc || '',
        badge_text: plan.badge_text || plan.badgeText || '',
        price_cents: Number(plan.price_cents || plan.priceCents || 0),
        duration_days: Number(plan.duration_days || plan.durationDays || 0),
        sort_order: Number(plan.sort_order || plan.sortOrder || 0),
        is_active: plan.is_active !== false && plan.isActive !== false,
        features: plan.features || {}
      };
    }).filter(function (plan) {
      return !!plan.id && plan.is_active !== false;
    }).sort(function (a, b) {
      if ((a.sort_order || 0) !== (b.sort_order || 0)) {
        return (a.sort_order || 0) - (b.sort_order || 0);
      }
      if ((a.price_cents || 0) !== (b.price_cents || 0)) {
        return (a.price_cents || 0) - (b.price_cents || 0);
      }
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
    return normalized.length ? normalized : DEFAULT_MEMBERSHIP_PLANS.slice();
  }

  function normalizePaymentSession(payload) {
    if (!payload || typeof payload !== 'object') return null;
    var source = payload.paymentSession && typeof payload.paymentSession === 'object'
      ? payload.paymentSession
      : payload;
    var qr = source.qr && typeof source.qr === 'object' ? source.qr : {};
    var raw = source.raw && typeof source.raw === 'object' ? source.raw : null;
    return {
      provider: firstNonEmptyString([source.provider, raw && raw.provider]) || 'ldxp_storefront',
      available: source.available !== false,
      status: firstNonEmptyString([source.status, raw && raw.status]) || 'pending',
      qrDataUrl: firstNonEmptyString([
        source.qrDataUrl,
        source.qr_data_url,
        qr.dataUrl,
        qr.qrDataUrl
      ]),
      paymentUrl: firstNonEmptyString([
        source.paymentUrl,
        source.payment_url,
        source.payUrl,
        source.pay_url,
        raw && raw.payUrl
      ]),
      payPageUrl: firstNonEmptyString([
        source.payPageUrl,
        source.pay_page_url,
        raw && raw.payPageUrl
      ]),
      qrUrl: firstNonEmptyString([
        source.qrUrl,
        source.qr_url,
        qr.qrUrl,
        raw && raw.qr && raw.qr.qrUrl
      ]),
      mobilePayUrl: firstNonEmptyString([
        source.mobilePayUrl,
        source.mobile_pay_url,
        qr.mobilePayUrl,
        raw && raw.qr && raw.qr.mobilePayUrl
      ]),
      providerOrderNo: firstNonEmptyString([
        source.providerOrderNo,
        source.provider_order_no,
        source.remoteTradeNo,
        raw && raw.remoteTradeNo
      ]),
      payOrderId: firstNonEmptyString([
        source.payOrderId,
        source.pay_order_id,
        qr.payOrderId,
        raw && raw.orderNoHint
      ]),
      clientReference: firstNonEmptyString([
        source.clientReference,
        source.client_reference,
        raw && raw.clientReference
      ]),
      warnings: Array.isArray(source.warnings)
        ? source.warnings.map(function (item) { return String(item || '').trim(); }).filter(Boolean)
        : [],
      reason: firstNonEmptyString([source.reason]) || '',
      raw: raw || source
    };
  }

  function mergeOrderPaymentSession(order, paymentSession) {
    if (!order) return order;
    var session = normalizePaymentSession(paymentSession || order.paymentSession || order.payment_session);
    if (!session) return order;
    var metadata = Object.assign({}, extractOrderMetadata(order));
    var storefrontSession = Object.assign({}, metadata.ldxp_storefront_session || {});
    if (session.paymentUrl) storefrontSession.payUrl = session.paymentUrl;
    if (session.payPageUrl) storefrontSession.payPageUrl = session.payPageUrl;
    if (session.providerOrderNo) storefrontSession.remoteTradeNo = session.providerOrderNo;
    if (session.payOrderId) storefrontSession.orderNoHint = session.payOrderId;
    if (session.clientReference) storefrontSession.clientReference = session.clientReference;
    if (session.warnings && session.warnings.length) storefrontSession.warnings = session.warnings.slice();
    metadata.ldxp_storefront_session = storefrontSession;
    return Object.assign({}, order, {
      paymentSession: session,
      metadata: metadata,
      qr_code_url: session.qrDataUrl || order.qr_code_url || order.qrCodeUrl || '',
      payment_url: session.paymentUrl || order.payment_url || order.paymentUrl || '',
      pay_url: session.paymentUrl || order.pay_url || order.payUrl || '',
      code_url: session.paymentUrl || order.code_url || order.codeUrl || '',
      client_reference: session.clientReference || order.client_reference || order.clientReference || ''
    });
  }

  function mergeOrderIntoList(orders, order) {
    var nextOrder = order ? mergeOrderPaymentSession(order, order.paymentSession) : null;
    var list = Array.isArray(orders) ? orders.slice() : [];
    if (!nextOrder || !nextOrder.id) return list;
    var replaced = false;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === nextOrder.id) {
        list[i] = Object.assign({}, list[i], nextOrder);
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      list.unshift(nextOrder);
    }
    return list;
  }

  function normalizeOrderDetailResult(payload) {
    if (!payload || typeof payload !== 'object') {
      return { aggregate: null, order: null, paymentSession: null };
    }
    var aggregate = payload.order && payload.order.order ? payload.order : null;
    var order = aggregate && aggregate.order
      ? aggregate.order
      : (payload.order && !payload.order.order ? payload.order : null);
    var paymentSession = normalizePaymentSession(payload.paymentSession || (aggregate && aggregate.paymentSession) || (order && order.paymentSession));
    return {
      aggregate: aggregate,
      order: order ? mergeOrderPaymentSession(order, paymentSession) : null,
      paymentSession: paymentSession
    };
  }

  function getUserAccountLabel(user) {
    if (!user) return '-';
    return user.account || user.username || user.phone || user.email || user.id || '-';
  }

  function getUserDisplayName(user) {
    if (!user) return '未设置';
    return user.displayName || user.nickname || user.username || user.phone || '未设置';
  }

  function getUserPhoneLabel(user) {
    if (!user) return '-';
    return user.phone || user.mobile || user.contact || '-';
  }

  function getMembershipPlanLabel(membership) {
    if (!membership) return '免费体验';
    return membership.planName || membership.planId || (membership.isMember ? '会员' : '免费体验');
  }

  function getMembershipExpireText(membership) {
    if (!membership) return '未返回';
    if (membership.subscriptionExpiresAt) return formatDate(membership.subscriptionExpiresAt);
    return membership.isMember ? '长期/待确认' : '未开通';
  }

  function getMembershipUsageText(membership) {
    if (!membership) return '额度待确认';
    if (membership.dailyLimit == null) return membership.isMember ? '不限量' : '未限制/待确认';
    return (membership.dailyUsed || 0) + '/' + membership.dailyLimit + '，剩余 ' + (membership.dailyRemaining == null ? '-' : membership.dailyRemaining);
  }

  function getMembershipSummaryText(membership) {
    if (!membership) return '当前未返回会员快照，默认按免费体验展示。';
    if (membership.isMember) {
      return '你当前已开通 ' + getMembershipPlanLabel(membership) + '，可以继续使用更高额度与更多能力。';
    }
    return membership.reason || '当前为免费模式，可继续体验，但业务次数与试用期可能受限。';
  }

  function getMembershipRestrictionText(membership) {
    if (!membership) return '会员接口尚未返回限制说明。';
    if (membership.allowed === false) return membership.reason || '当前免费额度已受限，建议充值会员。';
    if (membership.isMember) return '会员用户默认不受免费次数与试用期限制。';
    if (membership.dailyLimit == null) return '当前免费限制待确认。';
    return '免费用户每日最多 ' + membership.dailyLimit + ' 次业务指令，当前剩余 ' + (membership.dailyRemaining == null ? '-' : membership.dailyRemaining) + ' 次。';
  }

  function getMembershipTrialText(membership, user) {
    if (!membership) return user ? ('注册时间：' + formatDate(user.createdAt || user.created_at)) : '-';
    if (membership.trialEndsAt) {
      return '试用期至 ' + formatDate(membership.trialEndsAt) + (membership.trialExpired ? '（已到期）' : '');
    }
    return membership.isMember ? '会员开通中，不受试用期限制。' : '当前未返回试用期信息。';
  }

  function getFeatureText(plan) {
    var features = plan && plan.features ? plan.features : {};
    var tags = Array.isArray(features.features) ? features.features : [];
    var maxSessions = firstFiniteNumber([features.max_sessions, features.maxSessions], null);
    var maxDaily = firstFiniteNumber([features.max_messages_per_day, features.maxMessagesPerDay], null);
    var lines = [];
    if (maxSessions !== null) lines.push(maxSessions < 0 ? '会话数不限' : ('最多 ' + maxSessions + ' 个会话'));
    if (maxDaily !== null) lines.push(maxDaily < 0 ? '每日指令不限量' : ('每日 ' + maxDaily + ' 次业务指令'));
    if (tags.length) lines.push(tags.join(' / '));
    return lines.join('；') || '权益说明待补充';
  }

  function getPlanDurationText(plan) {
    var days = Number(plan && plan.duration_days || 0);
    return days > 0 ? ('有效期 ' + days + ' 天') : '长期/试用套餐';
  }

  async function fetchPlansSnapshot() {
    try {
      var result = await request('/api/payments/plans', { method: 'GET' });
      return {
        plans: normalizePlanList(result),
        checkout: getCheckoutInfo(result),
        raw: result,
        source: 'plans'
      };
    } catch (error) {
      var fallback = null;
      try {
        fallback = await fetchPaymentOptionsSafe();
      } catch (_) {
        fallback = null;
      }
      return {
        plans: normalizePlanList(fallback),
        checkout: getCheckoutInfo(fallback),
        raw: fallback,
        error: error,
        source: fallback ? 'payment-options' : 'fallback'
      };
    }
  }

  function getPlanById(plans, planId) {
    if (!Array.isArray(plans) || !planId) return null;
    for (var i = 0; i < plans.length; i += 1) {
      if (plans[i] && plans[i].id === planId) return plans[i];
    }
    return null;
  }

  function getGrantDurationText(grant) {
    if (!grant || typeof grant !== 'object') return '';
    var startsAt = grant.starts_at || grant.startsAt;
    var expiresAt = grant.expires_at || grant.expiresAt;
    if (!startsAt && !expiresAt) return '';
    if (startsAt && expiresAt) {
      var startTime = new Date(startsAt).getTime();
      var endTime = new Date(expiresAt).getTime();
      if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime) {
        return String(Math.max(1, Math.round((endTime - startTime) / 86400000)));
      }
    }
    return expiresAt ? '长期' : '';
  }

  function buildInviteSummary(user) {
    var source = user && typeof user === 'object'
      ? (user.invite || user.invitation || user.inviteSummary || user.referral || user.referralSummary || {})
      : {};
    var inviteCode = firstNonEmptyString([
      source.inviteCode,
      source.invite_code,
      source.code,
      user && user.inviteCode,
      user && user.invite_code
    ]);
    var invitedCount = firstFiniteNumber([
      source.invitedCount,
      source.invited_count,
      source.count,
      source.total,
      user && user.invitedCount,
      user && user.invited_count
    ], 0);
    var inviteLink = inviteCode && typeof window !== 'undefined'
      ? window.location.origin + '/register.html?inviteCode=' + encodeURIComponent(inviteCode)
      : '';
    var rewardSummary = source && typeof source.rewardSummary === 'object' && source.rewardSummary ? source.rewardSummary : {};
    var nextPendingReward = rewardSummary.nextPendingReward && typeof rewardSummary.nextPendingReward === 'object'
      ? rewardSummary.nextPendingReward
      : null;
    var latestReward = rewardSummary.latestReward && typeof rewardSummary.latestReward === 'object'
      ? rewardSummary.latestReward
      : null;
    var recentRewards = Array.isArray(rewardSummary.recentRewards) ? rewardSummary.recentRewards : [];
    var progress = Array.isArray(rewardSummary.progress) ? rewardSummary.progress : [];
    var totalRewardDays = firstFiniteNumber([rewardSummary.totalRewardDays], 0);
    var grantedCount = firstFiniteNumber([rewardSummary.grantedCount], 0);
    var rewardStatusText = '';
    if (nextPendingReward) {
      if (nextPendingReward.status === 'ready') {
        rewardStatusText = '邀请奖励已达标，等待系统发放';
      } else if (Number(nextPendingReward.remainingInvites) > 0) {
        rewardStatusText = '再邀请 ' + Number(nextPendingReward.remainingInvites) + ' 人，可获得 ' + Number(nextPendingReward.rewardDurationDays || 0) + ' 天奖励';
      }
    }
    if (!rewardStatusText && latestReward) {
      rewardStatusText = '最近一次邀请奖励：已获得 ' + Number(latestReward.rewardDurationDays || 0) + ' 天';
    }
    if (!rewardStatusText && progress.length) {
      rewardStatusText = '已配置 ' + progress.length + ' 条邀请奖励规则';
    }
    return {
      inviteCode: inviteCode,
      invitedCount: invitedCount,
      inviteLink: inviteLink,
      hasInviteData: !!inviteCode || invitedCount > 0,
      rewardSummary: rewardSummary,
      nextPendingReward: nextPendingReward,
      latestReward: latestReward,
      recentRewards: recentRewards,
      progress: progress,
      totalRewardDays: totalRewardDays,
      grantedCount: grantedCount,
      rewardStatusText: rewardStatusText,
      raw: source
    };
  }

  function extractOrderMetadata(order) {
    return order && order.metadata && typeof order.metadata === 'object' ? order.metadata : {};
  }

  function resolveOrderQrPayload(order, paymentContext) {
    var metadata = extractOrderMetadata(order);
    var paymentSession = normalizePaymentSession(order && (order.paymentSession || order.payment_session));
    var storefrontSession = metadata && metadata.ldxp_storefront_session && typeof metadata.ldxp_storefront_session === 'object'
      ? metadata.ldxp_storefront_session
      : {};
    var checkout = getCheckoutInfo(paymentContext) || {};
    var warningText = paymentSession && paymentSession.warnings && paymentSession.warnings.length ? paymentSession.warnings.join('；') : '';

    var mobileValueCandidate = firstNonEmptyString([
      paymentSession && paymentSession.mobilePayUrl,
      paymentSession && paymentSession.qrUrl
    ]);
    if (mobileValueCandidate) {
      return {
        type: 'encoded',
        src: mobileValueCandidate,
        raw: mobileValueCandidate,
        warning: warningText,
        note: '当前二维码已优先切换为手机端支付宝扫码入口。'
      };
    }

    var imageCandidate = firstNonEmptyString([
      paymentSession && paymentSession.qrDataUrl,
      order && order.qr_code_url,
      order && order.qrCodeUrl,
      order && order.payment_qr_image,
      order && order.paymentQrImage,
      metadata.qr_code_url,
      metadata.qrCodeUrl,
      metadata.payment_qr_image,
      metadata.paymentQrImage,
      metadata.alipay_qr_image,
      metadata.alipayQrImage
    ]);
    if (imageCandidate) {
      return {
        type: 'image',
        src: imageCandidate,
        raw: imageCandidate,
        warning: warningText,
        note: '当前展示的是订单返回的二维码图片。'
      };
    }

    var valueCandidate = firstNonEmptyString([
      paymentSession && paymentSession.paymentUrl,
      paymentSession && paymentSession.payPageUrl,
      order && order.payment_url,
      order && order.paymentUrl,
      order && order.code_url,
      order && order.codeUrl,
      order && order.qr_content,
      order && order.qrContent,
      order && order.pay_url,
      order && order.payUrl,
      metadata.payment_url,
      metadata.paymentUrl,
      metadata.code_url,
      metadata.codeUrl,
      metadata.qr_content,
      metadata.qrContent,
      metadata.alipay_url,
      metadata.alipayUrl,
      metadata.rawQr,
      metadata.raw_qr,
      storefrontSession.payUrl,
      storefrontSession.payPageUrl
    ]);
    if (valueCandidate) {
      return {
        type: 'encoded',
        src: valueCandidate,
        raw: valueCandidate,
        warning: warningText,
        note: isProbablyUrl(valueCandidate)
          ? '当前二维码由订单返回的支付链接生成。'
          : '当前二维码由订单返回的支付文本内容生成。'
      };
    }

    return {
      type: 'empty',
      src: '',
      raw: '',
      warning: (paymentSession && paymentSession.reason ? (paymentSession.reason + ' ') : '') + '当前后端尚未返回可用于展示的二维码字段。',
      note: '请刷新订单，等待后端继续解析并回传支付二维码。'
    };
  }

  function renderMembershipCard(membership, user) {
    var card = $('membership-card');
    var flag = $('member-flag');
    var alertTitle = $('membership-alert-title');
    var alertText = $('membership-alert-text');
    var jumpBtn = $('jump-recharge-btn');
    var isMember = !!(membership && membership.isMember);
    var shouldRecharge = !membership || !isMember || membership.allowed === false || membership.trialExpired || (typeof membership.dailyRemaining === 'number' && membership.dailyRemaining <= 0);

    if (card) {
      card.classList[isMember ? 'add' : 'remove']('member');
      card.classList[shouldRecharge ? 'add' : 'remove']('alert');
    }
    if (flag) {
      flag.classList.remove('free', 'member');
      flag.classList.add(isMember ? 'member' : 'free');
      flag.innerHTML = isMember
        ? '<strong>会员</strong><span>' + escapeHtml(getMembershipPlanLabel(membership)) + '</span>'
        : '<strong>免费</strong><span>免费体验</span>';
    }
    if ($('membership-subtitle')) $('membership-subtitle').textContent = getMembershipSummaryText(membership);
    if ($('member-plan-badge')) {
      $('member-plan-badge').textContent = '套餐 ' + getMembershipPlanLabel(membership);
      $('member-plan-badge').className = 'badge' + (isMember ? ' member' : '');
    }
    if ($('member-expire-badge')) $('member-expire-badge').textContent = '到期 ' + getMembershipExpireText(membership);
    if ($('member-usage-badge')) $('member-usage-badge').textContent = '额度 ' + getMembershipUsageText(membership);
    if ($('membership-feature-summary')) $('membership-feature-summary').textContent = getMembershipSummaryText(membership);
    if ($('membership-access-summary')) $('membership-access-summary').textContent = getMembershipRestrictionText(membership);
    if ($('membership-trial-summary')) $('membership-trial-summary').textContent = getMembershipTrialText(membership, user);
    if (alertTitle) alertTitle.textContent = isMember ? '会员身份已生效' : '当前不是会员，建议尽快充值';
    if (alertText) alertText.textContent = isMember
      ? ('当前套餐：' + getMembershipPlanLabel(membership) + '，到期时间：' + getMembershipExpireText(membership))
      : getMembershipRestrictionText(membership);
    if (jumpBtn) jumpBtn.textContent = isMember ? '查看个人中心' : '立即充值';

    if ($('business-member-badge')) {
      $('business-member-badge').textContent = isMember ? ('会员 · ' + getMembershipPlanLabel(membership)) : '免费 · 免费体验';
      $('business-member-badge').className = 'member-chip' + (isMember ? ' vip' : '');
    }
    if ($('business-access-text')) $('business-access-text').textContent = getMembershipSummaryText(membership);
    if ($('business-limit-text')) $('business-limit-text').textContent = getMembershipRestrictionText(membership) + ' ' + getMembershipTrialText(membership, user);
    if ($('business-plan-badge')) $('business-plan-badge').textContent = '套餐 ' + getMembershipPlanLabel(membership);
    if ($('business-expire-badge')) $('business-expire-badge').textContent = '到期 ' + getMembershipExpireText(membership);
    if ($('business-usage-badge')) $('business-usage-badge').textContent = '额度 ' + getMembershipUsageText(membership);
    if ($('business-upgrade-btn')) {
      $('business-upgrade-btn').setAttribute('href', '/payment.html');
      $('business-upgrade-btn').textContent = isMember ? '续费 / 再次充值' : '开通 / 续费会员';
    }
  }

  function renderPlanList(plans, membership, user, paymentOptions, onOrdersChanged, config) {
    var opts = config || {};
    var list = $(opts.targetId || 'plan-list');
    var normalizedPlans = normalizePlanList(plans);
    var checkout = getCheckoutInfo(paymentOptions) || {};
    var statusEl = $(opts.statusTargetId || 'event-status');
    if (!list) return;
    if (!normalizedPlans || !normalizedPlans.length) {
      list.innerHTML = '<div class="plan-card"><strong>暂无套餐数据</strong><span>当前未获取到套餐列表，可稍后刷新。</span></div>';
      return;
    }

    list.innerHTML = normalizedPlans.map(function (plan) {
      var active = membership && membership.planId === plan.id;
      var mode = opts.mode || 'default';
      var actionLabel = mode === 'payment'
        ? (plan.id === 'free' ? '查看权益' : '立即下单')
        : (mode === 'account-preview' ? '去充值中心' : '查看详情');
      var summaryText = firstNonEmptyString([plan.description, getFeatureText(plan)]);
      return (
        '<div class="plan-card' + (active ? ' active' : '') + '">' +
          (active ? '<span class="plan-badge">当前套餐</span>' : (plan.badge_text ? '<span class="plan-badge">' + escapeHtml(plan.badge_text) + '</span>' : '')) +
          '<strong>' + escapeHtml(plan.name || plan.id) + '</strong>' +
          '<small>' + escapeHtml(summaryText) + '</small>' +
          '<div class="plan-price">' + escapeHtml(formatPrice(plan.price_cents || 0)) + '</div>' +
          '<span>' + escapeHtml(getPlanDurationText(plan)) + '</span>' +
          '<div class="plan-tags">' +
            '<span class="plan-tag">套餐编码：' + escapeHtml(plan.id || '-') + '</span>' +
            '<span class="plan-tag">' + escapeHtml(membership && membership.planId === plan.id ? '当前生效中' : '可选套餐') + '</span>' +
          '</div>' +
          '<div class="plan-actions">' +
            '<button class="primary-btn js-plan-action" type="button" data-plan-id="' + escapeHtml(plan.id) + '">' + escapeHtml(actionLabel) + '</button>' +
            '<button class="ghost-btn js-plan-secondary" type="button" data-plan-id="' + escapeHtml(plan.id) + '">查看权益</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    Array.from(list.querySelectorAll('.js-plan-action')).forEach(function (button) {
      button.addEventListener('click', async function () {
        var planId = button.getAttribute('data-plan-id') || '';
        var plan = getPlanById(normalizedPlans, planId);
        if (!plan) return;
        if ((opts.mode || '') === 'account-preview') {
          redirect('/payment.html?planId=' + encodeURIComponent(plan.id));
          return;
        }
        if ((opts.mode || '') !== 'payment') {
          setStatus(statusEl, '请前往充值中心完成下单。', 'info');
          redirect('/payment.html?planId=' + encodeURIComponent(plan.id));
          return;
        }
        if (plan.id === 'free') {
          setStatus(statusEl, '免费体验无需支付，当前账号可直接按免费模式使用。', 'info');
          return;
        }
        try {
          if (typeof opts.onCreatingOrder === 'function') {
            try {
              opts.onCreatingOrder({
                plan: plan,
                user: user,
                checkout: checkout
              });
            } catch (_) {}
          }
          setButtonLoading(button, '创建中...', true);
          var created = await createRemoteOrder({
            planId: plan.id,
            paymentChannel: 'ldxp_alipay_qr',
            title: plan.name,
            metadata: {
              source: opts.orderSource || 'web-payment-page',
              userAccount: getUserAccountLabel(user),
              planName: plan.name
            }
          });
          var order = created && created.order ? created.order : null;
          var createdPaymentSession = created && created.paymentSession ? created.paymentSession : null;
          var createdOrder = order ? mergeOrderPaymentSession(order, createdPaymentSession) : null;
          var mergedOrders = createdOrder ? [createdOrder] : (order ? [order] : []);
          var postCreateResult = null;
          if (typeof opts.onCreateOrder === 'function') {
            postCreateResult = await opts.onCreateOrder({
              created: created,
              order: createdOrder || order,
              plan: plan,
              checkout: created && created.checkout ? created.checkout : checkout,
              orders: mergedOrders
            });
          }
          if (Array.isArray(postCreateResult)) {
            mergedOrders = postCreateResult;
          } else if (postCreateResult && Array.isArray(postCreateResult.orders)) {
            mergedOrders = postCreateResult.orders;
          }
          var latestOrders = await fetchOrdersSafe({ autoReconcile: !!opts.autoReconcileOnFetch });
          if (Array.isArray(latestOrders)) {
            mergedOrders = latestOrders;
          }
          if (createdOrder && createdOrder.id) {
            mergedOrders = mergeOrderIntoList(mergedOrders, createdOrder);
          }
          if (user && user.id && mergedOrders.length) saveLocalOrders(user.id, mergedOrders);
          if (typeof onOrdersChanged === 'function') {
            onOrdersChanged(mergedOrders);
          }
          setStatus(statusEl, (createdOrder || order)
            ? ('订单已创建：' + ((createdOrder && createdOrder.order_no) || (createdOrder && createdOrder.id) || order.order_no || order.id) + '，请扫码支付。')
            : '订单已创建，请扫码支付。', 'success');
        } catch (error) {
          setStatus(statusEl, error && error.message ? error.message : '创建充值订单失败', 'error');
        } finally {
          setButtonLoading(button, '创建中...', false);
        }
      });
    });

    Array.from(list.querySelectorAll('.js-plan-secondary')).forEach(function (button) {
      button.addEventListener('click', function () {
        var planId = button.getAttribute('data-plan-id') || '';
        var plan = getPlanById(normalizedPlans, planId);
        if (!plan) return;
        setStatus(statusEl, (plan.name || plan.id) + '：' + getFeatureText(plan) + '；' + getPlanDurationText(plan), 'info');
      });
    });
  }

  function renderOrderList(orders, paymentOptions, onOrdersChanged, config) {
    var opts = config || {};
    var list = $(opts.targetId || 'order-list');
    var statusEl = $(opts.statusTargetId || 'event-status');
    var selectedOrderId = opts.selectedOrderId || '';
    if (!list) return;
    updateOrderPollBadge(ORDER_POLL_ENABLED && hasPendingOrder(orders), ORDER_POLL_ENABLED
      ? (hasPendingOrder(orders) ? '轮询运行中（待支付订单监控中）' : '轮询待命（暂无待处理订单）')
      : '轮询已关闭');
    if (!orders || !orders.length) {
      list.innerHTML = '<div class="order-card"><strong>暂无订单</strong><span>你还没有创建充值订单，先选择套餐后再回来查看。</span></div>';
      return;
    }

    list.innerHTML = orders.slice(0, 20).map(function (order) {
      var status = order.status || 'pending';
      var orderId = order.id || '';
      var selectedClass = selectedOrderId && selectedOrderId === orderId ? ' selected' : '';
      var latestPayment = order.latestPayment && typeof order.latestPayment === 'object' ? order.latestPayment : null;
      var grant = order.grant && typeof order.grant === 'object' ? order.grant : null;
      var subscription = order.subscription && typeof order.subscription === 'object' ? order.subscription : null;
      return (
        '<div class="order-card ' + escapeHtml(status) + selectedClass + '">' +
          '<div class="order-meta"><span>' + escapeHtml(order.order_no || order.id || '-') + '</span><span class="order-status-label">' + escapeHtml(normalizeOrderStatusLabel(status)) + '</span></div>' +
          '<strong>' + escapeHtml(order.plan_name || order.title || order.plan_id || '会员订单') + '</strong>' +
          '<span>金额：' + escapeHtml(formatPrice(order.amount_cents || 0)) + '</span>' +
          '<span>创建时间：' + escapeHtml(formatDate(order.created_at || order.createdAt)) + '</span>' +
          (order.updated_at || order.updatedAt ? '<span>最近更新：' + escapeHtml(formatDate(order.updated_at || order.updatedAt)) + '</span>' : '') +
          (latestPayment && latestPayment.provider_transaction_id ? '<span>交易号：' + escapeHtml(latestPayment.provider_transaction_id) + '</span>' : '') +
          (grant && getGrantDurationText(grant) ? '<span>本单到账：' + escapeHtml(getGrantDurationText(grant)) + (getGrantDurationText(grant) === '长期' ? '' : ' 天') + '</span>' : '') +
          (subscription && (subscription.expires_at || subscription.expiresAt) ? '<span>会员到期：' + escapeHtml(formatDate(subscription.expires_at || subscription.expiresAt)) + '</span>' : '') +
          (buildClientReferenceHint(order) ? '<span>' + escapeHtml(buildClientReferenceHint(order)) + '</span>' : '') +
          (order.note ? '<span>说明：' + escapeHtml(order.note) + '</span>' : '') +
          '<div class="order-actions">' +
            ((opts.mode || '') === 'payment' ? '<button class="ghost-btn js-order-select" type="button" data-order-id="' + escapeHtml(orderId) + '">查看二维码</button>' : '<a class="ghost-btn" href="/payment.html?orderId=' + encodeURIComponent(orderId) + '">去支付</a>') +
            ((status === 'pending' || status === 'review_required' || status === 'paid')
              ? '<button class="primary-btn js-reconcile-order" type="button" data-order-id="' + escapeHtml(orderId) + '">自动核单</button>'
              : '') +
          '</div>' +
        '</div>'
      );
    }).join('');

    Array.from(list.querySelectorAll('.js-order-select')).forEach(function (button) {
      button.addEventListener('click', function () {
        var orderId = button.getAttribute('data-order-id') || '';
        var selectedOrder = Array.isArray(orders) ? orders.find(function (item) { return item && item.id === orderId; }) : null;
        if (selectedOrder && typeof opts.onSelect === 'function') {
          opts.onSelect(selectedOrder);
        }
      });
    });

    Array.from(list.querySelectorAll('.js-reconcile-order')).forEach(function (button) {
      button.addEventListener('click', async function () {
        var orderId = button.getAttribute('data-order-id') || '';
        if (!orderId) return;
        try {
          setButtonLoading(button, '核单中...', true);
          var result = await reconcileRemoteOrder(orderId);
          var latestOrders = await fetchOrdersSafe({ autoReconcile: !!opts.autoReconcileOnFetch });
          if (Array.isArray(latestOrders)) {
            if (typeof onOrdersChanged === 'function') onOrdersChanged(latestOrders);
            renderOrderList(latestOrders, paymentOptions, onOrdersChanged, Object.assign({}, opts, {
              selectedOrderId: opts.selectedOrderId === orderId ? orderId : opts.selectedOrderId
            }));
          }
          if (typeof opts.onReconcileFinished === 'function') {
            await opts.onReconcileFinished({
              orderId: orderId,
              result: result,
              orders: Array.isArray(latestOrders) ? latestOrders : orders
            });
          }
          setStatus(statusEl, result && result.reason ? result.reason : '核单已完成。', result && result.autoCredited ? 'success' : 'info');
        } catch (error) {
          setStatus(statusEl, error && error.message ? error.message : '自动核单失败', 'error');
        } finally {
          setButtonLoading(button, '核单中...', false);
        }
      });
    });
  }

  function renderPaymentGuide(options) {
    var list = $('payment-guide');
    if (!list) return;
    list.innerHTML = [
      '<div class="pay-card"><strong>支付流程总览</strong><span>先创建订单，再等待后端解析二维码并在站内弹出，最后回到订单区核单。</span></div>'
    ].join('');
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var scripts = Array.from(document.scripts || []);
      var existing = scripts.find(function (s) {
        return s.src && s.src.indexOf(src) >= 0;
      });
      if (existing) {
        existing.addEventListener('load', function () { resolve(); }, { once: true });
        existing.addEventListener('error', function () { reject(new Error('验证码脚本加载失败')); }, { once: true });
        if (existing.dataset.loaded === 'true') {
          resolve();
        }
        return;
      }
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = function () {
        script.dataset.loaded = 'true';
        resolve();
      };
      script.onerror = function () {
        reject(new Error('验证码脚本加载失败'));
      };
      document.head.appendChild(script);
    });
  }

  function loadStyle(href) {
    return new Promise(function (resolve, reject) {
      var links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
      var existing = links.find(function (link) {
        return link.href && link.href.indexOf(href) >= 0;
      });
      if (existing) {
        resolve();
        return;
      }
      var style = document.createElement('link');
      style.rel = 'stylesheet';
      style.href = href;
      style.onload = resolve;
      style.onerror = function () {
        reject(new Error('验证码样式加载失败'));
      };
      document.head.appendChild(style);
    });
  }

  function firstFiniteNumber(values, fallback) {
    var list = Array.isArray(values) ? values : [];
    for (var i = 0; i < list.length; i += 1) {
      var num = Number(list[i]);
      if (Number.isFinite(num)) {
        return num;
      }
    }
    return fallback;
  }

  function getPayloadMessage(payload, fallback) {
    if (payload && typeof payload === 'object') {
      if (typeof payload.message === 'string' && payload.message) return payload.message;
      if (typeof payload.error === 'string' && payload.error) return payload.error;
      if (typeof payload.msg === 'string' && payload.msg) return payload.msg;
      if (payload.data && typeof payload.data === 'object') {
        if (typeof payload.data.message === 'string' && payload.data.message) return payload.data.message;
        if (typeof payload.data.error === 'string' && payload.data.error) return payload.data.error;
        if (typeof payload.data.msg === 'string' && payload.data.msg) return payload.data.msg;
      }
    }
    return fallback || '请求失败，请稍后重试';
  }

  function isBusinessSuccess(payload) {
    if (!payload || typeof payload !== 'object') return true;
    if (payload.success === false || payload.ok === false) return false;
    if (typeof payload.code === 'number' && payload.code !== 0 && payload.code !== 200) return false;
    return true;
  }

  function unwrapDataPayload(payload) {
    if (!payload || typeof payload !== 'object') return {};
    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      return payload.data;
    }
    return payload;
  }

  function normalizeCaptchaConfig(payload, scene) {
    var source = payload && payload.captcha && typeof payload.captcha === 'object'
      ? payload.captcha
      : unwrapDataPayload(payload);
    var assets = source.assets && typeof source.assets === 'object' ? source.assets : {};
    var type = String(source.type || source.mode || source.captchaType || 'slide').toLowerCase();

    return {
      enabled: source.enabled !== false,
      provider: source.provider || 'go-captcha',
      type: type,
      scene: source.scene || scene,
      captchaId: source.captchaId || source.id || source.templateId || '',
      scriptUrl: source.scriptUrl || source.script || assets.scriptUrl || assets.script || '/vendor/go-captcha/gocaptcha.global.js',
      styleUrl: source.styleUrl || source.style || assets.styleUrl || assets.style || '/vendor/go-captcha/gocaptcha.global.css',
      dataApi: source.dataApi || source.getDataApi || source.getApi || ('/api/auth/captcha/data?scene=' + encodeURIComponent(scene)),
      verifyApi: source.verifyApi || source.checkDataApi || source.checkApi || '/api/auth/captcha/verify',
      width: firstFiniteNumber([source.width], 320),
      height: firstFiniteNumber([source.height], 220),
      submitMode: source.submitMode || (source.returnTicket === false ? 'raw' : 'auto')
    };
  }

  function normalizeCaptchaChallenge(payload) {
    var source = unwrapDataPayload(payload);
    return {
      captchaKey: String(source.captcha_key || source.captchaKey || source.key || ''),
      image: String(source.image_base64 || source.master_image_base64 || source.image || ''),
      thumb: String(source.tile_base64 || source.thumb_base64 || source.thumb_image_base64 || source.thumb || ''),
      thumbX: firstFiniteNumber([source.tile_x, source.display_x, source.thumb_x, source.dx], 0),
      thumbY: firstFiniteNumber([source.tile_y, source.display_y, source.thumb_y, source.dy], 0),
      thumbWidth: firstFiniteNumber([source.tile_width, source.thumb_width, source.width], 0),
      thumbHeight: firstFiniteNumber([source.tile_height, source.thumb_height, source.height], 0),
      angle: firstFiniteNumber([source.angle], 0),
      thumbSize: firstFiniteNumber([source.thumb_size, source.thumbSize, source.thumb_width, source.tile_width], 0)
    };
  }

  function normalizeCaptchaVerifyResult(payload) {
    var result = {
      ok: isBusinessSuccess(payload),
      ticket: '',
      message: getPayloadMessage(payload, '验证码校验失败，请重试')
    };
    var source = unwrapDataPayload(payload);
    var rawData = payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : null;

    if (typeof rawData === 'string' && rawData) {
      var normalized = rawData.toLowerCase();
      if (normalized === 'ok' || normalized === 'success' || normalized === 'passed') {
        result.ok = result.ok && true;
      } else if (!result.ticket) {
        result.ticket = rawData;
      }
    }

    result.ticket = String(
      source.ticket ||
      source.token ||
      source.captchaToken ||
      source.verificationToken ||
      result.ticket ||
      ''
    );

    return result;
  }

  function buildCaptchaViewData(type, challenge) {
    if (type === 'rotate') {
      return {
        image: challenge.image,
        thumb: challenge.thumb,
        angle: challenge.angle,
        thumbSize: challenge.thumbSize
      };
    }

    if (type === 'click') {
      return {
        image: challenge.image,
        thumb: challenge.thumb
      };
    }

    return {
      image: challenge.image,
      thumb: challenge.thumb,
      thumbX: challenge.thumbX,
      thumbY: challenge.thumbY,
      thumbWidth: challenge.thumbWidth,
      thumbHeight: challenge.thumbHeight
    };
  }

  function resolveCaptchaConstructor(type) {
    if (!window.GoCaptcha || typeof window.GoCaptcha !== 'object') return null;
    if (type === 'click') return window.GoCaptcha.Click;
    if (type === 'rotate') return window.GoCaptcha.Rotate;
    if (type === 'slide-region') return window.GoCaptcha.SlideRegion;
    return window.GoCaptcha.Slide;
  }

  function serializeCaptchaValue(type, payload) {
    if (Array.isArray(payload)) {
      var dots = [];
      payload.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        dots.push(firstFiniteNumber([item.x], 0));
        dots.push(firstFiniteNumber([item.y], 0));
      });
      return dots.join(',');
    }

    if (typeof payload === 'number') {
      return String(payload);
    }

    if (payload && typeof payload === 'object') {
      if (Object.prototype.hasOwnProperty.call(payload, 'x') || Object.prototype.hasOwnProperty.call(payload, 'y')) {
        return [
          firstFiniteNumber([payload.x], 0),
          firstFiniteNumber([payload.y], 0)
        ].join(',');
      }
    }

    if (payload == null) return '';
    return String(payload);
  }

  function setCaptchaShellState(containerEl, state) {
    if (!containerEl) return;
    containerEl.className = 'captcha-shell' + (state ? ' is-' + state : '');
  }

  function resetCaptchaVerification(options) {
    var opts = options || {};
    captchaVerified = false;
    captchaTicket = '';
    captchaValue = '';
    captchaVerifiedAt = '';
    captchaLastError = null;
    if (!opts.preserveKey) {
      captchaKey = '';
    }
  }

  function getSubmitDefaultText(mode) {
    return mode === 'register' ? '注册并登录' : '登录';
  }

  function syncAuthSubmitButton(button, mode) {
    if (!button) return;
    if (!button.dataset.defaultText) {
      button.dataset.defaultText = getSubmitDefaultText(mode);
    }
    if (button.dataset.loading === 'true') {
      return;
    }

    var defaultText = button.dataset.defaultText;
    if (captchaConfig && captchaConfig.enabled === false) {
      button.disabled = false;
      button.textContent = defaultText;
      return;
    }

    if (captchaChecking) {
      button.disabled = true;
      button.textContent = '验证中...';
      return;
    }

    if (pendingAuthSubmit || isCaptchaModalOpen()) {
      button.disabled = true;
      button.textContent = '请先完成验证';
      return;
    }

    button.disabled = false;
    button.textContent = defaultText;
  }

  async function loadGoCaptchaAssets(config) {
    var styleUrl = config && config.styleUrl ? config.styleUrl : '/vendor/go-captcha/gocaptcha.global.css';
    var scriptUrl = config && config.scriptUrl ? config.scriptUrl : '/vendor/go-captcha/gocaptcha.global.js';
    await loadStyle(styleUrl);
    if (window.GoCaptcha) return;
    await loadScript(scriptUrl);
    if (!window.GoCaptcha) {
      throw new Error('GoCaptcha 脚本未成功注入页面');
    }
  }

  async function loadCaptchaChallenge(scene, statusEl, containerEl, submitBtn, customMessage) {
    if (!captchaConfig || captchaConfig.enabled === false) {
      captchaReady = true;
      syncAuthSubmitButton(submitBtn, scene);
      return null;
    }
    if (!captchaInstance || typeof captchaInstance.setData !== 'function') {
      throw new Error('验证码实例未初始化');
    }
    if (captchaChallengeLoading) {
      return await captchaChallengeLoading;
    }

    captchaChallengeLoading = (async function () {
      captchaReady = false;
      captchaChecking = false;
      resetCaptchaVerification();
      setCaptchaShellState(containerEl, 'loading');
      setStatus(statusEl, customMessage || '正在加载验证码...', 'info');
      syncAuthSubmitButton(submitBtn, scene);

      if (typeof captchaInstance.clear === 'function') {
        try {
          captchaInstance.clear();
        } catch (_) {}
      }

      var response = await request(captchaConfig.dataApi, { method: 'GET', headers: { Authorization: '' } });
      if (!isBusinessSuccess(response)) {
        throw new Error(getPayloadMessage(response, '验证码加载失败，请稍后重试'));
      }

      var challenge = normalizeCaptchaChallenge(response);
      if (!challenge.captchaKey || !challenge.image || !challenge.thumb) {
        throw new Error('验证码数据不完整，请检查后端返回 image/thumb/captcha_key');
      }

      captchaKey = challenge.captchaKey;
      captchaInstance.setData(buildCaptchaViewData(captchaConfig.type, challenge));
      captchaReady = true;
      setCaptchaShellState(containerEl, 'ready');
      setStatus(statusEl, '请先完成安全验证，再提交' + (scene === 'register' ? '注册' : '登录') + '。', 'info');
      syncAuthSubmitButton(submitBtn, scene);
      return challenge;
    })();

    try {
      return await captchaChallengeLoading;
    } finally {
      captchaChallengeLoading = null;
    }
  }

  async function verifyCaptchaAnswer(scene, value, statusEl, containerEl, submitBtn) {
    if (!captchaConfig || captchaConfig.enabled === false) {
      return {};
    }
    if (!captchaKey) {
      throw new Error('验证码已失效，请刷新后重试');
    }

    captchaChecking = true;
    setCaptchaShellState(containerEl, 'checking');
    setStatus(statusEl, '正在校验验证码...', 'info');
    syncAuthSubmitButton(submitBtn, scene);

    try {
      var response = await request(captchaConfig.verifyApi, {
        method: 'POST',
        headers: { Authorization: '' },
        body: JSON.stringify({
          provider: captchaConfig.provider || 'go-captcha',
          scene: scene,
          type: captchaConfig.type,
          id: captchaConfig.captchaId || '',
          captchaId: captchaConfig.captchaId || '',
          key: captchaKey,
          captchaKey: captchaKey,
          value: value,
          captchaValue: value
        })
      });

      var verification = normalizeCaptchaVerifyResult(response);
      if (!verification.ok) {
        throw new Error(verification.message || '验证码校验失败，请重试');
      }

      captchaValue = value;
      captchaTicket = verification.ticket || '';
      captchaVerified = true;
      captchaVerifiedAt = new Date().toISOString();
      setCaptchaShellState(containerEl, 'verified');
      setStatus(statusEl, '验证通过，可继续' + (scene === 'register' ? '注册' : '登录') + '。', 'success');
      syncAuthSubmitButton(submitBtn, scene);
      if (pendingAuthSubmit) {
        closeCaptchaModal(scene, statusEl, containerEl, submitBtn, false);
        setStatus(statusEl, '验证通过，正在继续' + (scene === 'register' ? '注册' : '登录') + '。', 'success');
        consumePendingAuthSubmit();
      }
      return verification;
    } finally {
      captchaChecking = false;
      syncAuthSubmitButton(submitBtn, scene);
    }
  }

  function attachGoCaptchaEvents(instance, scene, statusEl, containerEl, submitBtn) {
    if (!instance || instance.__wenluBound) return instance;
    if (typeof instance.setEvents !== 'function') {
      throw new Error('GoCaptcha 实例接口不兼容，请检查前端脚本版本');
    }

    instance.__wenluBound = true;
    instance.setEvents({
      confirm: function (payload) {
        var value = serializeCaptchaValue(captchaConfig && captchaConfig.type, payload);
        if (!value) {
          setStatus(statusEl, '未获取到验证码结果，请重试。', 'error');
          loadCaptchaChallenge(scene, statusEl, containerEl, submitBtn, '验证码结果为空，正在刷新...').catch(function (error) {
            setStatus(statusEl, error && error.message ? error.message : '验证码刷新失败', 'error');
            setCaptchaShellState(containerEl, 'error');
            syncAuthSubmitButton(submitBtn, scene);
          });
          return;
        }

        verifyCaptchaAnswer(scene, value, statusEl, containerEl, submitBtn).catch(function (error) {
          resetCaptchaVerification();
          setStatus(statusEl, error && error.message ? error.message : '验证码校验失败，请重试', 'error');
          setCaptchaShellState(containerEl, 'error');
          syncAuthSubmitButton(submitBtn, scene);
          window.setTimeout(function () {
            loadCaptchaChallenge(scene, statusEl, containerEl, submitBtn, '验证码校验未通过，正在刷新...').catch(function (refreshError) {
              setStatus(statusEl, refreshError && refreshError.message ? refreshError.message : '验证码刷新失败', 'error');
              setCaptchaShellState(containerEl, 'error');
              syncAuthSubmitButton(submitBtn, scene);
            });
          }, 300);
        });
      },
      refresh: function () {
        loadCaptchaChallenge(scene, statusEl, containerEl, submitBtn, '正在刷新验证码...').catch(function (error) {
          setStatus(statusEl, error && error.message ? error.message : '验证码刷新失败', 'error');
          setCaptchaShellState(containerEl, 'error');
          syncAuthSubmitButton(submitBtn, scene);
        });
      },
      close: function () {
        resetCaptchaVerification();
        setCaptchaShellState(containerEl, 'ready');
        closeCaptchaModal(scene, statusEl, containerEl, submitBtn, true);
      }
    });
    return instance;
  }

  async function ensureCaptchaReady(scene, statusEl, containerEl, submitBtn) {
    if (captchaConfig && captchaConfig.enabled === false) {
      syncAuthSubmitButton(submitBtn, scene);
      return null;
    }
    if (captchaInstance && captchaReady && captchaKey) {
      syncAuthSubmitButton(submitBtn, scene);
      return captchaInstance;
    }
    if (captchaInstance && !captchaChallengeLoading) {
      try {
        await loadCaptchaChallenge(scene, statusEl, containerEl, submitBtn, '正在刷新验证码...');
        syncAuthSubmitButton(submitBtn, scene);
        return captchaInstance;
      } catch (error) {
        captchaLastError = error instanceof Error ? error : new Error('验证码刷新失败');
      }
    }
    if (captchaLoading) {
      return await captchaLoading;
    }

    captchaLoading = (async function () {
      var configResponse = await request('/api/auth/captcha/config?scene=' + encodeURIComponent(scene), {
        method: 'GET',
        headers: { Authorization: '' }
      });
      if (!isBusinessSuccess(configResponse)) {
        throw new Error(getPayloadMessage(configResponse, '验证码配置加载失败'));
      }

      captchaConfig = normalizeCaptchaConfig(configResponse, scene);
      captchaReady = false;
      captchaChecking = false;
      captchaKey = '';
      resetCaptchaVerification();

      if (!captchaConfig || captchaConfig.enabled === false) {
        captchaReady = true;
        setCaptchaShellState(containerEl, 'disabled');
        setStatus(statusEl, '当前环境未启用验证码，可直接提交。', 'info');
        syncAuthSubmitButton(submitBtn, scene);
        return null;
      }

      await loadGoCaptchaAssets(captchaConfig);

      var CaptchaCtor = resolveCaptchaConstructor(captchaConfig.type);
      if (typeof CaptchaCtor !== 'function') {
        throw new Error('当前前端未支持 ' + captchaConfig.type + ' 验证模式');
      }

      if (containerEl) {
        containerEl.innerHTML = '';
      }
      captchaInstance = new CaptchaCtor({
        width: captchaConfig.width,
        height: captchaConfig.height
      });
      captchaInstance.mount(containerEl);
      attachGoCaptchaEvents(captchaInstance, scene, statusEl, containerEl, submitBtn);
      await loadCaptchaChallenge(scene, statusEl, containerEl, submitBtn);
      return captchaInstance;
    })();

    try {
      return await captchaLoading;
    } catch (error) {
      captchaLastError = error instanceof Error ? error : new Error('验证码初始化失败');
      captchaReady = false;
      captchaChecking = false;
      setCaptchaShellState(containerEl, 'error');
      setStatus(statusEl, captchaLastError.message || '验证码初始化失败', 'error');
      syncAuthSubmitButton(submitBtn, scene);
      throw captchaLastError;
    } finally {
      captchaLoading = null;
    }
  }

  function buildCaptchaSubmitPayload(scene) {
    if (captchaConfig && captchaConfig.enabled === false) {
      return {};
    }
    if (!captchaReady) {
      throw new Error('验证码尚未就绪，请稍候再试');
    }
    if (!captchaVerified) {
      throw new Error('请先完成安全验证');
    }

    return {
      provider: captchaConfig && captchaConfig.provider ? captchaConfig.provider : 'go-captcha',
      scene: scene,
      type: captchaConfig && captchaConfig.type ? captchaConfig.type : 'slide',
      captchaId: captchaConfig && captchaConfig.captchaId ? captchaConfig.captchaId : '',
      captchaKey: captchaKey,
      captchaValue: captchaValue,
      ticket: captchaTicket,
      verifiedAt: captchaVerifiedAt,
      submitMode: captchaConfig && captchaConfig.submitMode ? captchaConfig.submitMode : 'auto'
    };
  }

  async function resetCaptcha(scene, statusEl, containerEl, submitBtn, reason) {
    resetCaptchaVerification();
    captchaKey = '';
    captchaReady = false;
    captchaChecking = false;
    pendingAuthSubmit = null;
    closeCaptchaModal(scene, statusEl, containerEl, submitBtn, false);
    syncAuthSubmitButton(submitBtn, scene);

    if (!captchaConfig || captchaConfig.enabled === false || !captchaInstance) {
      return null;
    }

    return await loadCaptchaChallenge(scene, statusEl, containerEl, submitBtn, reason || '验证码已重置，请重新完成验证。');
  }

  function getUsernameValue() {
    var usernameInput = $('username');
    return usernameInput ? usernameInput.value.trim() : '';
  }

  function getIdentifierValue() {
    var identifierInput = $('identifier');
    return identifierInput ? identifierInput.value.trim() : '';
  }

  function getPasswordValue() {
    var passwordInput = $('password');
    return passwordInput ? passwordInput.value : '';
  }

  function isMeaningfulPasswordValue(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function getConfirmPasswordValue() {
    var confirmInput = $('confirm-password');
    return confirmInput ? confirmInput.value : '';
  }

  function isValidUsername(value) {
    return /^[a-z0-9](?:[a-z0-9._-]{2,30}[a-z0-9])?$/.test((value || '').trim().toLowerCase());
  }

  function isValidPassword(value) {
    return typeof value === 'string' && value.length >= 8 && value.length <= 72;
  }

  async function initAuthPage(mode) {
    var title = $('auth-title');
    var subtitle = $('auth-subtitle');
    var submit = $('submit-btn');
    var switchLink = $('switch-link');
    var switchText = $('switch-text');
    var form = $('auth-form');
    var status = $('form-status');
    var captchaStatus = $('captcha-status');
    var captchaContainer = $('captcha-container');
    var inviteCodeInput = $('invite-code');
    var inviteCodeFromQuery = getQueryParam('inviteCode');

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('captcha-modal-open');
    }
    pendingAuthSubmit = null;
    resetCaptchaVerification();
    captchaReady = false;
    captchaChecking = false;

    if (!form || !submit) {
      setStatus(status || captchaStatus, '页面初始化失败：缺少登录表单或提交按钮。', 'error');
      return;
    }

    if (mode === 'register') {
      if (title) title.textContent = '用户名密码注册';
      if (subtitle) subtitle.textContent = '请先设置用户名与密码，完成安全验证后自动注册并登录。';
      submit.textContent = '注册并登录';
      if (switchText) switchText.textContent = '已经有账号了？';
      if (switchLink) {
        switchLink.textContent = '去账号登录';
        switchLink.href = '/login.html';
      }
      if (inviteCodeInput && inviteCodeFromQuery && !inviteCodeInput.value) {
        inviteCodeInput.value = inviteCodeFromQuery;
      }
    } else {
      if (title) title.textContent = '用户名密码登录';
      if (subtitle) subtitle.textContent = '请输入注册时设置的用户名与密码，完成安全验证后进入业务页、个人中心与充值中心。';
      submit.textContent = '登录';
      if (switchText) switchText.textContent = '还没有账号？';
      if (switchLink) {
        switchLink.textContent = '去注册新账号';
        switchLink.href = '/register.html';
      }
    }

    submit.dataset.defaultText = submit.textContent;
    syncAuthSubmitButton(submit, mode);
    ensureCaptchaModalState(mode, captchaStatus || status, captchaContainer, submit);
    setCaptchaShellState(captchaContainer, '');
    setStatus(captchaStatus || status, '点击“' + getSubmitDefaultText(mode) + '”后会弹出安全验证。', 'info');

    var existingUser = null;
    try {
      existingUser = await validateToken();
    } catch (error) {
      setStatus(status || captchaStatus, error && error.message ? error.message : '登录态检查失败，请稍后重试。', 'info');
    }
    if (existingUser) {
      redirect('/index.html');
      return;
    }

    on(form, 'submit', async function (event) {
      event.preventDefault();
      var password = getPasswordValue();
      var payload = null;
      var endpoint = mode === 'register' ? '/api/auth/password/register' : '/api/auth/password/login';
      var loadingText = mode === 'register' ? '注册中...' : '登录中...';

      if (!isMeaningfulPasswordValue(password)) {
        setStatus(status, '请输入 8-72 位密码', 'error');
        $('password') && $('password').focus();
        return;
      }

      if (!isValidPassword(password)) {
        setStatus(status, '密码长度需为 8-72 位', 'error');
        $('password') && $('password').focus();
        return;
      }

      if (mode === 'register') {
        var username = getUsernameValue();
        var confirmPassword = getConfirmPasswordValue();
        if (!isValidUsername(username)) {
          setStatus(status, '用户名需为 4-32 位，仅支持字母、数字、点、下划线、短横线', 'error');
          $('username') && $('username').focus();
          return;
        }
        if (password !== confirmPassword) {
          setStatus(status, '两次输入的密码不一致', 'error');
          $('confirm-password') && $('confirm-password').focus();
          return;
        }

        payload = {
          username: username,
          password: password
        };
        if (inviteCodeInput && inviteCodeInput.value && inviteCodeInput.value.trim()) {
          payload.inviteCode = inviteCodeInput.value.trim();
        }
      } else {
        var identifier = getIdentifierValue();
        if (!isValidUsername(identifier)) {
          setStatus(status, '请输入注册时设置的用户名（4-32 位，仅支持字母、数字、点、下划线、短横线）', 'error');
          $('identifier') && $('identifier').focus();
          return;
        }

        payload = {
          username: identifier,
          password: password
        };
      }

      var executeAuthSubmit = async function () {
        try {
          payload.captcha = buildCaptchaSubmitPayload(mode);
        } catch (error) {
          setStatus(status, error && error.message ? error.message : '请先完成安全验证', 'error');
          setStatus(captchaStatus || status, error && error.message ? error.message : '请先完成安全验证', 'error');
          syncAuthSubmitButton(submit, mode);
          return;
        }

        setStatus(status, loadingText, 'info');
        setButtonLoading(submit, loadingText, true);
        try {
          var preparedPayload = await buildPasswordProtectedPayload(payload, password);
          var result = null;

          try {
            result = await request(endpoint, {
              method: 'POST',
              body: JSON.stringify(preparedPayload.payload)
            });
          } catch (error) {
            if (!shouldRetryWithFreshPasswordKey(error, preparedPayload)) {
              throw error;
            }

            preparedPayload = await buildPasswordProtectedPayload(payload, password, { forceRefreshKey: true });
            result = await request(endpoint, {
              method: 'POST',
              body: JSON.stringify(preparedPayload.payload)
            });
          }

          if (!result || !result.user || !(result.accessToken || result.token)) {
            throw new Error(mode === 'register' ? '注册成功响应不完整，请稍后重试。' : '登录成功响应不完整，请稍后重试。');
          }

          saveAuth(result);
          setStatus(status, mode === 'register' ? '注册成功，正在跳转...' : '登录成功，正在跳转...', 'success');
          setStatus(captchaStatus || status, '验证已完成，正在进入系统。', 'success');
          window.setTimeout(function () {
            redirect('/index.html');
          }, 300);
        } catch (error) {
          setStatus(status, getFriendlyAuthErrorMessage(error, mode), 'error');
          try {
            await resetCaptcha(mode, captchaStatus || status, captchaContainer, submit, '提交失败后已重置验证码，请重新完成验证。');
          } catch (captchaError) {
            setStatus(captchaStatus || status, captchaError && captchaError.message ? captchaError.message : '验证码重置失败，请刷新页面后重试', 'error');
            setCaptchaShellState(captchaContainer, 'error');
          }
        } finally {
          setButtonLoading(submit, loadingText, false);
          syncAuthSubmitButton(submit, mode);
        }
      };

      if (!(captchaConfig && captchaConfig.enabled === false) && !captchaVerified) {
        queuePendingAuthSubmit(executeAuthSubmit);
        openCaptchaModal(mode, captchaStatus || status, captchaContainer, submit);
        setCaptchaShellState(captchaContainer, captchaInstance ? 'ready' : 'loading');
        setStatus(captchaStatus || status, '请先完成安全验证，再继续' + (mode === 'register' ? '注册' : '登录') + '。', 'info');
        try {
          await ensureCaptchaReady(mode, captchaStatus || status, captchaContainer, submit);
          if (captchaConfig && captchaConfig.enabled === false) {
            pendingAuthSubmit = null;
            closeCaptchaModal(mode, captchaStatus || status, captchaContainer, submit, false);
            await executeAuthSubmit();
          }
        } catch (error) {
          pendingAuthSubmit = null;
          closeCaptchaModal(mode, captchaStatus || status, captchaContainer, submit, false);
          setStatus(captchaStatus || status, error && error.message ? error.message : '验证码初始化失败', 'error');
          setCaptchaShellState(captchaContainer, 'error');
          syncAuthSubmitButton(submit, mode);
        }
        return;
      }

      await executeAuthSubmit();
    });
  }

  async function initProtectedPage() {
    var gate = $('gate-loading');
    var shell = $('protected-shell');
    var user = await validateToken();

    if (!user) {
      redirect('/login.html');
      return;
    }

    setText('user-id', user.id || user.userId || '-');
    setText('user-account', user.account || user.username || user.phone || '-');
    setText('user-name', user.displayName || user.nickname || user.username || '未设置');
    setText('user-created-at', formatDate(user.createdAt || user.created_at));
    $('token-preview').textContent = getToken() || '-';

    $('logout-btn').addEventListener('click', function () {
      var refreshToken = getRefreshToken();
      var token = getToken();
      request('/api/auth/logout', {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: JSON.stringify({ refreshToken: refreshToken || undefined })
      }).catch(function () {
        return null;
      }).finally(function () {
        clearAuth();
        redirect('/login.html');
      });
    });

    gate.classList.add('hidden');
    shell.classList.remove('hidden');
  }

  function applyHomeTopbarAuthState() {
    var entryLinks = $('entry-links');
    if (!entryLinks) return;
    entryLinks.classList[getToken() ? 'add' : 'remove']('hidden');
  }

  function renderTaskList(tasks) {
    var list = $('task-list');
    if (!list) return;
    if (!tasks || !tasks.length) {
      list.innerHTML = '<div class="task-item"><div class="task-text">当前没有运行中的任务。</div></div>';
      return;
    }
    list.innerHTML = tasks.map(function (task) {
      return (
        '<div class="task-item">' +
          '<div class="task-meta"><strong>' + escapeHtml(task.status || '-') + '</strong><span>' + escapeHtml(task.progress || '') + '</span></div>' +
          '<div class="task-text">' + escapeHtml(task.goal || task.result || '-') + '</div>' +
          (task.lastLog ? '<div class="muted" style="margin-top:8px;">' + escapeHtml(task.lastLog) + '</div>' : '') +
        '</div>'
      );
    }).join('');
  }

  function renderMessages(history) {
    var list = $('message-list');
    if (!list) return;
    if (!history || !history.length) {
      list.innerHTML = '<div class="message-item"><div class="message-text">当前还没有对话记录。</div></div>';
      return;
    }
    list.innerHTML = history.slice(-80).map(function (item) {
      var role = item.role === 'user' ? '用户' : '问路';
      var roleClass = item.role === 'user' ? ' user' : '';
      return (
        '<div class="message-item' + roleClass + '">' +
          '<div class="message-meta"><span class="message-role">' + role + '</span><span>' + escapeHtml(formatDate(item.time)) + '</span></div>' +
          '<div class="message-text">' + escapeHtml(item.text || '') + '</div>' +
        '</div>'
      );
    }).join('');
    list.scrollTop = list.scrollHeight;
  }

  function appendEventMessage(role, text) {
    var list = $('message-list');
    if (!list) return;
    var item = document.createElement('div');
    item.className = 'message-item' + (role === 'user' ? ' user' : '');
    item.innerHTML =
      '<div class="message-meta"><span class="message-role">' + escapeHtml(role === 'user' ? '用户' : '问路') + '</span><span>' + escapeHtml(formatDate(new Date().toISOString())) + '</span></div>' +
      '<div class="message-text">' + escapeHtml(text || '') + '</div>';
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  }

  function updateBusinessStats(payload) {
    if (!payload) return;
    $('cycle-badge') && ($('cycle-badge').textContent = '循环 ' + (payload.cycles || 0));
    $('task-count-badge') && ($('task-count-badge').textContent = '任务 ' + ((payload.tasks && payload.tasks.length) || 0));
    $('belief-count') && ($('belief-count').textContent = payload.beliefCount || 0);
    $('understanding-text') && ($('understanding-text').textContent = payload.understanding || '-');
    $('say-count') && ($('say-count').textContent = payload.metrics ? (payload.metrics.sayCount || 0) : 0);
    $('exec-success') && ($('exec-success').textContent = payload.metrics ? ((payload.metrics.execSuccessCount || 0) + '/' + (payload.metrics.execCount || 0)) : '-');
    renderTaskList(payload.tasks || []);
    renderMessages(payload.history || []);
  }

  async function fetchBusinessState() {
    var history = await request('/history', { method: 'GET' });
    updateBusinessStats(history);
    return history;
  }

  function bindBusinessSse() {
    var badge = $('conn-badge');
    var status = $('event-status');
    var source = new EventSource('/events');

    function markConnected(text, type) {
      if (badge) badge.textContent = text;
      setStatus(status, text, type);
    }

    source.onopen = function () {
      markConnected('SSE 已连接', 'success');
      fetch('/ui-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ui-ready' })
      }).catch(function () { return null; });
    };

    source.onerror = function () {
      markConnected('SSE 连接中断，正在重连…', 'error');
    };

    source.addEventListener('tasks', function (event) {
      try {
        var payload = JSON.parse(event.data);
        $('task-count-badge') && ($('task-count-badge').textContent = '任务 ' + ((payload.tasks && payload.tasks.length) || 0));
        renderTaskList(payload.tasks || []);
      } catch (_) {}
    });

    source.addEventListener('growth', function (event) {
      try {
        var payload = JSON.parse(event.data);
        $('cycle-badge') && ($('cycle-badge').textContent = '循环 ' + (payload.cycles || 0));
        $('belief-count') && ($('belief-count').textContent = payload.beliefCount || 0);
        $('understanding-text') && ($('understanding-text').textContent = payload.understanding || '-');
      } catch (_) {}
    });

    source.addEventListener('say', function (event) {
      try {
        var payload = JSON.parse(event.data);
        appendEventMessage('wenlu', payload.text || '');
      } catch (_) {}
    });

    source.addEventListener('ask', function (event) {
      try {
        var payload = JSON.parse(event.data);
        appendEventMessage('wenlu', payload.question || '');
      } catch (_) {}
    });

    source.addEventListener('thinking', function () {
      setStatus(status, '系统正在处理中…', 'info');
    });

    source.addEventListener('idle', function () {
      setStatus(status, '系统空闲，等待下一条业务指令。', 'success');
    });
  }

  function scheduleOrderPolling(handler, currentOrders) {
    clearOrderPolling();
    if (!ORDER_POLL_ENABLED) {
      updateOrderPollBadge(false, '轮询已关闭');
      return;
    }
    var shouldPoll = hasPendingOrder(currentOrders);
    updateOrderPollBadge(shouldPoll, shouldPoll ? '轮询运行中（待支付订单监控中）' : '轮询待命（暂无待处理订单）');
    if (!shouldPoll || typeof handler !== 'function') return;
    ORDER_POLL_TIMER = window.setTimeout(async function () {
      if (ORDER_POLL_IN_FLIGHT) {
        scheduleOrderPolling(handler, currentOrders);
        return;
      }
      ORDER_POLL_IN_FLIGHT = true;
      try {
        await handler(true);
      } finally {
        ORDER_POLL_IN_FLIGHT = false;
      }
    }, ORDER_POLL_INTERVAL_MS);
  }

  async function initBusinessPage() {
    var gate = $('gate-loading');
    var shell = $('business-shell');
    var form = $('composer-form');
    var input = $('composer-input');
    var sendBtn = $('send-btn');
    var composerStatus = $('composer-status');
    var paymentSection = $('payment-guide-section');
    var planSection = $('plan-list');
    var defaultComposerPlaceholder = input && typeof input.getAttribute === 'function'
      ? (input.getAttribute('placeholder') || '')
      : '';

    if (!gate || !shell) {
      setStatus($('event-status'), '业务页初始化失败：缺少关键容器。', 'error');
      return;
    }

    var user = null;
    try {
      user = await validateToken();
    } catch (error) {
      setStatus($('event-status'), error && error.message ? error.message : '登录校验失败，请稍后重试', 'error');
    }
    if (!user) {
      redirect('/login.html');
      return;
    }

    var membership = normalizeMembership(user);
    var paymentOptions = await fetchPaymentOptionsSafe();
    var plans = normalizePlanList(paymentOptions);
    var remoteOrders = await fetchOrdersSafe();
    var orders = remoteOrders || [];
    var currentOrders = orders.slice();

    function applyBusinessAccessState() {
      var blocked = !!(membership && membership.allowed === false);
      if (input) {
        input.disabled = blocked;
        input.setAttribute('placeholder', blocked
          ? (membership && membership.reason ? membership.reason : '当前账号暂不可继续发送业务指令，请先开通会员。')
          : defaultComposerPlaceholder);
      }
      if (sendBtn) {
        sendBtn.disabled = blocked;
      }
      if (composerStatus) {
        composerStatus.textContent = blocked
          ? (membership && membership.reason ? membership.reason : '当前账号暂不可继续发送业务指令，请先开通会员。')
          : '已登录，可直接发送业务指令。';
      }
    }

    function updateCurrentOrders(nextOrders) {
      currentOrders = Array.isArray(nextOrders) ? nextOrders.slice() : [];
      scheduleOrderPolling(refreshOrders, currentOrders);
    }

    async function refreshOrders(silent) {
      var eventStatusEl = $('event-status');
      var latestOrders = await fetchOrdersSafe({ autoReconcile: !!silent });
      var sweepSummary = takeOrderSweepSummary();
      var nextOrders = latestOrders || currentOrders;
      var reconcileSummary = await autoReconcileOrders(nextOrders, eventStatusEl);
      if (reconcileSummary && reconcileSummary.changed) {
        var refreshedAfterReconcile = await fetchOrdersSafe();
        nextOrders = refreshedAfterReconcile || nextOrders;
      }
      renderOrderList(nextOrders, paymentOptions, updateCurrentOrders);
      updateCurrentOrders(nextOrders);
      scheduleOrderPolling(refreshOrders, currentOrders);
      var creditedCount = (reconcileSummary ? reconcileSummary.credited : 0) + getSweepCreditedCount(sweepSummary);
      var reviewCount = (reconcileSummary ? reconcileSummary.review : 0) + getSweepReviewCount(sweepSummary);
      if (creditedCount > 0) {
        await refreshMembership(true).catch(function () { return null; });
        setStatus(eventStatusEl, '检测到支付成功，会员已自动到账。', 'success');
      } else if (reviewCount > 0) {
        setStatus(eventStatusEl, '已自动核单，但当前订单需要人工复核。', 'info');
      } else if (!silent) {
        setStatus(eventStatusEl, latestOrders ? '订单列表已刷新。' : '订单接口暂不可用，已保留当前列表。', latestOrders ? 'success' : 'info');
      }
      return nextOrders;
    }

    async function refreshMembership(silent) {
      var latestUser = await validateToken();
      if (!latestUser) {
        clearOrderPolling();
        redirect('/login.html');
        return null;
      }
      user = latestUser;
      var latestPaymentOptions = await fetchPaymentOptionsSafe();
      membership = normalizeMembership(latestUser);
      paymentOptions = latestPaymentOptions || paymentOptions;
      plans = normalizePlanList(paymentOptions);
      renderMembershipCard(membership, latestUser);
      renderPlanList(plans, membership, latestUser, paymentOptions, updateCurrentOrders);
      renderPaymentGuide(paymentOptions);
      applyBusinessAccessState();
      if (!silent) {
        setStatus($('event-status'), '会员信息已刷新。', 'success');
      }
      return latestUser;
    }

    setText('user-id', user.id || user.userId || '-');
    setText('user-account', user.account || user.username || user.phone || '-');
    setText('user-name', user.displayName || user.nickname || user.username || '未设置');
    setText('user-created-at', formatDate(user.createdAt || user.created_at));

    renderMembershipCard(membership, user);
    renderPlanList(plans, membership, user, paymentOptions, updateCurrentOrders);
    renderOrderList(orders, paymentOptions, updateCurrentOrders);
    renderPaymentGuide(paymentOptions);
    applyBusinessAccessState();
    scheduleOrderPolling(refreshOrders, currentOrders);

    toggleHidden(gate, true);
    toggleHidden(shell, false);

    on($('logout-btn'), 'click', function () {
      var refreshToken = getRefreshToken();
      var token = getToken();
      clearOrderPolling();
      request('/api/auth/logout', {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: JSON.stringify({ refreshToken: refreshToken || undefined })
      }).catch(function () {
        return null;
      }).finally(function () {
        clearAuth();
        redirect('/login.html');
      });
    });

    on($('refresh-btn'), 'click', function () {
      fetchBusinessState().catch(function (error) {
        setStatus($('event-status'), error.message || '刷新失败', 'error');
      });
    });

    $('refresh-membership-btn') && $('refresh-membership-btn').addEventListener('click', async function () {
      try {
        user = await refreshMembership(false);
      } catch (error) {
        setStatus($('event-status'), error && error.message ? error.message : '会员信息刷新失败', 'error');
      }
    });

    $('refresh-orders-btn') && $('refresh-orders-btn').addEventListener('click', async function () {
      try {
        await refreshOrders(false);
      } catch (error) {
        setStatus($('event-status'), error && error.message ? error.message : '订单刷新失败', 'error');
      }
    });

    $('toggle-orders-poll-btn') && $('toggle-orders-poll-btn').addEventListener('click', function () {
      ORDER_POLL_ENABLED = !ORDER_POLL_ENABLED;
      scheduleOrderPolling(refreshOrders, currentOrders);
      setStatus($('event-status'), ORDER_POLL_ENABLED ? '订单轮询已开启。' : '订单轮询已关闭。', 'info');
    });

    $('jump-payment-btn') && $('jump-payment-btn').addEventListener('click', function () {
      if (paymentSection && typeof paymentSection.scrollIntoView === 'function') {
        paymentSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    $('jump-recharge-btn') && $('jump-recharge-btn').addEventListener('click', function () {
      redirect(!membership || !membership.isMember ? '/payment.html' : '/account.html');
    });

    on(form, 'submit', async function (event) {
      event.preventDefault();
      if (!input) {
        setStatus($('event-status'), '业务输入框不存在，无法发送指令。', 'error');
        return;
      }
      var text = input.value.trim();
      if (!text) {
        setStatus($('event-status'), '请输入业务指令后再发送。', 'error');
        return;
      }
      if (membership && membership.allowed === false) {
        applyBusinessAccessState();
        setStatus($('event-status'), membership.reason || '当前账号暂不可继续发送业务指令，请先开通会员。', 'error');
        return;
      }
      appendEventMessage('user', text);
      input.value = '';
      setButtonLoading(sendBtn, '发送中...', true);
      if (composerStatus) composerStatus.textContent = '正在提交业务指令…';
      try {
        var response = await request('/say', {
          method: 'POST',
          body: JSON.stringify({ text: text })
        });
        if (response && response.membershipAccess) {
          membership = Object.assign({}, membership || {}, response.membershipAccess);
          renderMembershipCard(membership, user);
        }
        if (composerStatus) composerStatus.textContent = '指令已发送，系统处理中。';
        setStatus($('event-status'), '指令已发出。', 'success');
      } catch (error) {
        if (error && error.response && error.response.membershipAccess) {
          membership = Object.assign({}, membership || {}, error.response.membershipAccess);
          renderMembershipCard(membership, user);
        }
        if (composerStatus) composerStatus.textContent = '发送失败，请稍后重试。';
        setStatus($('event-status'), error.message || '发送失败', 'error');
      } finally {
        setButtonLoading(sendBtn, '发送中...', false);
        applyBusinessAccessState();
      }
    });

    try {
      await fetchBusinessState();
      bindBusinessSse();
    } catch (error) {
      setStatus($('event-status'), error && error.message ? error.message : '业务状态加载失败', 'error');
    }
  }



  async function initPaymentPage() {
    var gate = $('gate-loading');
    var shell = $('payment-shell');
    var statusEl = $('payment-status');
    if (!gate || !shell) {
      setStatus(statusEl, '充值页初始化失败：缺少关键容器。', 'error');
      return;
    }
    var orderQueryId = getQueryParam('orderId');
    var planQueryId = getQueryParam('planId');
    var user = null;
    try {
      user = await validateToken();
    } catch (error) {
      setStatus(statusEl, error && error.message ? error.message : '登录校验失败，请稍后重试', 'error');
    }
    if (!user) {
      redirect('/login.html');
      return;
    }

    var paymentTools = window.WenluPayment || {};
    var paymentQrBuilder = typeof paymentTools.toQrDataUrl === 'function'
      ? paymentTools.toQrDataUrl
      : function (text) {
          if (window.WenluQRCode && typeof window.WenluQRCode.toDataUrl === 'function') {
            return window.WenluQRCode.toDataUrl(text, {
              cellSize: 8,
              margin: 4,
              darkColor: '#111827',
              lightColor: '#ffffff'
            });
          }
          return '';
        };
    var paymentCopyBuilder = typeof paymentTools.buildCopyText === 'function'
      ? paymentTools.buildCopyText
      : function (parts) {
          return (Array.isArray(parts) ? parts : []).filter(Boolean).join('\n');
        };

    var membership = normalizeMembership(user);
    var planSnapshot = await fetchPlansSnapshot();
    var paymentContext = { checkout: planSnapshot.checkout };
    var plans = planSnapshot.plans || [];
    var remoteOrders = await fetchOrdersSafe();
    var currentOrders = Array.isArray(remoteOrders) ? remoteOrders : readLocalOrders(user.id);
    var selectedOrder = getPreferredOrder(currentOrders, orderQueryId);
    var lastCopyOrderText = '';
    var lastCopyPaymentText = '';
    var paymentModal = $('payment-qr-modal');
    var paymentModalImage = $('payment-modal-image');
    var paymentModalEmpty = $('payment-modal-empty');
    var paymentModalHydrating = false;

    function closePaymentModal() {
      if (!paymentModal) return;
      paymentModal.classList.add('hidden');
      paymentModal.setAttribute('aria-hidden', 'true');
      if (document && document.body) document.body.style.overflow = '';
    }

    function isPaymentModalOpen() {
      return !!(paymentModal && !paymentModal.classList.contains('hidden'));
    }

    function openPaymentModal(order) {
      if (!paymentModal) return;
      renderPaymentModal(order);
      paymentModal.classList.remove('hidden');
      paymentModal.setAttribute('aria-hidden', 'false');
      if (document && document.body) document.body.style.overflow = 'hidden';
    }

    function renderPaymentModal(order) {
      var qrPayload = resolveOrderQrPayload(order, paymentContext);
      var qrSrc = '';
      if (qrPayload.type === 'image' && qrPayload.src) {
        qrSrc = qrPayload.src;
      } else if (qrPayload.src) {
        qrSrc = paymentQrBuilder(qrPayload.src, {
          title: order && (order.order_no || order.id || '支付二维码')
        });
      }

      $('payment-modal-title') && ($('payment-modal-title').textContent = order ? ('支付宝扫码支付 · ' + (order.plan_name || order.title || order.plan_id || '会员订单')) : '支付宝扫码支付');
      $('payment-modal-caption') && ($('payment-modal-caption').textContent = qrPayload.note || '订单已创建，请使用支付宝扫码完成支付。');
      $('payment-modal-order-no') && ($('payment-modal-order-no').textContent = order ? (order.order_no || order.id || '-') : '-');
      $('payment-modal-amount') && ($('payment-modal-amount').textContent = order ? formatPrice(order.amount_cents || 0) : '-');
      $('payment-modal-reference') && ($('payment-modal-reference').textContent = order ? (order.client_reference || '未返回') : '-');

      if (paymentModalImage) {
        if (qrSrc) {
          paymentModalImage.src = qrSrc;
          paymentModalImage.classList.remove('hidden');
          paymentModalEmpty && paymentModalEmpty.classList.add('hidden');
          if (statusEl) {
            setStatus(statusEl, '订单已创建，请扫码支付。', 'success');
          }
        } else {
          paymentModalImage.removeAttribute('src');
          paymentModalImage.classList.add('hidden');
          paymentModalEmpty && paymentModalEmpty.classList.remove('hidden');
          if (paymentModalEmpty) paymentModalEmpty.textContent = '二维码暂未准备好，请点击下方“刷新当前订单”。';
        }
      }
    }

    async function refreshSelectedOrderFromServer(showToast) {
      if (!selectedOrder || !selectedOrder.id) return null;
      selectedOrder = await hydrateOrderPaymentSession(selectedOrder, { refresh: true, extractQr: true });
      updateCurrentOrders(mergeOrderIntoList(currentOrders, selectedOrder));
      renderSelectedOrder(selectedOrder);
      renderPaymentModal(selectedOrder);
      if (showToast) {
        setStatus(statusEl, '订单已创建，请扫码支付。', 'success');
      }
      return selectedOrder;
    }

    async function hydrateOrderAndOpenModal(order) {
      selectedOrder = mergeOrderPaymentSession(order, order && order.paymentSession);
      renderSelectedOrder(selectedOrder);
      openPaymentModal(selectedOrder);
      try {
        var hydrated = await hydrateOrderPaymentSession(selectedOrder, { refresh: true, extractQr: true });
        if (hydrated && hydrated.id) {
          selectedOrder = hydrated;
          updateCurrentOrders(mergeOrderIntoList(currentOrders, hydrated));
          renderSelectedOrder(selectedOrder);
          renderPaymentModal(selectedOrder);
        }
      } catch (error) {
        setStatus(statusEl, error && error.message ? error.message : '订单二维码刷新失败', 'error');
      }
    }

    async function hydrateOrderPaymentSession(order, options) {
      if (!order || !order.id) return order;
      try {
        var detail = await fetchOrderDetail(order.id, options || { refresh: true, extractQr: true });
        var normalized = normalizeOrderDetailResult(detail);
        return normalized.order || mergeOrderPaymentSession(order, normalized.paymentSession);
      } catch (_) {
        return mergeOrderPaymentSession(order, order.paymentSession);
      }
    }

    function renderSummary() {
      var currentUser = user || getUser() || null;
      var isMember = !!(membership && membership.isMember);
      $('payment-user-badge') && ($('payment-user-badge').textContent = '账号 ' + getUserAccountLabel(currentUser));
      if ($('payment-member-badge')) {
        $('payment-member-badge').textContent = isMember ? ('会员 · ' + getMembershipPlanLabel(membership)) : '免费 · 免费体验';
        $('payment-member-badge').className = 'member-pill' + (isMember ? ' vip' : '');
      }
      $('summary-membership') && ($('summary-membership').textContent = getMembershipPlanLabel(membership));
      $('summary-expire') && ($('summary-expire').textContent = '到期时间：' + getMembershipExpireText(membership));
      $('summary-limit') && ($('summary-limit').textContent = membership && membership.isMember ? '会员不限量' : (membership && membership.dailyLimit != null ? ('剩余 ' + (membership.dailyRemaining == null ? '-' : membership.dailyRemaining) + ' 次') : '免费限制待确认'));
      $('summary-limit-detail') && ($('summary-limit-detail').textContent = getMembershipRestrictionText(membership) + ' ' + getMembershipTrialText(membership, currentUser));
    }

    function renderSelectedOrder(order) {
      var qrImage = $('qr-image');
      var qrEmpty = $('qr-empty');
      var qrWarning = $('qr-warning');
      var qrPayload = resolveOrderQrPayload(order, paymentContext);
      var remark = order
        ? ('建议备注：' + (order.order_no || order.id || '-') + (order.client_reference ? (' / ' + order.client_reference) : ''))
        : '-';

      if (!order) {
        $('qr-title') && ($('qr-title').textContent = '当前订单：未创建');
        $('qr-caption') && ($('qr-caption').textContent = '创建订单后，这里会显示可扫码内容与注意事项。');
        $('qr-order-no') && ($('qr-order-no').textContent = '-');
        $('qr-amount') && ($('qr-amount').textContent = '-');
        $('qr-client-reference') && ($('qr-client-reference').textContent = '-');
        $('qr-remark') && ($('qr-remark').textContent = '-');
        lastCopyOrderText = '';
        lastCopyPaymentText = '';
        if (qrImage) {
          qrImage.classList.add('hidden');
          qrImage.removeAttribute('src');
        }
        if (qrEmpty) qrEmpty.classList.remove('hidden');
        if (qrWarning) {
          qrWarning.classList.add('hidden');
          qrWarning.textContent = '';
        }
        return;
      }

      $('qr-title') && ($('qr-title').textContent = '当前订单：' + (order.plan_name || order.title || order.plan_id || '会员订单'));
      $('qr-caption') && ($('qr-caption').textContent = qrPayload.note || '请扫码完成付款后回到订单区核单。');
      $('qr-order-no') && ($('qr-order-no').textContent = order.order_no || order.id || '-');
      $('qr-amount') && ($('qr-amount').textContent = formatPrice(order.amount_cents || 0));
      $('qr-client-reference') && ($('qr-client-reference').textContent = order.client_reference || '未返回');
      $('qr-remark') && ($('qr-remark').textContent = remark);

      lastCopyOrderText = order.order_no || order.id || '';
      lastCopyPaymentText = paymentCopyBuilder([
        '订单号：' + (order.order_no || order.id || '-'),
        '金额：' + formatPrice(order.amount_cents || 0),
        order.client_reference ? ('联系方式：' + order.client_reference) : '',
        qrPayload.raw || ''
      ]);

      var qrSrc = '';
      if (qrPayload.type === 'image' && qrPayload.src) {
        qrSrc = qrPayload.src;
      } else if (qrPayload.src) {
        qrSrc = paymentQrBuilder(qrPayload.src, {
          title: order.order_no || order.id || '支付二维码'
        });
      }

      if (qrSrc && qrImage) {
        qrImage.src = qrSrc;
        qrImage.classList.remove('hidden');
        qrEmpty && qrEmpty.classList.add('hidden');
      } else {
        qrImage && qrImage.classList.add('hidden');
        qrImage && qrImage.removeAttribute('src');
        qrEmpty && qrEmpty.classList.remove('hidden');
      }

      if (qrWarning) {
        if (qrPayload.warning) {
          qrWarning.textContent = qrPayload.warning;
          qrWarning.classList.remove('hidden');
        } else {
          qrWarning.classList.add('hidden');
          qrWarning.textContent = '';
        }
      }
    }

    function rerenderOrders() {
      renderOrderList(currentOrders, paymentContext, updateCurrentOrders, {
        mode: 'payment',
        targetId: 'order-list',
        statusTargetId: 'payment-status',
        selectedOrderId: selectedOrder && selectedOrder.id ? selectedOrder.id : '',
        onSelect: async function (order) {
          rerenderOrders();
          await hydrateOrderAndOpenModal(order);
        }
      });
    }

    function updateCurrentOrders(nextOrders) {
      currentOrders = Array.isArray(nextOrders) ? nextOrders.slice().map(function (item) {
        return mergeOrderPaymentSession(item, item && item.paymentSession);
      }) : [];
      if (user && user.id) saveLocalOrders(user.id, currentOrders);
      selectedOrder = getPreferredOrder(currentOrders, selectedOrder && selectedOrder.id ? selectedOrder.id : orderQueryId);
      rerenderOrders();
      renderSelectedOrder(selectedOrder);
      if (isPaymentModalOpen()) {
        renderPaymentModal(selectedOrder);
        var selectedQr = resolveOrderQrPayload(selectedOrder, paymentContext);
        if (!paymentModalHydrating && selectedOrder && selectedOrder.id && (!selectedQr || !selectedQr.src)) {
          paymentModalHydrating = true;
          hydrateOrderPaymentSession(selectedOrder, { refresh: true, extractQr: true }).then(function (hydrated) {
            if (!hydrated || !hydrated.id) return;
            selectedOrder = hydrated;
            currentOrders = mergeOrderIntoList(currentOrders, hydrated);
            if (user && user.id) saveLocalOrders(user.id, currentOrders);
            rerenderOrders();
            renderSelectedOrder(selectedOrder);
            renderPaymentModal(selectedOrder);
          }).catch(function () {
            return null;
          }).finally(function () {
            paymentModalHydrating = false;
          });
        }
      }
      scheduleOrderPolling(refreshOrders, currentOrders);
    }

    async function refreshOrders(silent) {
      var latestOrders = await fetchOrdersSafe({ autoReconcile: !!silent });
      var sweepSummary = takeOrderSweepSummary();
      var nextOrders = Array.isArray(latestOrders) ? latestOrders : currentOrders;
      var reconcileSummary = await autoReconcileOrders(nextOrders, statusEl);
      if (reconcileSummary && reconcileSummary.changed) {
        var refreshedAfterReconcile = await fetchOrdersSafe();
        if (Array.isArray(refreshedAfterReconcile)) {
          nextOrders = refreshedAfterReconcile;
        }
      }
      if (Array.isArray(nextOrders)) {
        updateCurrentOrders(nextOrders);
      } else {
        scheduleOrderPolling(refreshOrders, currentOrders);
      }
      var creditedCount = (reconcileSummary ? reconcileSummary.credited : 0) + getSweepCreditedCount(sweepSummary);
      var reviewCount = (reconcileSummary ? reconcileSummary.review : 0) + getSweepReviewCount(sweepSummary);
      if (creditedCount > 0) {
        await refreshMembership(true).catch(function () { return null; });
        setStatus(statusEl, '检测到支付成功，会员已自动到账。', 'success');
      } else if (reviewCount > 0) {
        setStatus(statusEl, '已自动核单，但当前订单需要人工复核。', 'info');
      } else if (!silent) {
        setStatus(statusEl, Array.isArray(latestOrders) ? '订单列表已刷新。' : '订单接口暂不可用，已保留当前列表。', Array.isArray(latestOrders) ? 'success' : 'info');
      }
      return nextOrders;
    }

    async function refreshMembership(silent) {
      var latestUser = await validateToken();
      if (!latestUser) {
        clearOrderPolling();
        redirect('/login.html');
        return null;
      }
      var latestPlans = await fetchPlansSnapshot();
      user = latestUser;
      membership = normalizeMembership(latestUser);
      plans = latestPlans.plans || plans;
      paymentContext = { checkout: latestPlans.checkout || (paymentContext && paymentContext.checkout) };
      renderSummary();
      renderPlanList(plans, membership, user, paymentContext, updateCurrentOrders, {
        mode: 'payment',
        targetId: 'plan-list',
        statusTargetId: 'payment-status',
        autoReconcileOnFetch: false,
        orderSource: 'web-payment-page',
        onCreatingOrder: function (ctx) {
          var checkoutInfo = getCheckoutInfo(ctx && ctx.checkout ? ctx.checkout : paymentContext) || {};
          var placeholderReference = getUserPhoneLabel(user);
          if (!placeholderReference || placeholderReference === '-') {
            placeholderReference = checkoutInfo.supportContact || '待返回';
          }
          selectedOrder = {
            id: '',
            order_no: '',
            plan_id: ctx && ctx.plan ? ctx.plan.id : '',
            plan_name: ctx && ctx.plan ? ctx.plan.name : '会员订单',
            title: ctx && ctx.plan ? ctx.plan.name : '会员订单',
            amount_cents: ctx && ctx.plan ? Number(ctx.plan.price_cents || 0) : 0,
            client_reference: placeholderReference,
            paymentSession: {
              provider: 'ldxp_storefront',
              available: false,
              status: 'pending',
              qrDataUrl: '',
              paymentUrl: '',
              reason: '订单已创建，请扫码支付。二维码生成中，请稍候…',
              warnings: []
            }
          };
          renderSelectedOrder(selectedOrder);
          openPaymentModal(selectedOrder);
          setStatus(statusEl, '正在创建订单并解析支付二维码，请稍候…', 'info');
        },
        onCreateOrder: async function (ctx) {
          if (ctx && ctx.checkout) {
            paymentContext = { checkout: ctx.checkout };
          }
          var createdPaymentSession = ctx && ctx.created ? ctx.created.paymentSession : null;
          var createdOrder = ctx && ctx.order ? mergeOrderPaymentSession(ctx.order, createdPaymentSession) : null;
          updateCurrentOrders(createdOrder ? mergeOrderIntoList(ctx && ctx.orders ? ctx.orders : currentOrders, createdOrder) : (ctx && ctx.orders ? ctx.orders : currentOrders));
          if (ctx && ctx.order) {
            selectedOrder = createdOrder || ctx.order;
            rerenderOrders();
            renderSelectedOrder(selectedOrder);
            openPaymentModal(selectedOrder);
            refreshSelectedOrderFromServer(false).catch(function () {
              return null;
            });
          }
          return { orders: currentOrders.slice() };
        }
      });
      rerenderOrders();
      renderSelectedOrder(selectedOrder);
      if (!silent) {
        setStatus(statusEl, '会员与套餐信息已刷新。', 'success');
      }
      return latestUser;
    }

    renderSummary();
    await refreshMembership(true);
    updateCurrentOrders(currentOrders);

    toggleHidden(gate, true);
    toggleHidden(shell, false);

    if (selectedOrder && selectedOrder.id && orderQueryId) {
      openPaymentModal(selectedOrder);
      hydrateOrderPaymentSession(selectedOrder, { refresh: true, extractQr: true }).then(function (hydrated) {
        if (!hydrated || !hydrated.id) return;
        selectedOrder = hydrated;
        updateCurrentOrders(mergeOrderIntoList(currentOrders, selectedOrder));
        renderSelectedOrder(selectedOrder);
        renderPaymentModal(selectedOrder);
      }).catch(function (error) {
        setStatus(statusEl, error && error.message ? error.message : '订单二维码刷新失败', 'error');
      });
    }
    if (planQueryId) {
      setStatus(statusEl, '已按当前链接携带的套餐参数载入页面，你可以直接点击对应套餐下单。', 'info');
    }

    $('refresh-membership-btn') && $('refresh-membership-btn').addEventListener('click', function () {
      refreshMembership(false).catch(function (error) {
        setStatus(statusEl, error && error.message ? error.message : '会员信息刷新失败', 'error');
      });
    });

    $('refresh-orders-btn') && $('refresh-orders-btn').addEventListener('click', function () {
      refreshOrders(false).catch(function (error) {
        setStatus(statusEl, error && error.message ? error.message : '订单刷新失败', 'error');
      });
    });

    $('toggle-orders-poll-btn') && $('toggle-orders-poll-btn').addEventListener('click', function () {
      ORDER_POLL_ENABLED = !ORDER_POLL_ENABLED;
      scheduleOrderPolling(refreshOrders, currentOrders);
      setStatus(statusEl, ORDER_POLL_ENABLED ? '订单轮询已开启。' : '订单轮询已关闭。', 'info');
    });

    $('copy-order-btn') && $('copy-order-btn').addEventListener('click', function () {
      copyTextToClipboard(lastCopyOrderText).then(function (ok) {
        setStatus(statusEl, ok ? '订单号已复制。' : '订单号复制失败，请手动复制。', ok ? 'success' : 'error');
      });
    });

    $('copy-link-btn') && $('copy-link-btn').addEventListener('click', function () {
      copyTextToClipboard(lastCopyPaymentText).then(function (ok) {
        setStatus(statusEl, ok ? '支付内容已复制。' : '支付内容复制失败，请手动复制。', ok ? 'success' : 'error');
      });
    });

    $('payment-modal-close') && $('payment-modal-close').addEventListener('click', closePaymentModal);
    $('payment-qr-modal-backdrop') && $('payment-qr-modal-backdrop').addEventListener('click', closePaymentModal);
    $('payment-modal-copy-order') && $('payment-modal-copy-order').addEventListener('click', function () {
      copyTextToClipboard(lastCopyOrderText).then(function (ok) {
        setStatus(statusEl, ok ? '订单号已复制。' : '订单号复制失败，请手动复制。', ok ? 'success' : 'error');
      });
    });
    $('payment-modal-copy-pay') && $('payment-modal-copy-pay').addEventListener('click', function () {
      copyTextToClipboard(lastCopyPaymentText).then(function (ok) {
        setStatus(statusEl, ok ? '支付内容已复制。' : '支付内容复制失败，请手动复制。', ok ? 'success' : 'error');
      });
    });
    $('payment-modal-refresh') && $('payment-modal-refresh').addEventListener('click', function () {
      refreshSelectedOrderFromServer(true).catch(function (error) {
        setStatus(statusEl, error && error.message ? error.message : '订单二维码刷新失败', 'error');
      });
    });

    on($('logout-btn'), 'click', function () {
      var refreshToken = getRefreshToken();
      var token = getToken();
      clearOrderPolling();
      request('/api/auth/logout', {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: JSON.stringify({ refreshToken: refreshToken || undefined })
      }).catch(function () {
        return null;
      }).finally(function () {
        clearAuth();
        redirect('/login.html');
      });
    });
  }

  async function initAccountPage() {
    var gate = $('gate-loading');
    var shell = $('account-shell');
    var statusEl = $('account-status');
    if (!gate || !shell) {
      setStatus(statusEl, '个人中心初始化失败：缺少关键容器。', 'error');
      return;
    }
    var user = null;
    try {
      user = await validateToken();
    } catch (error) {
      setStatus(statusEl, error && error.message ? error.message : '登录校验失败，请稍后重试', 'error');
    }
    if (!user) {
      redirect('/login.html');
      return;
    }

    var membership = normalizeMembership(user);
    var planSnapshot = await fetchPlansSnapshot();
    var paymentContext = { checkout: planSnapshot.checkout };
    var plans = planSnapshot.plans || [];
    var remoteOrders = await fetchOrdersSafe();
    var currentOrders = Array.isArray(remoteOrders) ? remoteOrders : readLocalOrders(user.id);

    function renderProfile() {
      var invite = buildInviteSummary(user);
      var isMember = !!(membership && membership.isMember);
      $('account-user-badge') && ($('account-user-badge').textContent = '账号 ' + getUserAccountLabel(user));
      if ($('account-member-badge')) {
        $('account-member-badge').textContent = isMember ? ('会员 · ' + getMembershipPlanLabel(membership)) : '免费 · 免费体验';
        $('account-member-badge').className = 'member-pill' + (isMember ? ' vip' : '');
      }
      $('membership-summary-title') && ($('membership-summary-title').textContent = getMembershipPlanLabel(membership));
      $('membership-summary-text') && ($('membership-summary-text').textContent = getMembershipSummaryText(membership));
      $('membership-limit') && ($('membership-limit').textContent = membership && membership.isMember ? '会员不限量' : (membership && membership.dailyLimit != null ? ('剩余 ' + (membership.dailyRemaining == null ? '-' : membership.dailyRemaining) + ' 次') : '待确认'));
      $('membership-trial') && ($('membership-trial').textContent = getMembershipTrialText(membership, user));
      $('invite-count') && ($('invite-count').textContent = String(invite.invitedCount || 0));
      $('invite-status') && ($('invite-status').textContent = invite.hasInviteData
        ? ((invite.rewardStatusText ? (invite.rewardStatusText + '；') : '') + '邀请码：' + (invite.inviteCode || '待返回') + '，可分享给新用户注册。')
        : '当前 /api/auth/me 暂未返回邀请字段，前端已兼容展示。');

      $('profile-phone') && ($('profile-phone').textContent = getUserPhoneLabel(user));
      $('membership-expire') && ($('membership-expire').textContent = getMembershipExpireText(membership));
      $('membership-plan') && ($('membership-plan').textContent = getMembershipPlanLabel(membership));
      $('membership-usage') && ($('membership-usage').textContent = getMembershipUsageText(membership));
      $('invite-code') && ($('invite-code').textContent = invite.inviteCode || '待后端返回');
      $('invite-share-link') && ($('invite-share-link').textContent = invite.inviteLink || '待后端返回邀请码后生成');
      $('invite-reward-progress') && ($('invite-reward-progress').textContent = invite.rewardStatusText || '邀请奖励进度会在这里显示');
      $('invite-reward-total') && ($('invite-reward-total').textContent = invite.grantedCount > 0 ? ('已获 ' + invite.grantedCount + ' 次，共 ' + invite.totalRewardDays + ' 天') : '暂未获得邀请奖励');
      $('invite-reward-latest') && ($('invite-reward-latest').textContent = invite.latestReward ? ('最近到账：' + Number(invite.latestReward.rewardDurationDays || 0) + ' 天，到账时间 ' + formatDate(invite.latestReward.grantedAt)) : '暂无最近奖励记录');
    }

    function updateCurrentOrders(nextOrders) {
      currentOrders = Array.isArray(nextOrders) ? nextOrders.slice() : [];
      if (user && user.id) saveLocalOrders(user.id, currentOrders);
      renderOrderList(currentOrders, paymentContext, updateCurrentOrders, {
        mode: 'account',
        targetId: 'order-list',
        statusTargetId: 'account-status',
        autoReconcileOnFetch: true,
        onReconcileFinished: async function (ctx) {
          if (ctx && ctx.result && ctx.result.autoCredited) {
            await refreshMembership(true).catch(function () { return null; });
          }
        }
      });
      scheduleOrderPolling(refreshOrders, currentOrders);
    }

    async function refreshOrders(silent) {
      var latestOrders = await fetchOrdersSafe({ autoReconcile: !!silent });
      var sweepSummary = takeOrderSweepSummary();
      var nextOrders = Array.isArray(latestOrders) ? latestOrders : currentOrders;
      var reconcileSummary = await autoReconcileOrders(nextOrders, statusEl);
      if (reconcileSummary && reconcileSummary.changed) {
        var refreshedAfterReconcile = await fetchOrdersSafe();
        if (Array.isArray(refreshedAfterReconcile)) {
          nextOrders = refreshedAfterReconcile;
        }
      }
      if (Array.isArray(nextOrders)) {
        updateCurrentOrders(nextOrders);
      } else {
        scheduleOrderPolling(refreshOrders, currentOrders);
      }
      var creditedCount = (reconcileSummary ? reconcileSummary.credited : 0) + getSweepCreditedCount(sweepSummary);
      var reviewCount = (reconcileSummary ? reconcileSummary.review : 0) + getSweepReviewCount(sweepSummary);
      if (creditedCount > 0) {
        await refreshMembership(true).catch(function () { return null; });
        setStatus(statusEl, '检测到支付成功，会员已自动到账。', 'success');
      } else if (reviewCount > 0) {
        setStatus(statusEl, '已自动核单，但当前订单需要人工复核。', 'info');
      } else if (!silent) {
        setStatus(statusEl, Array.isArray(latestOrders) ? '订单列表已刷新。' : '订单接口暂不可用，已保留当前列表。', Array.isArray(latestOrders) ? 'success' : 'info');
      }
      return nextOrders;
    }

    async function refreshMembership(silent) {
      var latestUser = await validateToken();
      if (!latestUser) {
        clearOrderPolling();
        redirect('/login.html');
        return null;
      }
      var latestPlans = await fetchPlansSnapshot();
      user = latestUser;
      membership = normalizeMembership(latestUser);
      plans = latestPlans.plans || plans;
      paymentContext = { checkout: latestPlans.checkout || (paymentContext && paymentContext.checkout) };
      renderProfile();
      renderPlanList(plans, membership, user, paymentContext, updateCurrentOrders, {
        mode: 'account-preview',
        targetId: 'plan-preview-list',
        statusTargetId: 'account-status'
      });
      if (!silent) {
        setStatus(statusEl, '个人中心信息已刷新。', 'success');
      }
      return latestUser;
    }

    renderProfile();
    await refreshMembership(true);
    updateCurrentOrders(currentOrders);

    toggleHidden(gate, true);
    toggleHidden(shell, false);

    $('refresh-membership-btn') && $('refresh-membership-btn').addEventListener('click', function () {
      refreshMembership(false).catch(function (error) {
        setStatus(statusEl, error && error.message ? error.message : '会员信息刷新失败', 'error');
      });
    });

    $('refresh-orders-btn') && $('refresh-orders-btn').addEventListener('click', function () {
      refreshOrders(false).catch(function (error) {
        setStatus(statusEl, error && error.message ? error.message : '订单刷新失败', 'error');
      });
    });

    $('toggle-orders-poll-btn') && $('toggle-orders-poll-btn').addEventListener('click', function () {
      ORDER_POLL_ENABLED = !ORDER_POLL_ENABLED;
      scheduleOrderPolling(refreshOrders, currentOrders);
      setStatus(statusEl, ORDER_POLL_ENABLED ? '订单轮询已开启。' : '订单轮询已关闭。', 'info');
    });

    $('copy-invite-btn') && $('copy-invite-btn').addEventListener('click', function () {
      var inviteText = $('invite-share-link') ? $('invite-share-link').textContent || '' : '';
      copyTextToClipboard(inviteText).then(function (ok) {
        setStatus(statusEl, ok ? '邀请链接已复制。' : '邀请链接复制失败，请手动复制。', ok ? 'success' : 'error');
      });
    });

    on($('logout-btn'), 'click', function () {
      var refreshToken = getRefreshToken();
      var token = getToken();
      clearOrderPolling();
      request('/api/auth/logout', {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: JSON.stringify({ refreshToken: refreshToken || undefined })
      }).catch(function () {
        return null;
      }).finally(function () {
        clearAuth();
        redirect('/login.html');
      });
    });
  }

  function exposePublicAuthApi() {
    if (typeof window === 'undefined') return;
    window.WenluAuth = {
      getToken: getToken,
      getRefreshToken: getRefreshToken,
      getUser: getUser,
      clearAuth: clearAuth,
      request: request,
      validateToken: validateToken,
      redirect: redirect,
      setStatus: setStatus,
      setButtonLoading: setButtonLoading,
      formatDate: formatDate,
      formatPrice: formatPrice,
      escapeHtml: escapeHtml,
      normalizeMembership: normalizeMembership,
      normalizePlanList: normalizePlanList,
      getFeatureText: getFeatureText,
      fetchPaymentOptions: fetchPaymentOptionsSafe,
      fetchPlansSnapshot: fetchPlansSnapshot,
      fetchOrders: fetchOrdersSafe,
      fetchOrderDetail: fetchOrderDetail,
      createOrder: createRemoteOrder,
      reconcileOrder: reconcileRemoteOrder,
      normalizeOrderStatusLabel: normalizeOrderStatusLabel,
      buildClientReferenceHint: buildClientReferenceHint,
      getCheckoutInfo: getCheckoutInfo,
      hasPendingOrder: hasPendingOrder,
      buildInviteSummary: buildInviteSummary,
      resolveOrderQrPayload: resolveOrderQrPayload,
      copyTextToClipboard: copyTextToClipboard,
      initPaymentPage: initPaymentPage,
      initAccountPage: initAccountPage
    };
  }

  exposePublicAuthApi();

  window.__wenluCaptchaDebug = {
    getInstance: function () { return captchaInstance; },
    dump: function () {
      return {
        hasGoCaptcha: !!window.GoCaptcha,
        captchaReady: captchaReady,
        captchaChecking: captchaChecking,
        captchaVerified: captchaVerified,
        captchaTicketPresent: !!captchaTicket,
        captchaLastError: captchaLastError ? captchaLastError.message : null,
        captchaConfig: captchaConfig,
        pendingAuthSubmit: !!pendingAuthSubmit
      };
    }
  };
  window.__wenluLegacyCaptchaDebug = window.__wenluCaptchaDebug;

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body ? document.body.getAttribute('data-page') : '';
    scheduleTokenRefresh();
    if (page === 'login' || page === 'register') {
      initAuthPage(page);
      return;
    }
    if (page === 'home') {
      applyHomeTopbarAuthState();
      return;
    }
    if (page === 'protected') {
      initProtectedPage();
      return;
    }
    if (page === 'payment') {
      initPaymentPage();
      return;
    }
    if (page === 'account') {
      initAccountPage();
      return;
    }
    if (page === 'business') {
      initBusinessPage();
    }
  });
})();
