/*
 * dsh-session-settings — browser half (T4/T5).
 *
 * Registers one native right-sidebar tab through the official registry
 * (sidebarRightTabs), renders the per-session settings page, and provides the
 * browser-side sessionSettings service other client plugins consume.
 *
 * Wire contract: docs/protocol-v1.md (frozen). The host methods, in full:
 *   registrations.list / values.get / values.set / values.reset
 * There is no other transport, no import beyond the module table's react, and
 * no build step: this file is the shipped artifact. Style uses host theme
 * tokens only; copy comes from the registrant's locale dictionary with a
 * built-in zh/en fallback that follows the host language.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-settings',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    /* ------------------------------------------------------------ contract */

    var SERVICE_KEY = 'sessionSettings'
    var TAB_ID = 'session-settings'
    var TAB_KIND = 'session-settings'
    /** Host route prefix (protocol §1): the client must build it relative to
     *  the page base — a leading slash would drop a reverse-proxy prefix. */
    var ROUTE_PREFIX = 'session-settings/api/'
    var METHOD_LIST = 'registrations.list'
    var METHOD_GET = 'values.get'
    var METHOD_SET = 'values.set'
    var METHOD_RESET = 'values.reset'
    /** Placeholder origin for the non-DOM case; never actually requested. */
    var PLACEHOLDER_ORIGIN = 'http://dsh.internal/'
    /** Codes that mean "the bridge or the storage behind it cannot be used":
     *  the page keeps rendering but every control goes read-only. */
    var READ_ONLY_CODES = {
      forbidden: true,
      'method-not-allowed': true,
      'unknown-method': true,
      'storage-unavailable': true,
      network: true,
    }
    var PLUGIN_TAG = '[dsh-session-settings]'

    /* --------------------------------------------------------------- copy */

    /** Built-in dictionaries. Own UI strings only — texts that arrive from a
     *  registrant go through that registrant's dictionary first. */
    var OWN_TEXT = {
      zh: {
        title: '会话设置',
        tabDescription: '每个会话独立的插件配置',
        sessionLabel: '当前会话',
        changed: '本会话已改 {n} 项',
        unchanged: '本会话尚未修改任何配置',
        resetAll: '全部恢复默认',
        confirmResetAll: '确认全部恢复？',
        resetGroup: '整组恢复',
        confirmResetGroup: '确认整组恢复？',
        resetItem: '恢复默认',
        overridden: '已覆盖',
        defaultValue: '默认：{value}',
        loading: '正在读取设置…',
        retry: '重试',
        readOnly: '只读',
        emptyTitle: '当前没有插件注册会话设置',
        emptyBody: '插件在宿主侧调用 ctx.sessionSettings.register(...) 注册声明式选项后，它们的配置会按插件分组出现在这里。',
        noItems: '该插件没有声明任何配置项。',
        noSession: '还没有选中的会话，无法读取会话设置。',
        linesHint: '每行一项',
        dismiss: '知道了',
        errorTitle: '读取会话设置失败',
        errorBody: '读取失败时不会显示任何可写控件，以免把未知的值写回宿主。请重试，或稍后再打开本页。',
        numberInvalid: '请输入数字',
        controlUnavailable: '这个选项由它自己的插件控件编辑。控件当前没有加载，所以这里不能修改，已有的配置保持不变。',
      },
      en: {
        title: 'Session settings',
        tabDescription: 'Per-session plugin configuration',
        sessionLabel: 'Session',
        changed: '{n} changed in this session',
        unchanged: 'Nothing changed in this session yet',
        resetAll: 'Reset all',
        confirmResetAll: 'Confirm reset all?',
        resetGroup: 'Reset group',
        confirmResetGroup: 'Confirm group reset?',
        resetItem: 'Reset',
        overridden: 'overridden',
        defaultValue: 'default: {value}',
        loading: 'Loading settings…',
        retry: 'Retry',
        readOnly: 'Read-only',
        emptyTitle: 'No plugin registers session settings yet',
        emptyBody: 'Once a plugin calls ctx.sessionSettings.register(...) on the host side, its options appear here grouped by plugin.',
        noItems: 'This plugin declares no items.',
        noSession: 'No session is selected, so session settings cannot be read.',
        linesHint: 'one entry per line',
        dismiss: 'Dismiss',
        errorTitle: 'Could not read session settings',
        errorBody: 'No writable control is shown while a read is failing, so an unknown value is never written back to the host. Retry, or reopen this page later.',
        numberInvalid: 'Enter a number',
        controlUnavailable: 'This option is edited by its own plugin control. That control is not loaded right now, so it cannot be changed here and the stored value stays as it is.',
      },
    }

    /** Human wording per protocol §6 code, plus the two client-side ones. */
    var CODE_TEXT = {
      forbidden: ['宿主拒绝了这次请求（信任校验未通过）。', 'The host rejected this request (trust check failed).'],
      'method-not-allowed': ['宿主接口只接受 POST。', 'The host endpoint accepts POST only.'],
      'unknown-method': ['宿主接口版本不匹配（没有这个方法）。', 'The host does not provide that method (version mismatch).'],
      'bad-request': ['请求参数不合法。', 'The request was malformed.'],
      'unknown-plugin': ['该插件已不在宿主注册表中。', 'That plugin is no longer registered on the host.'],
      'unknown-item': ['该设置项已不存在。', 'That setting item no longer exists.'],
      conflict: ['写入冲突：宿主上的值已被改动，已重新读取最新值。', 'Write conflict: the host value changed; the latest state was reloaded.'],
      'storage-unavailable': ['宿主存储不可用，本页暂时只读。', 'Host storage is unavailable; this page is read-only for now.'],
      internal: ['宿主内部错误。', 'The host hit an internal error.'],
      network: ['无法连接宿主接口。', 'Could not reach the host endpoint.'],
      http: ['宿主接口返回了非预期响应。', 'The host endpoint answered unexpectedly.'],
    }

    function makeOwnT(lang) {
      var dict = lang === 'en' ? OWN_TEXT.en : OWN_TEXT.zh
      return function (key, params) {
        var text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
        if (params === undefined || params === null) return text
        return text.replace(/\{(\w+)\}/g, function (match, name) {
          return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
        })
      }
    }

    function codeText(code, lang) {
      var entry = Object.prototype.hasOwnProperty.call(CODE_TEXT, code) ? CODE_TEXT[code] : undefined
      if (entry === undefined) return lang === 'en' ? 'The host reported an error.' : '宿主报告了一个错误。'
      return lang === 'en' ? entry[1] : entry[0]
    }

    /** Registrant dictionary first, the text itself second (protocol §2.1). */
    function registrantT(registration, lang) {
      var locale = registration === null || registration === undefined ? undefined : registration.locale
      var dict = locale === null || locale === undefined ? undefined : locale[lang]
      return function (text) {
        if (typeof text !== 'string') return text === undefined || text === null ? '' : String(text)
        if (dict !== undefined && dict !== null && Object.prototype.hasOwnProperty.call(dict, text)) {
          var translated = dict[text]
          if (typeof translated === 'string') return translated
        }
        return text
      }
    }

    /* -------------------------------------------------------------- helpers */

    function hasOwn(target, key) {
      return target !== null && target !== undefined && Object.prototype.hasOwnProperty.call(target, key)
    }

    function noop() {}

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function isReadOnlyCode(code) {
      return code !== undefined && code !== null && READ_ONLY_CODES[code] === true
    }

    /** Prefix-safe route URL, the host-route-url.ts rule: resolve the route
     *  RELATIVE to the page base, with every leading slash stripped. */
    function httpBase() {
      try {
        if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
          return document.baseURI
        }
      } catch (error) { /* non-DOM run */ }
      var transport = typeof globalThis !== 'undefined' ? globalThis.__DSH_TRANSPORT__ : undefined
      if (transport !== null && transport !== undefined && typeof transport.streamBaseUrl === 'string' && transport.streamBaseUrl !== '') {
        return transport.streamBaseUrl
      }
      return PLACEHOLDER_ORIGIN
    }

    function routeUrl(path) {
      var base = new URL(httpBase(), PLACEHOLDER_ORIGIN)
      base.search = ''
      base.hash = ''
      if (base.pathname.charAt(base.pathname.length - 1) !== '/') base.pathname += '/'
      return new URL(String(path).replace(/^\/+/, ''), base.href).href
    }

    function bridgeError(code, message) {
      var error = new Error(message === undefined || message === '' ? String(code) : String(message))
      error.code = code
      return error
    }

    /** One POST to the plugin's own route; the envelope is unwrapped here so
     *  every caller sees either the payload or an error carrying the wire code. */
    function createBridge(fetchImpl) {
      var doFetch = typeof fetchImpl === 'function' ? fetchImpl : function (url, init) {
        return fetch(url, init)
      }

      function unwrap(response) {
        return Promise.resolve(response).then(function (settled) {
          // A body that is not JSON reads as "no envelope" and falls through
          // to the status-based error below.
          return Promise.resolve(settled.json()).then(function (value) { return value }, function () { return null }).then(function (body) {
            if (body !== null && body !== undefined && body.ok === true && hasOwn(body, 'value')) return body.value
            var code = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : 'http'
            var message = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' ? body.error.message : ''
            if (message === '') message = 'HTTP ' + String(settled.status)
            throw bridgeError(code, message)
          })
        })
      }

      function call(method, payload) {
        return Promise.resolve()
          .then(function () {
            return doFetch(routeUrl(ROUTE_PREFIX + method), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload === undefined ? {} : payload),
              credentials: 'same-origin',
            })
          })
          .then(unwrap, function (error) {
            throw bridgeError('network', error !== null && error !== undefined && error.message ? error.message : String(error))
          })
      }

      return {
        listRegistrations: function () {
          return call(METHOD_LIST, {})
        },
        getValues: function (sessionId) {
          return call(METHOD_GET, { sessionId: sessionId })
        },
        setValue: function (sessionId, pluginId, itemKey, value) {
          return call(METHOD_SET, { sessionId: sessionId, pluginId: pluginId, itemKey: itemKey, value: value })
        },
        resetValues: function (sessionId, pluginId, itemKey) {
          var payload = { sessionId: sessionId }
          if (typeof pluginId === 'string' && pluginId !== '') payload.pluginId = pluginId
          if (typeof itemKey === 'string' && itemKey !== '') payload.itemKey = itemKey
          return call(METHOD_RESET, payload)
        },
      }
    }

    /* ---------------------------------------------------------------- store */

    /**
     * One store per plugin activation: the single source of truth the page,
     * the tab title, and ctx.sessionSettings.subscribe all read.
     *
     * Writes ride one promise queue. The queue is the swallowed chain, so a
     * failed write never poisons the next one; nothing is flipped locally
     * ahead of the host, and every accepted write lands by REPLACING the
     * cached state with the host's own response (protocol §2.3).
     */
    function createStore(options) {
      var bridge = options.bridge
      var listeners = new Set()
      var revision = 0
      var snapshots = new Map()
      var renderers = new Map()
      var registrations = []
      var registrationsStatus = 'idle'
      var registrationsError = null
      var registrationsFlight = null
      var sessions = new Map()
      var queue = Promise.resolve()
      var lang = options.lang === 'en' ? 'en' : 'zh'

      function notify(event) {
        revision += 1
        var list = []
        listeners.forEach(function (listener) { list.push(listener) })
        for (var i = 0; i < list.length; i += 1) {
          try {
            list[i](event)
          } catch (error) {
            console.error(PLUGIN_TAG + ' subscriber failed', error)
          }
        }
      }

      function sessionOf(sessionId) {
        var entry = sessions.get(sessionId)
        if (entry === undefined) {
          entry = { status: 'idle', error: null, notice: null, overrides: {}, resolved: {}, busy: null, flight: null }
          sessions.set(sessionId, entry)
        }
        return entry
      }

      function applyValues(sessionId, payload) {
        var entry = sessionOf(sessionId)
        entry.overrides = isRecord(payload) && isRecord(payload.overrides) ? payload.overrides : {}
        entry.resolved = isRecord(payload) && isRecord(payload.resolved) ? payload.resolved : {}
        entry.status = 'ready'
        entry.error = null
      }

      function loadRegistrations(force) {
        if (registrationsFlight !== null && !force) return registrationsFlight
        if (registrationsStatus === 'ready' && !force) return Promise.resolve()
        registrationsStatus = 'loading'
        notify({ kind: 'registrations', sessionId: undefined })
        var flight = bridge.listRegistrations().then(function (value) {
          registrations = isRecord(value) && Array.isArray(value.registrations) ? value.registrations : []
          registrationsStatus = 'ready'
          registrationsError = null
          registrationsFlight = null
          notify({ kind: 'registrations', sessionId: undefined })
        }, function (error) {
          registrationsStatus = 'error'
          registrationsError = error
          registrationsFlight = null
          notify({ kind: 'registrations', sessionId: undefined })
        })
        registrationsFlight = flight
        return flight
      }

      function loadValues(sessionId, force) {
        var entry = sessionOf(sessionId)
        if (entry.flight !== null && !force) return entry.flight
        if (entry.status === 'ready' && !force) return Promise.resolve()
        if (entry.flight !== null) return entry.flight
        entry.status = 'loading'
        entry.error = null
        notify({ kind: 'values', sessionId: sessionId })
        var flight = bridge.getValues(sessionId).then(function (payload) {
          entry.flight = null
          applyValues(sessionId, payload)
          notify({ kind: 'values', sessionId: sessionId })
        }, function (error) {
          entry.flight = null
          entry.status = 'error'
          entry.error = error
          notify({ kind: 'values', sessionId: sessionId })
        })
        entry.flight = flight
        return flight
      }

      /** Load whatever is missing for one session. Never rejects: the store
       *  keeps failures as state and the page renders them. */
      function ensure(sessionId, force) {
        if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve()
        return Promise.all([loadRegistrations(force === true), loadValues(sessionId, force === true)]).then(noop, noop)
      }

      function enqueue(task) {
        var result = queue.then(task)
        // The chain the next task rides is the SWALLOWED one: a rejection here
        // is reported to the caller but never blocks later writes.
        queue = result.then(noop, noop)
        return result
      }

      function writeFailure(sessionId, entry, error, token) {
        if (entry.busy === token) entry.busy = null
        entry.notice = { code: error.code === undefined ? 'internal' : error.code, message: error.message }
        if (isReadOnlyCode(entry.notice.code)) entry.error = error
        notify({ kind: 'values', sessionId: sessionId })
        if (entry.notice.code === 'conflict' || isReadOnlyCode(entry.notice.code)) {
          return loadValues(sessionId, true)
        }
        return undefined
      }

      function setValue(sessionId, pluginId, itemKey, value) {
        var entry = sessionOf(sessionId)
        var token = pluginId + '\u0000' + itemKey
        entry.busy = token
        notify({ kind: 'values', sessionId: sessionId, pluginId: pluginId, itemKey: itemKey })
        return enqueue(function () {
          return bridge.setValue(sessionId, pluginId, itemKey, value).then(function (payload) {
            if (entry.busy === token) entry.busy = null
            entry.notice = null
            applyValues(sessionId, payload)
            notify({ kind: 'values', sessionId: sessionId, pluginId: pluginId, itemKey: itemKey })
          }, function (error) {
            return Promise.resolve(writeFailure(sessionId, entry, error, token)).then(function () { throw error })
          })
        })
      }

      function reset(sessionId, pluginId, itemKey) {
        var entry = sessionOf(sessionId)
        var token = pluginId === undefined ? '\u0000session' : pluginId + (itemKey === undefined ? '' : '\u0000' + itemKey)
        entry.busy = token
        notify({ kind: 'values', sessionId: sessionId, pluginId: pluginId, itemKey: itemKey })
        return enqueue(function () {
          return bridge.resetValues(sessionId, pluginId, itemKey).then(function (payload) {
            if (entry.busy === token) entry.busy = null
            entry.notice = null
            applyValues(sessionId, payload)
            notify({ kind: 'values', sessionId: sessionId, pluginId: pluginId, itemKey: itemKey })
          }, function (error) {
            return Promise.resolve(writeFailure(sessionId, entry, error, token)).then(function () { throw error })
          })
        })
      }

      function changedIn(entry, registration) {
        var items = Array.isArray(registration.items) ? registration.items : []
        var overrides = entry.overrides[registration.pluginId]
        if (!isRecord(overrides)) return 0
        var count = 0
        for (var i = 0; i < items.length; i += 1) {
          if (hasOwn(overrides, items[i].key)) count += 1
        }
        return count
      }

      function countChanged(entry) {
        var total = 0
        for (var i = 0; i < registrations.length; i += 1) total += changedIn(entry, registrations[i])
        return total
      }

      function snapshot(sessionId) {
        var key = typeof sessionId === 'string' ? sessionId : ''
        var cached = snapshots.get(key)
        if (cached !== undefined && cached.revision === revision) return cached.value
        var entry = sessionOf(key)
        var error = entry.error !== null ? entry.error : registrationsError
        var value = {
          revision: revision,
          sessionId: key,
          lang: lang,
          status: entry.status,
          registrationsStatus: registrationsStatus,
          readOnly: isReadOnlyCode(error === null || error === undefined ? undefined : error.code),
          errorCode: error === null || error === undefined ? null : (error.code === undefined ? 'internal' : error.code),
          errorMessage: error === null || error === undefined ? '' : String(error.message),
          notice: entry.notice,
          busy: entry.busy,
          registrations: registrations,
          overrides: entry.overrides,
          resolved: entry.resolved,
          changed: countChanged(entry),
        }
        snapshots.set(key, { revision: revision, value: value })
        return value
      }

      return {
        subscribe: function (listener) {
          if (typeof listener !== 'function') throw new Error('sessionSettings.subscribe: listener must be a function')
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        getRevision: function () { return revision },
        getLang: function () { return lang },
        setLang: function (next) {
          var value = next === 'en' ? 'en' : 'zh'
          if (value === lang) return
          lang = value
          notify({ kind: 'locale', sessionId: undefined })
        },
        snapshot: snapshot,
        ensure: ensure,
        refresh: function (sessionId) {
          if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve()
          return ensure(sessionId, true)
        },
        getRegistrations: function () { return registrations },
        getResolved: function (pluginId, sessionId) {
          return ensure(sessionId, false).then(function () {
            var entry = sessionOf(sessionId)
            return isRecord(entry.resolved) && isRecord(entry.resolved[pluginId]) ? entry.resolved[pluginId] : {}
          })
        },
        setValue: setValue,
        reset: reset,
        dismissNotice: function (sessionId) {
          var entry = sessionOf(sessionId)
          if (entry.notice === null) return
          entry.notice = null
          notify({ kind: 'values', sessionId: sessionId })
        },
        registerRenderer: function (pluginId, itemKey, Component) {
          if (typeof pluginId !== 'string' || pluginId === '') throw new Error('sessionSettings.registerRenderer: pluginId is required')
          if (typeof itemKey !== 'string' || itemKey === '') throw new Error('sessionSettings.registerRenderer: itemKey is required')
          if (Component === null || (typeof Component !== 'function' && typeof Component !== 'object')) {
            throw new Error('sessionSettings.registerRenderer: Component must be a React component')
          }
          var slot = renderers.get(pluginId)
          if (slot === undefined) {
            slot = new Map()
            renderers.set(pluginId, slot)
          }
          slot.set(itemKey, Component)
          notify({ kind: 'renderers', sessionId: undefined })
          return function () {
            if (slot.get(itemKey) !== Component) return
            slot.delete(itemKey)
            if (slot.size === 0) renderers.delete(pluginId)
            notify({ kind: 'renderers', sessionId: undefined })
          }
        },
        getRenderer: function (pluginId, itemKey) {
          var slot = renderers.get(pluginId)
          return slot === undefined ? undefined : slot.get(itemKey)
        },
      }
    }

    /* ------------------------------------------------------------- controls */

    /** Local draft that follows the external value; commits happen on blur or
     *  Enter so a keystroke never becomes a write. */
    function useDraft(value, toText) {
      var text = toText(value)
      var pair = React.useState(text)
      var setDraft = pair[1]
      React.useEffect(function () { setDraft(text) }, [text])
      return pair
    }

    function currentText(value) {
      if (typeof value === 'string') return value
      if (value === undefined || value === null) return ''
      return String(value)
    }

    function defaultText(item) {
      var value = item.default
      if (value === undefined || value === null) return '—'
      if (typeof value === 'string') return value === '' ? '""' : value
      if (typeof value === 'boolean') return value ? 'on' : 'off'
      if (Array.isArray(value)) return value.length === 0 ? '[]' : value.join(', ')
      if (typeof value === 'object') {
        try { return JSON.stringify(value) } catch (error) { return String(value) }
      }
      return String(value)
    }

    function TextControl(props) {
      var draft = useDraft(props.value, currentText)
      function commit() {
        var next = draft[0]
        if (next === currentText(props.value)) return
        props.onChange(next)
      }
      return h('input', {
        type: 'text',
        id: props.domId,
        name: props.domId,
        value: draft[0],
        placeholder: typeof props.item.placeholder === 'string' ? props.item.placeholder : '',
        disabled: props.disabled,
        spellCheck: false,
        'aria-label': props.label,
        onChange: function (event) { draft[1](event.target.value) },
        onBlur: commit,
        onKeyDown: function (event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        },
        style: STYLES.input,
      })
    }

    function NumberControl(props) {
      var draft = useDraft(props.value, currentText)
      var invalid = React.useState(false)
      var setInvalid = invalid[1]
      function commit() {
        var raw = draft[0]
        if (raw === '') {
          draft[1](currentText(props.value))
          setInvalid(false)
          return
        }
        var next = Number(raw)
        if (!isFinite(next)) {
          setInvalid(true)
          return
        }
        setInvalid(false)
        if (typeof props.item.min === 'number' && next < props.item.min) next = props.item.min
        if (typeof props.item.max === 'number' && next > props.item.max) next = props.item.max
        if (typeof props.value === 'number' && next === props.value) return
        props.onChange(next)
      }
      var children = [h('input', {
        key: 'input',
        type: 'number',
        id: props.domId,
        name: props.domId,
        value: draft[0],
        min: typeof props.item.min === 'number' ? props.item.min : undefined,
        max: typeof props.item.max === 'number' ? props.item.max : undefined,
        step: typeof props.item.step === 'number' ? props.item.step : undefined,
        placeholder: typeof props.item.placeholder === 'string' ? props.item.placeholder : '',
        disabled: props.disabled,
        'aria-label': props.label,
        onChange: function (event) { draft[1](event.target.value) },
        onBlur: commit,
        onKeyDown: function (event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        },
        style: STYLES.numberInput,
      })]
      if (typeof props.item.unit === 'string' && props.item.unit !== '') {
        children.push(h('span', { key: 'unit', style: STYLES.unit }, props.item.unit))
      }
      if (invalid[0]) {
        children.push(h('span', { key: 'invalid', style: STYLES.invalidHint }, props.invalidText))
      }
      return h('span', { style: STYLES.numberWrap }, children)
    }

    function SelectControl(props) {
      var options = Array.isArray(props.item.options) ? props.item.options : []
      var matched = ''
      for (var i = 0; i < options.length; i += 1) {
        if (String(options[i].value) === String(props.value)) {
          matched = String(options[i].value)
          break
        }
      }
      return h('select', {
        id: props.domId,
        name: props.domId,
        value: matched,
        disabled: props.disabled,
        'aria-label': props.label,
        onChange: function (event) {
          var raw = event.target.value
          for (var j = 0; j < options.length; j += 1) {
            if (String(options[j].value) === raw) {
              // Send the option's own typed value (string | number | boolean),
              // not the DOM's stringified one.
              props.onChange(options[j].value)
              return
            }
          }
          props.onChange(raw)
        },
        style: STYLES.select,
      }, options.map(function (option, index) {
        return h('option', { key: String(option.value) + '#' + index, value: String(option.value) }, props.tr(option.title))
      }))
    }

    function stringListText(value) {
      if (!Array.isArray(value)) return currentText(value)
      var lines = []
      for (var i = 0; i < value.length; i += 1) lines.push(currentText(value[i]))
      return lines.join('\n')
    }

    function StringListControl(props) {
      var draft = useDraft(props.value, stringListText)
      function commit() {
        var raw = draft[0].split('\n')
        var lines = []
        for (var i = 0; i < raw.length; i += 1) {
          var line = raw[i].trim()
          if (line !== '') lines.push(line)
        }
        if (lines.join('\n') === stringListText(props.value)) return
        props.onChange(lines)
      }
      return h('textarea', {
        rows: 3,
        id: props.domId,
        name: props.domId,
        value: draft[0],
        placeholder: typeof props.item.placeholder === 'string' ? props.item.placeholder : props.hint,
        disabled: props.disabled,
        spellCheck: false,
        'aria-label': props.label,
        onChange: function (event) { draft[1](event.target.value) },
        onBlur: commit,
        style: STYLES.textarea,
      })
    }

    function SwitchControl(props) {
      return h('input', {
        type: 'checkbox',
        role: 'switch',
        id: props.domId,
        name: props.domId,
        checked: props.value === true,
        disabled: props.disabled,
        'aria-label': props.label,
        onChange: function (event) { props.onChange(event.target.checked) },
        style: STYLES.switch,
      })
    }

    /** The default control for one declarative item type. */
    function DefaultControl(props) {
      var shared = {
        item: props.item,
        value: props.value,
        disabled: props.disabled,
        label: props.label,
        domId: props.domId,
        hint: props.hint,
        invalidText: props.invalidText,
        tr: props.tr,
        onChange: props.onChange,
      }
      switch (props.item.type) {
        case 'switch': return h(SwitchControl, shared)
        case 'number': return h(NumberControl, shared)
        case 'select': return h(SelectControl, shared)
        case 'stringList': return h(StringListControl, shared)
        case 'text': return h(TextControl, shared)
        default:
          // An unknown type from a newer host degrades to text instead of
          // rendering nothing; the value still round-trips as a string.
          return h(TextControl, shared)
      }
    }

    /* ------------------------------------------------------------- page UI */

    function useSnapshot(store, sessionId) {
      var subscribe = React.useCallback(function (listener) { return store.subscribe(listener) }, [store])
      var getSnapshot = React.useCallback(function () { return store.snapshot(sessionId) }, [store, sessionId])
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    function useRefreshOnFocus(store, sessionId) {
      React.useEffect(function () {
        if (sessionId === '') return undefined
        function reload() {
          store.refresh(sessionId)
        }
        function onVisibility() {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') reload()
        }
        window.addEventListener('focus', reload)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return function () {
          window.removeEventListener('focus', reload)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [store, sessionId])
    }

    /**
     * Whether one item's BUILT-IN control can write its current value back
     * unchanged. A registration declares one of a small set of control types,
     * but a consumer may store any JSON under it (the host accepts any JSON
     * value). A control that cannot represent the value would stringify it and
     * write that back, destroying what the consumer stored — so such a value is
     * shown read-only until the consumer's own renderer is registered.
     * @param item - the declared item.
     * @param value - the item's resolved value.
     * @returns whether the built-in control round-trips this value.
     */
    function builtinRepresentable(item, value) {
      // Nothing is stored under this item yet, so there is nothing to destroy.
      if (value === null || value === undefined) return true
      switch (item.type) {
        case 'switch': return typeof value === 'boolean'
        case 'number': return typeof value === 'number'
        case 'text': return typeof value === 'string'
        // The select control writes back whatever the chosen option carries,
        // which may be a boolean value (see SelectControl).
        case 'select': return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        case 'stringList': return Array.isArray(value) && value.every(function (entry) { return typeof entry === 'string' })
        default: return false
      }
    }

    function ItemRow(props) {
      var item = props.item
      var registration = props.registration
      var state = props.state
      var overrides = state.overrides[registration.pluginId]
      var overridden = isRecord(overrides) && hasOwn(overrides, item.key)
      var resolved = state.resolved[registration.pluginId]
      var value = isRecord(resolved) ? resolved[item.key] : undefined
      var busy = state.busy !== null
      var disabled = state.readOnly || busy
      var ownT = props.ownT
      var tr = props.tr
      var setValue = React.useCallback(function (next) {
        props.store.setValue(props.sessionId, registration.pluginId, item.key, next).catch(noop)
      }, [props.store, props.sessionId, registration.pluginId, item.key])
      var doReset = React.useCallback(function () {
        props.store.reset(props.sessionId, registration.pluginId, item.key).catch(noop)
      }, [props.store, props.sessionId, registration.pluginId, item.key])
      var label = tr(item.title)
      // Stable control id/name (browser form-field warning / a11y): the label
      // below points at it, so clicking the row title focuses or toggles the
      // control. Custom renderers receive the same id to attach themselves.
      var domId = controlDomId(props.tabId, registration.pluginId, item.key)
      var Renderer = props.store.getRenderer(registration.pluginId, item.key)
      var representable = Renderer !== undefined || builtinRepresentable(item, value)
      var controlDisabled = disabled || !representable
      var control = Renderer === undefined
        ? h(DefaultControl, {
          item: item,
          value: value,
          disabled: controlDisabled,
          label: label,
          domId: domId,
          hint: ownT('linesHint'),
          invalidText: ownT('numberInvalid'),
          tr: tr,
          onChange: setValue,
        })
        : h(Renderer, {
          pluginId: registration.pluginId,
          sessionId: props.sessionId,
          item: item,
          registration: registration,
          value: value,
          defaultValue: item.default,
          overridden: overridden,
          disabled: disabled,
          busy: busy,
          domId: domId,
          t: tr,
          setValue: setValue,
          reset: doReset,
        })
      var head = [
        // Only a default control renders the element the label points at; a
        // custom renderer stays a plain span (it owns its own labelling).
        Renderer === undefined
          ? h('label', { key: 'title', style: STYLES.rowTitle, htmlFor: domId }, label)
          : h('span', { key: 'title', style: STYLES.rowTitle }, label),
      ]
      if (overridden) head.push(h('span', { key: 'badge', style: STYLES.badge }, ownT('overridden')))
      var body = [
        h('div', { key: 'head', style: STYLES.rowHead }, head),
      ]
      if (typeof item.description === 'string' && item.description !== '') {
        body.push(h('div', { key: 'desc', style: STYLES.rowDesc }, tr(item.description)))
      }
      if (!representable) {
        body.push(h('div', { key: 'unrepresentable', style: STYLES.rowDesc }, ownT('controlUnavailable')))
      }
      body.push(h('div', { key: 'default', style: STYLES.rowDefault }, ownT('defaultValue', { value: defaultText(item) })))
      return h('div', { style: STYLES.row },
        h('div', { key: 'main', style: STYLES.rowMain },
          h('div', { key: 'text', style: STYLES.rowText }, body),
          h('div', { key: 'control', style: STYLES.rowControl }, control),
        ),
        overridden ? h('div', { key: 'actions', style: STYLES.rowActions },
          h('button', { type: 'button', style: STYLES.linkButton, disabled: disabled || !representable, onClick: doReset }, ownT('resetItem')),
        ) : null,
      )
    }

    function Card(props) {
      var registration = props.registration
      var items = Array.isArray(registration.items) ? registration.items : []
      var changed = props.changed
      // Armed = the user already clicked this group's reset once; the second
      // click is the one that executes (see SessionSettingsPage).
      var pluginArmed = props.armed !== null && props.armed !== undefined
        && props.armed.kind === 'plugin' && props.armed.pluginId === registration.pluginId
      var tr = registrantT(registration, props.state.lang)
      // The row rule, applied to the whole group: a reset must not clear a value
      // this page cannot show, including through the group action.
      var resolved = isRecord(props.state.resolved) && isRecord(props.state.resolved[registration.pluginId])
        ? props.state.resolved[registration.pluginId]
        : {}
      var groupResettable = items.every(function (item) {
        var renderer = props.store.getRenderer(registration.pluginId, item.key)
        return renderer !== undefined || builtinRepresentable(item, hasOwn(resolved, item.key) ? resolved[item.key] : item.default)
      })
      var header = [
        h('span', { key: 'title', style: STYLES.cardTitle }, tr(registration.title)),
      ]
      if (changed > 0) header.push(h('span', { key: 'count', style: STYLES.cardCount }, props.ownT('changed', { n: changed })))
      return h('section', { style: STYLES.card },
        h('div', { style: STYLES.cardHeader },
          h('div', { key: 'title', style: STYLES.cardTitleRow }, header),
          // NOTE: the session-wide reset (below, in the page header) is deliberately
          // NOT gated on representability: it is the explicit, twice-confirmed
          // "clear every change in this session" action, and disabling it would
          // remove the only recovery path when a consumer's value cannot be shown.
          changed > 0 ? h('button', {
            key: 'reset',
            type: 'button',
            style: pluginArmed ? STYLES.dangerGhostButton : STYLES.ghostButton,
            disabled: props.state.readOnly || props.state.busy !== null || !groupResettable,
            title: pluginArmed ? props.ownT('confirmResetGroup') : props.ownT('resetGroup'),
            onClick: function () {
              if (!pluginArmed) {
                props.onArm({ kind: 'plugin', pluginId: registration.pluginId })
                return
              }
              props.onDisarm()
              props.store.reset(props.sessionId, registration.pluginId).catch(noop)
            },
          }, pluginArmed ? props.ownT('confirmResetGroup') : props.ownT('resetGroup')) : null,
        ),
        items.length === 0
          ? h('div', { style: STYLES.rowDesc }, props.ownT('noItems'))
          : items.map(function (item) {
            return h(ItemRow, {
              key: item.key,
              item: item,
              registration: registration,
              state: props.state,
              store: props.store,
              sessionId: props.sessionId,
              tabId: props.tabId,
              ownT: props.ownT,
              tr: tr,
            })
          }),
      )
    }

    /**
     * Containment for the page body: an uncaught render crash would otherwise
     * reach the slot boundary, which ABDICATES the entry — the tab would then
     * render nothing until the registration is redone. This boundary keeps the
     * tab alive and shows the reason instead.
     */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error) {
        reportFailure('render', error)
      }

      render() {
        if (this.state.error === null || this.state.error === undefined) return this.props.children
        var store = this.props.store
        var lang = store !== undefined && store !== null && typeof store.getLang === 'function' ? store.getLang() : 'zh'
        var ownT = makeOwnT(lang)
        var error = this.state.error
        var message = error !== null && error !== undefined && error.message ? String(error.message) : String(error)
        var self = this
        return h('div', { style: STYLES.root },
          h('div', { style: STYLES.errorBar },
            h('div', { key: 'text', style: STYLES.errorText }, ownT('errorTitle') + ' · ' + message),
            h('button', {
              key: 'retry',
              type: 'button',
              style: STYLES.ghostButton,
              onClick: function () { self.setState({ error: null }) },
            }, ownT('retry')),
          ),
        )
      }
    }

    function SessionSettingsPage(props) {
      var store = props.store
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      var state = useSnapshot(store, sessionId)
      useRefreshOnFocus(store, sessionId)
      React.useEffect(function () {
        if (sessionId !== '') store.ensure(sessionId)
      }, [store, sessionId])
      var lang = state.lang
      var ownT = makeOwnT(lang)
      // Bulk resets are two-step and inline (never window.confirm): the first
      // click arms, the second executes, and 3s of no further click disarms, so
      // a stray click can never wipe a session's configuration.
      var armedPair = React.useState(null)
      var armed = armedPair[0]
      var setArmed = armedPair[1]
      React.useEffect(function () {
        if (armed === null || armed === undefined) return undefined
        var timer = setTimeout(function () { setArmed(null) }, 3000)
        return function () { clearTimeout(timer) }
      }, [armed])
      var sessionArmed = armed !== null && armed !== undefined && armed.kind === 'session'
      // useSessions is part of the session-scope standard kit (GlobalStandardProps,
      // merged by dsh-client-ui-session). Its PRESENCE is frozen at mount so the
      // hook order stays stable even in a composition that omits the kit.
      var useSessionsRef = React.useRef(undefined)
      if (useSessionsRef.current === undefined) {
        useSessionsRef.current = typeof props.useSessions === 'function' ? props.useSessions : null
      }
      var useSessions = useSessionsRef.current
      var selectSummary = React.useCallback(function (sessions) {
        if (sessions === null || sessions === undefined) return undefined
        if (sessions.byId === null || sessions.byId === undefined) return undefined
        return sessions.byId[sessionId]
      }, [sessionId])
      var summary = useSessions === null ? undefined : useSessions(selectSummary)
      // useTabInfo is this seat's own slot-level hook context (the same one the
      // official FilesBody uses). It names the tab occurrence, which the control
      // ids need so two panes cannot collide. Presence is frozen at mount, same
      // reason as useSessions above.
      var useTabInfoRef = React.useRef(undefined)
      if (useTabInfoRef.current === undefined) {
        useTabInfoRef.current = typeof props.useTabInfo === 'function' ? props.useTabInfo : null
      }
      var useTabInfo = useTabInfoRef.current
      var tabId = ''
      if (useTabInfo !== null) {
        var tabInfo = useTabInfo()
        if (tabInfo !== null && tabInfo !== undefined && tabInfo.tab !== null && tabInfo.tab !== undefined && typeof tabInfo.tab.id === 'string') {
          tabId = tabInfo.tab.id
        }
      }
      if (sessionId === '') {
        return h('div', { style: STYLES.root }, h('div', { style: STYLES.placeholder }, ownT('noSession')))
      }
      var registrations = Array.isArray(state.registrations) ? state.registrations.slice() : []
      registrations.sort(function (left, right) {
        var leftOrder = typeof left.order === 'number' ? left.order : 0
        var rightOrder = typeof right.order === 'number' ? right.order : 0
        if (leftOrder !== rightOrder) return leftOrder - rightOrder
        return String(left.pluginId).localeCompare(String(right.pluginId))
      })
      // Only a settled read can draw controls: an unresolved value must never
      // be presented as the session's value (or written back over it).
      var ready = state.status === 'ready'
      var failed = state.errorCode !== null
      var children = []
      children.push(h('div', { key: 'header', style: STYLES.header },
        h('div', { key: 'titleRow', style: STYLES.titleRow },
          h('span', { key: 'title', style: STYLES.title }, ownT('title')),
          state.readOnly ? h('span', { key: 'ro', style: STYLES.readOnlyBadge }, ownT('readOnly')) : null,
        ),
        h('div', { key: 'session', style: STYLES.sessionLine, title: sessionId },
          ownT('sessionLabel') + ' · ' + sessionLabel(summary, sessionId)),
        h('div', { key: 'actions', style: STYLES.headerActions },
          h('span', { key: 'count', style: STYLES.changedLine },
            state.changed > 0 ? ownT('changed', { n: state.changed }) : ownT('unchanged')),
          h('button', {
            key: 'resetAll',
            type: 'button',
            style: sessionArmed ? STYLES.dangerButton : STYLES.primaryButton,
            disabled: state.readOnly || state.busy !== null || state.changed === 0,
            title: sessionArmed ? ownT('confirmResetAll') : ownT('resetAll'),
            onClick: function () {
              if (!sessionArmed) {
                setArmed({ kind: 'session' })
                return
              }
              setArmed(null)
              store.reset(sessionId).catch(noop)
            },
          }, sessionArmed ? ownT('confirmResetAll') : ownT('resetAll')),
        ),
      ))
      if (state.notice !== null && state.notice !== undefined) {
        children.push(h('div', { key: 'notice', style: STYLES.noticeBar },
          h('span', { key: 'text', style: STYLES.noticeText },
            codeText(state.notice.code, lang) + (state.notice.message ? ' ' + state.notice.message : '')),
          h('button', {
            key: 'dismiss',
            type: 'button',
            style: STYLES.linkButton,
            onClick: function () { store.dismissNotice(sessionId) },
          }, ownT('dismiss')),
        ))
      }
      if (state.errorCode !== null) {
        children.push(h('div', { key: 'error', style: STYLES.errorBar },
          h('div', { key: 'text', style: STYLES.errorText },
            ownT('errorTitle') + ' · ' + codeText(state.errorCode, lang) + ' (' + state.errorCode + ')'),
          h('button', {
            key: 'retry',
            type: 'button',
            style: STYLES.ghostButton,
            onClick: function () { store.refresh(sessionId) },
          }, ownT('retry')),
        ))
      }
      if (!ready) {
        children.push(h('div', { key: 'loading', style: STYLES.placeholder },
          failed ? ownT('errorBody') : ownT('loading')))
      } else if (registrations.length === 0) {
        children.push(h('div', { key: 'empty', style: STYLES.empty },
          h('div', { key: 't', style: STYLES.emptyTitle }, ownT('emptyTitle')),
          h('div', { key: 'b', style: STYLES.rowDesc }, ownT('emptyBody')),
        ))
      } else {
        children.push(h('div', { key: 'cards', style: STYLES.cards }, registrations.map(function (registration) {
          return h(Card, {
            key: String(registration.pluginId),
            registration: registration,
            state: state,
            store: store,
            sessionId: sessionId,
            tabId: tabId,
            ownT: ownT,
            changed: changedCount(state.overrides, registration),
            armed: armed,
            onArm: setArmed,
            onDisarm: function () { setArmed(null) },
          })
        })))
      }
      return h('div', { style: STYLES.root }, children)
    }

    function changedCount(overrides, registration) {
      var items = Array.isArray(registration.items) ? registration.items : []
      var map = isRecord(overrides) ? overrides[registration.pluginId] : undefined
      if (!isRecord(map)) return 0
      var count = 0
      for (var i = 0; i < items.length; i += 1) {
        if (hasOwn(map, items[i].key)) count += 1
      }
      return count
    }

    /**
     * DOM id for one declarative control. The FIRST segment is the tab
     * occurrence, because the same page may be open in two panes at once — two
     * occurrences must not share ids. The tab id is stable for the life of that
     * tab, so re-renders and refreshes inside one pane reuse the same ids.
     *
     * Escaping is injective: the safe set excludes '-', so a '-' in the result
     * can only be an escape marker or the separator, and two different
     * (tabId, pluginId, itemKey) triples can never collide.
     */
    function controlDomId(tabId, pluginId, itemKey) {
      var occurrence = typeof tabId === 'string' && tabId !== '' ? tabId : 'pane'
      return 'session-settings-' + escapeIdPart(occurrence) + '-' + escapeIdPart(pluginId) + '-' + escapeIdPart(itemKey)
    }

    function escapeIdPart(part) {
      return String(part).replace(/[^A-Za-z0-9_]/g, function (character) {
        return '-' + character.charCodeAt(0).toString(16)
      })
    }

    function shortSession(sessionId) {
      if (sessionId.length <= 12) return sessionId
      return sessionId.slice(0, 8) + '…' + sessionId.slice(sessionId.length - 3)
    }

    /**
     * The session identity a header can show: the durable title first, the
     * working directory second, the truncated id last — the truncated id is the
     * only value a session-scope seat is guaranteed to have on its own. The
     * field names come from the official SessionSummary
     * (title?: string, cwd?: string; see @deepseek-ai/dsh-api-session-controller).
     */
    function sessionLabel(summary, sessionId) {
      if (summary !== null && summary !== undefined) {
        if (typeof summary.title === 'string' && summary.title.trim() !== '') return summary.title.trim()
        if (typeof summary.cwd === 'string' && summary.cwd.trim() !== '') return summary.cwd.trim()
      }
      return shortSession(sessionId)
    }

    /* -------------------------------------------------------------- styles */

    /** Host theme tokens only — no Harness client package is imported. The
     *  fallbacks after each var() are for standalone rendering; in the GUI the
     *  alias always resolves. */
    var STYLES = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '14px 16px 32px',
        minHeight: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        color: 'var(--dsw-alias-label-primary, #e8e8ec)',
        fontSize: '13px',
        lineHeight: 1.55,
      },
      header: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        paddingBottom: '10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
      },
      titleRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      title: { fontSize: '14px', fontWeight: 600 },
      readOnlyBadge: {
        padding: '1px 6px',
        borderRadius: '4px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, rgba(232,232,236,0.7))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.08))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
      },
      sessionLine: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary, rgba(232,232,236,0.5))',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        wordBreak: 'break-all',
      },
      headerActions: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '2px' },
      changedLine: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, rgba(232,232,236,0.7))' },
      cards: { display: 'flex', flexDirection: 'column', gap: '10px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03))',
        borderRadius: '10px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
      cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      cardTitleRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      cardTitle: { fontWeight: 600 },
      cardCount: { fontSize: '11px', color: 'var(--dsw-alias-state-warn-label, #d8b46a)' },
      row: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 0' },
      /** A consumer's control can be far wider than one box (the extra-workspaces
       *  list is the first such control). Without wrapping, and with a text column
       *  that may shrink to zero, a narrow pane squeezes the description to one
       *  character per line. The row wraps instead, and the text keeps a floor. */
      rowMain: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
      rowText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '150px', flex: '1 1 220px' },
      rowHead: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      rowTitle: { color: 'var(--dsw-alias-label-primary, #e8e8ec)' },
      rowDesc: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(232,232,236,0.55))' },
      rowDefault: { fontSize: '11px', color: 'var(--dsw-alias-label-dimmed, rgba(232,232,236,0.38))' },
      rowControl: { flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px' },
      rowActions: { display: 'flex', justifyContent: 'flex-end' },
      badge: {
        padding: '0 5px',
        borderRadius: '4px',
        fontSize: '10px',
        color: 'var(--dsw-alias-state-warn-label, #d8b46a)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))',
      },
      input: {
        width: '150px',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.18))',
        color: 'var(--dsw-alias-label-primary, #e8e8ec)',
        fontSize: '12px',
      },
      numberWrap: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      numberInput: {
        width: '86px',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.18))',
        color: 'var(--dsw-alias-label-primary, #e8e8ec)',
        fontSize: '12px',
      },
      unit: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(232,232,236,0.55))' },
      invalidHint: { fontSize: '11px', color: 'var(--dsw-alias-label-error, #f2a1a1)' },
      select: {
        maxWidth: '190px',
        padding: '4px 6px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.18))',
        color: 'var(--dsw-alias-label-primary, #e8e8ec)',
        fontSize: '12px',
      },
      textarea: {
        width: '210px',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.18))',
        color: 'var(--dsw-alias-label-primary, #e8e8ec)',
        fontSize: '12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        resize: 'vertical',
      },
      switch: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary, #4a7dff)', cursor: 'pointer' },
      primaryButton: {
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-button-primary-fill, #4a7dff)',
        color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
        fontSize: '12px',
        cursor: 'pointer',
      },
      dangerButton: {
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-state-error-primary, #e05a5a)',
        background: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(224,90,90,0.12))',
        color: 'var(--dsw-alias-label-error, #f2a1a1)',
        fontSize: '12px',
        cursor: 'pointer',
      },
      dangerGhostButton: {
        padding: '3px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-state-error-primary, #e05a5a)',
        background: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(224,90,90,0.12))',
        color: 'var(--dsw-alias-label-error, #f2a1a1)',
        fontSize: '11px',
        cursor: 'pointer',
      },
      ghostButton: {
        padding: '3px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, rgba(232,232,236,0.75))',
        fontSize: '11px',
        cursor: 'pointer',
      },
      linkButton: {
        padding: '2px 4px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-link, #7aa2ff)',
        fontSize: '11px',
        cursor: 'pointer',
      },
      noticeBar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-state-warn-primary, #b98a2f)',
        background: 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.06))',
        fontSize: '12px',
      },
      noticeText: { color: 'var(--dsw-alias-state-warn-label, #d8b46a)' },
      errorBar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-state-error-primary, #e05a5a)',
        background: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(224,90,90,0.12))',
        fontSize: '12px',
      },
      errorText: { color: 'var(--dsw-alias-label-error, #f2a1a1)' },
      placeholder: { padding: '10px 2px', color: 'var(--dsw-alias-label-tertiary, rgba(232,232,236,0.55))' },
      empty: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px',
        borderRadius: '10px',
        border: '1px dashed var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
      },
      emptyTitle: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary, rgba(232,232,236,0.8))' },
    }

    /* ----------------------------------------------------------------- ctx */

    function readLang(ctx) {
      try {
        var locale = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        var snapshot = locale !== null && locale !== undefined && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined
        var active = snapshot !== null && snapshot !== undefined && typeof snapshot.active === 'string' ? snapshot.active : ''
        if (active === '') {
          active = typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : 'en'
        }
        return String(active).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (error) {
        return 'en'
      }
    }

    function reportFailure(phase, error) {
      try {
        console.error(PLUGIN_TAG + ' ' + phase + ' failed', error)
      } catch (ignored) { /* nothing left to report with */ }
    }

    return {
      name: 'dsh-session-settings',
      inject: ['slots'],
      apply: function (ctx) {
        var store = createStore({ bridge: createBridge(), lang: readLang(ctx) })

        /** Browser-side service: the three contract members plus the reads the
         *  page and third-party consumers need (see docs/protocol-v1.md §4). */
        var service = {
          registerRenderer: function (pluginId, itemKey, Component) {
            return store.registerRenderer(pluginId, itemKey, Component)
          },
          getResolved: function (pluginId, sessionId) {
            return store.getResolved(pluginId, sessionId)
          },
          subscribe: function (listener) {
            return store.subscribe(listener)
          },
          listRegistrations: function () {
            return store.getRegistrations()
          },
          setValue: function (pluginId, itemKey, sessionId, value) {
            return store.setValue(sessionId, pluginId, itemKey, value)
          },
          reset: function (pluginId, sessionId, itemKey) {
            return store.reset(sessionId, pluginId, itemKey)
          },
          refresh: function (sessionId) {
            return store.refresh(sessionId)
          },
        }
        ctx.provide(SERVICE_KEY, service)

        // Follow the host language; the page re-renders because every change
        // bumps the store revision.
        ctx.effect(function () {
          store.setLang(readLang(ctx))
          var locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          if (locale === null || locale === undefined || typeof locale.subscribe !== 'function') return undefined
          return locale.subscribe(function () { store.setLang(readLang(ctx)) })
        }, 'dsh-session-settings: follow host language')

        // Keep the official right-sidebar tab registration from T1: the tab
        // type plus its body/title seats. Every disposer is collected so a
        // failed registration rolls back instead of leaking a taken id.
        ctx.inject(['sidebarRightTabs'], function (sidebarCtx) {
          var disposers = []
          try {
            disposers.push(sidebarCtx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: function () { return makeOwnT(store.getLang())('title') },
              guide: [{
                id: 'open',
                order: 25,
                title: function () { return makeOwnT(store.getLang())('title') },
                description: function () { return makeOwnT(store.getLang())('tabDescription') },
              }],
            }))
            disposers.push(sidebarCtx.slots.inject('sidebar.right.pane.tab', function () {
              return sidebarCtx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, function (props) {
                var sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
                // Forward the WHOLE standard kit, not just sessionId: the page
                // reads useSessions for the session label, and any future
                // standard source should reach it the same way.
                var pageProps = Object.assign({}, props, { store: store, sessionId: sessionId })
                return h(PageBoundary, { store: store }, h(SessionSettingsPage, pageProps))
              })
            }))
            disposers.push(sidebarCtx.slots.inject('sidebar.right.pane.tab.title', function () {
              return sidebarCtx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, function TabTitle(props) {
                var sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
                var state = useSnapshot(store, sessionId)
                return h('span', null, makeOwnT(state.lang)('title'))
              })
            }))
          } catch (error) {
            for (var i = 0; i < disposers.length; i += 1) disposers[i]()
            throw error
          }
          return function () {
            for (var j = 0; j < disposers.length; j += 1) disposers[j]()
          }
        })
      },
    }
  },
})
