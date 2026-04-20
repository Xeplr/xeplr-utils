/**
 * SMS Service — generic wrapper for any SMS provider.
 *
 * Each provider is an HTTP API definition with multiple actions.
 * Register providers once, then send via provider + action name.
 *
 * Usage:
 *
 *   var sms = require('@xeplr/utils').sms;
 *
 *   // Simple provider — single action (default)
 *   sms.register('twilio', {
 *     actions: {
 *       send: {
 *         url: 'https://api.twilio.com/2010-04-01/Accounts/{{accountSid}}/Messages.json',
 *         method: 'POST',
 *         auth: { user: '{{accountSid}}', password: '{{authToken}}' },
 *         contentType: 'form',
 *         body: { From: '{{from}}', To: '{{to}}', Body: '{{message}}' }
 *       }
 *     },
 *     params: { accountSid: 'AC...', authToken: '...', from: '+1234567890' }
 *   });
 *
 *   // Provider with multiple actions + chained auth
 *   sms.register('kaleyra', {
 *     actions: {
 *       auth: {
 *         url: 'https://api.kaleyra.io/v1/{{sid}}/auth/token',
 *         method: 'POST',
 *         contentType: 'json',
 *         body: { api_key: '{{apiKey}}' },
 *         extract: { token: 'data.token' }   // extract token from response into params
 *       },
 *       otp: {
 *         url: 'https://api.kaleyra.io/v1/{{sid}}/messages',
 *         method: 'POST',
 *         headers: { Authorization: 'Bearer {{token}}' },
 *         contentType: 'json',
 *         body: { to: '{{to}}', type: 'OTP', body: '{{message}}' },
 *         before: ['auth']   // run auth action first, merge extracted params
 *       },
 *       promo: {
 *         url: 'https://api.kaleyra.io/v1/{{sid}}/messages',
 *         method: 'POST',
 *         headers: { Authorization: 'Bearer {{token}}' },
 *         contentType: 'json',
 *         body: { to: '{{to}}', type: 'PROMO', body: '{{message}}' },
 *         before: ['auth']
 *       }
 *     },
 *     params: { sid: '...', apiKey: '...' }
 *   });
 *
 *   // Send
 *   await sms.send('twilio', { to: '+91...', message: 'Hello!' });
 *   await sms.send('kaleyra', 'otp', { to: '+91...', message: 'OTP: 1234' });
 *   await sms.send('kaleyra', 'promo', { to: '+91...', message: 'Sale!' });
 */

var _providers = {};
var _defaultProvider = null;

/**
 * Register an SMS provider.
 *
 * @param {string} name - Provider name
 * @param {object} config
 * @param {object} config.actions - Named actions { actionName: { url, method, headers, auth, contentType, body, before, extract } }
 * @param {object} [config.params] - Default params shared across all actions
 * @param {function} [config.parseResponse] - Custom response parser for all actions
 */
function register(name, config) {
  _providers[name] = config;
}

/**
 * Set the default provider.
 */
function setDefault(name) {
  _defaultProvider = name;
}

function _resolvePlaceholders(str, params) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, function(match, key) {
    return params[key] !== undefined ? String(params[key]) : match;
  });
}

function _resolveObject(obj, params) {
  if (typeof obj === 'string') return _resolvePlaceholders(obj, params);
  if (Array.isArray(obj)) return obj.map(function(v) { return _resolveObject(v, params); });
  if (obj && typeof obj === 'object') {
    var resolved = {};
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      resolved[keys[i]] = _resolveObject(obj[keys[i]], params);
    }
    return resolved;
  }
  return obj;
}

/**
 * Extract a nested value from an object using dot notation.
 * e.g. _extractPath({ data: { token: 'abc' } }, 'data.token') => 'abc'
 */
function _extractPath(obj, path) {
  var parts = path.split('.');
  var val = obj;
  for (var i = 0; i < parts.length; i++) {
    if (val == null) return undefined;
    val = val[parts[i]];
  }
  return val;
}

/**
 * Execute a single action against a provider.
 */
async function _executeAction(action, params) {
  var url = _resolvePlaceholders(action.url, params);
  var method = (action.method || 'POST').toUpperCase();

  var headers = {};
  if (action.headers) {
    headers = _resolveObject(action.headers, params);
  }

  var fetchOptions = { method: method, headers: {} };

  // Basic auth
  if (action.auth) {
    var user = _resolvePlaceholders(action.auth.user, params);
    var password = _resolvePlaceholders(action.auth.password, params);
    fetchOptions.headers['Authorization'] = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
  }

  Object.assign(fetchOptions.headers, headers);

  // Body
  if (action.body) {
    var body = _resolveObject(action.body, params);
    var contentType = action.contentType || 'json';

    if (contentType === 'form') {
      fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      var parts = [];
      var bodyKeys = Object.keys(body);
      for (var i = 0; i < bodyKeys.length; i++) {
        parts.push(encodeURIComponent(bodyKeys[i]) + '=' + encodeURIComponent(body[bodyKeys[i]]));
      }
      fetchOptions.body = parts.join('&');
    } else {
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }
  }

  var res = await fetch(url, fetchOptions);
  var raw;
  try {
    raw = await res.json();
  } catch (e) {
    raw = null;
  }

  return { ok: res.ok, status: res.status, raw: raw };
}

/**
 * Send an SMS.
 *
 * Signatures:
 *   send('twilio', { to, message })              — uses 'send' action
 *   send('kaleyra', 'otp', { to, message })      — uses named action
 *   send({ to, message })                         — uses default provider + 'send' action
 *
 * @returns {Promise<{ success, messageId?, raw?, error? }>}
 */
async function send(providerName, actionOrParams, sendParams) {
  // Resolve arguments
  var actionName, params;

  if (typeof providerName === 'object') {
    // send({ to, message }) — default provider, 'send' action
    params = providerName;
    providerName = _defaultProvider;
    actionName = 'send';
  } else if (typeof actionOrParams === 'string') {
    // send('provider', 'action', { to, message })
    actionName = actionOrParams;
    params = sendParams || {};
  } else {
    // send('provider', { to, message }) — 'send' action
    actionName = 'send';
    params = actionOrParams || {};
  }

  if (!providerName) {
    throw new Error('SMS provider name required. Call sms.setDefault() or pass provider name.');
  }

  var config = _providers[providerName];
  if (!config) {
    throw new Error('SMS provider "' + providerName + '" not registered.');
  }

  var action = config.actions[actionName];
  if (!action) {
    throw new Error('Action "' + actionName + '" not found on provider "' + providerName + '".');
  }

  // Merge default params with send-time params
  var mergedParams = Object.assign({}, config.params || {}, params);

  // Run prerequisite actions (e.g. auth)
  if (action.before && action.before.length) {
    for (var i = 0; i < action.before.length; i++) {
      var beforeName = action.before[i];
      var beforeAction = config.actions[beforeName];
      if (!beforeAction) {
        throw new Error('Before-action "' + beforeName + '" not found on provider "' + providerName + '".');
      }

      var beforeResult = await _executeAction(beforeAction, mergedParams);
      if (!beforeResult.ok) {
        return {
          success: false,
          error: 'Pre-action "' + beforeName + '" failed with status ' + beforeResult.status,
          raw: beforeResult.raw
        };
      }

      // Extract values from response into params
      if (beforeAction.extract && beforeResult.raw) {
        var extractKeys = Object.keys(beforeAction.extract);
        for (var j = 0; j < extractKeys.length; j++) {
          var paramKey = extractKeys[j];
          var responsePath = beforeAction.extract[paramKey];
          mergedParams[paramKey] = _extractPath(beforeResult.raw, responsePath);
        }
      }
    }
  }

  // Execute main action
  var result = await _executeAction(action, mergedParams);

  // Custom response parser
  if (config.parseResponse) {
    return config.parseResponse(result.raw, result);
  }

  if (!result.ok) {
    return {
      success: false,
      error: (result.raw && (result.raw.message || result.raw.error || result.raw.error_message)) || 'SMS failed with status ' + result.status,
      raw: result.raw
    };
  }

  return {
    success: true,
    messageId: result.raw && (result.raw.sid || result.raw.messageId || result.raw.message_id || result.raw.id) || null,
    raw: result.raw
  };
}

/**
 * Get list of registered provider names.
 */
function getProviders() {
  return Object.keys(_providers);
}

module.exports = { register, setDefault, send, getProviders };
