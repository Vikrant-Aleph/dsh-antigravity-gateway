// @ts-check
// Antigravity Gateway Settings: account sign-in, model catalog, diagnostic log.
// One settings.section contribution backed by the package's /api RPC routes.
//
// Robustness rules (same as dsh-opencode-bridge): the desktop treats a failed
// module activation as a fatal web-boot error, so:
//   1. apply() must NEVER throw: every step has its own try/catch.
//   2. Every service access is optional-chained with a working fallback.
//   3. A locale namespace is registered before it is bound.

/**
 * @typedef {{ call: (channel: string, method: string, payload?: Record<string, unknown>) => Promise<RpcResult> }} RpcClientLike
 * @typedef {{ ok: boolean, value?: any, error?: { code?: string, message?: string } }} RpcResult
 * @typedef {(key: string) => string} TranslateFn
 * @typedef {{ rpc?: RpcClientLike | null, t?: TranslateFn }} PanelProps
 * @typedef {{
 *   locale?: { register?: (...args: any[]) => any, bind?: (ns: string) => TranslateFn },
 *   get?: (name: string) => any,
 *   connection?: { rpc?: RpcClientLike },
 *   effect?: (fn: () => any) => void,
 *   slots?: { inject?: (name: string, fn: () => any) => void, register?: (def: any, component: any) => any }
 * }} ClientHostContext
 */

/** @type {{ __ModuleLoader__: { load: (mod: { id: string, factory: (require: (id: string) => any) => any }) => void } }} */
(/** @type {unknown} */ (window)).__ModuleLoader__.load({
  // Must equal the package name (the browser artifact's registered id).
  id: 'dsh-antigravity-gateway',
  /** @param {(id: string) => any} loadModule */
  factory(loadModule) {
    const React = loadModule('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'settings.antigravityGateway';
    const RPC_CHANNEL = '/api';
    const ACCOUNT_NS = 'antigravity-gateway-account';
    const LOG_NS = 'antigravity-gateway-logs';

    /** @type {Record<string, string>} */
    const en = {
      nav: 'Antigravity Gateway',
      pageTitle: 'Antigravity Gateway',
      pageIntro: 'Google Antigravity models (Claude, Gemini, GPT-OSS) in DSH. Sign in with your Google account; the model list follows what your account actually offers.',
      tabAccount: 'Account',
      tabModels: 'Models',
      tabLogs: 'Diagnostic log',
      signedIn: 'Signed in',
      notSignedIn: 'Not signed in',
      accountEmail: 'Account',
      accountProject: 'Project',
      tokenExpiry: 'Access token expires (auto-refreshed)',
      backend: 'Credential storage',
      persistentNote: 'Sign-in persists across restarts until you sign out. The access token refreshes automatically (about hourly) — no re-login needed.',
      signIn: 'Sign in with Google',
      starting: 'Starting…',
      cancelLogin: 'Cancel sign-in',
      importAccount: 'Import from antigravity-auth',
      logout: 'Sign out',
      refresh: 'Refresh',
      pendingTitle: 'Waiting for Google authorization…',
      pendingHint: 'Complete the sign-in in the browser window that opened. If nothing opened, use the link below.',
      openAuthUrl: 'Open the Google authorization page',
      loginStarted: 'Sign-in started. Complete authorization in the browser.',
      loginDone: 'Sign-in complete.',
      loginCancelled: 'Sign-in cancelled.',
      importDone: 'Account imported from dsh-antigravity-auth.',
      logoutDone: 'Signed out. The local credential was removed.',
      logoutConfirm: 'Sign out and remove the local credential?',
      statusUnavailable: 'Account service unreachable.',
      loopbackRequired: 'Account controls require a local DSH Host (WebServer bound to 127.0.0.1).',
      riskNote: 'Unofficial channel: Google may restrict accounts used through third-party Antigravity clients. Personal use only.',
      modelsTitle: 'Models offered to this account',
      modelsIntro: 'Upstream availability, plan gates, and quota for the active account. Only available models are offered in the DSH picker.',
      modelsEmpty: 'No models available. Sign in first, then check again.',
      modelsUnavailable: 'Model catalog unreachable.',
      checkAvailability: 'Check availability',
      checking: 'Checking…',
      sourceLive: 'Live verified',
      sourceCached: 'Cached snapshot',
      sourceFallback: 'Unverified snapshot',
      checkedAt: 'Checked',
      accountTier: 'Plan tier',
      quotaTitle: 'Quota summary',
      quotaResets: 'resets',
      availableSection: 'Available on this account',
      unavailableSection: 'Unavailable on this account',
      statusAvailable: 'Available',
      statusExhausted: 'Quota 0%',
      statusDisabled: 'Disabled',
      statusNotOffered: 'Not offered',
      quotaLeft: 'remaining',
      efforts: 'efforts',
      logTitle: 'Diagnostic log',
      logIntro: 'Bounded, rotated, redacted. No message text, tool arguments, images or credentials are recorded.',
      level: 'Minimum level shown',
      copy: 'Copy all',
      copied: 'Copied!',
      copyFailed: 'Copy failed — select the text and copy manually.',
      clear: 'Clear logs',
      clearConfirm: 'Delete all log files?',
      loading: 'Loading…',
      empty: 'No log entries yet. Use a model once and refresh.',
      unavailable: 'Log service unreachable.',
      truncatedNote: 'Showing the newest lines only.',
      dir: 'Directory',
      total: 'Total size',
    };
    /** @type {Record<string, string>} */
    const zh = {
      nav: 'Antigravity Gateway',
      pageTitle: 'Antigravity Gateway',
      pageIntro: '在 DSH 中使用 Google Antigravity 模型（Claude、Gemini、GPT-OSS）。用 Google 账号登录；模型列表跟随你账号实际可用的目录。',
      tabAccount: '账号',
      tabModels: '模型',
      tabLogs: '诊断日志',
      signedIn: '已登录',
      notSignedIn: '未登录',
      accountEmail: '账号',
      accountProject: '项目',
      tokenExpiry: '访问令牌过期时间（自动刷新）',
      backend: '凭据存储',
      persistentNote: '登录长期有效：重启不丢失，退出登录才清除。访问令牌约每小时自动刷新，无需重新登录。',
      signIn: '使用 Google 登录',
      starting: '正在启动…',
      cancelLogin: '取消登录',
      importAccount: '从 antigravity-auth 导入',
      logout: '退出登录',
      refresh: '刷新',
      pendingTitle: '等待 Google 授权…',
      pendingHint: '请在已打开的浏览器窗口中完成登录。如果没有自动打开，请使用下面的链接。',
      openAuthUrl: '打开 Google 授权页面',
      loginStarted: '登录已启动，请在浏览器中完成授权。',
      loginDone: '登录完成。',
      loginCancelled: '登录已取消。',
      importDone: '已从 dsh-antigravity-auth 导入账号。',
      logoutDone: '已退出登录，本地凭据已删除。',
      logoutConfirm: '退出登录并删除本地凭据？',
      statusUnavailable: '账号服务不可用。',
      loopbackRequired: '账号操作要求本机 DSH Host（WebServer 绑定 127.0.0.1）。',
      riskNote: '非官方渠道：Google 可能限制通过第三方 Antigravity 客户端使用的账号。仅限个人使用。',
      modelsTitle: '当前账号可用的模型',
      modelsIntro: '展示上游返回的模型可用性、计划限制与剩余配额。只有可用的模型会出现在 DSH 模型选择器中。',
      modelsEmpty: '暂无可用模型。请先登录，再重新检测。',
      modelsUnavailable: '模型目录不可用。',
      checkAvailability: '重新检测',
      checking: '检测中…',
      sourceLive: '实时检测',
      sourceCached: '缓存快照',
      sourceFallback: '未验证快照',
      checkedAt: '检测时间',
      accountTier: '账号等级',
      quotaTitle: '配额摘要',
      quotaResets: '重置',
      availableSection: '当前账号可用模型',
      unavailableSection: '当前账号不可用模型',
      statusAvailable: '可用',
      statusExhausted: '配额耗尽',
      statusDisabled: '不可用',
      statusNotOffered: '未提供',
      quotaLeft: '剩余',
      efforts: '档位',
      logTitle: '诊断日志',
      logIntro: '有界、轮转、脱敏。不记录消息正文、工具入参、图片或凭据。',
      level: '显示最低级别',
      copy: '复制全部',
      copied: '已复制！',
      copyFailed: '复制失败——请手动选中文本复制。',
      clear: '清空日志',
      clearConfirm: '删除全部日志文件？',
      loading: '加载中…',
      empty: '暂无日志。使用一次模型后刷新即可。',
      unavailable: '日志服务不可用。',
      truncatedNote: '仅显示最新的若干行。',
      dir: '目录',
      total: '总大小',
    };

    /** @type {TranslateFn} */
    const fallbackT = (key) => zh[key] || en[key] || key;

    const CSS = `
      .agw-wrap { display: flex; flex-direction: column; gap: 12px; }
      .agw-note { font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); margin: 0; line-height: 1.6; }
      .agw-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .agw-toolbar button, .agw-actions button {
        font-size: 12px;
        padding: 6px 14px;
        border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.15));
        background: var(--dsw-alias-bg-layer-2, transparent);
        color: var(--dsw-alias-label-primary, #18181b);
        cursor: pointer;
      }
      .agw-toolbar button:hover:not(:disabled), .agw-actions button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #247bbf); }
      .agw-toolbar button:disabled, .agw-actions button:disabled { opacity: 0.5; cursor: default; }
      .agw-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .agw-actions button.agw-primary {
        background: var(--dsw-alias-brand-primary, #247bbf);
        border-color: var(--dsw-alias-brand-primary, #247bbf);
        color: #fff;
      }
      .agw-card {
        display: flex; flex-direction: column; gap: 10px;
        padding: 14px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02));
      }
      .agw-status-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .agw-badge { font-size: 11px; padding: 2px 10px; border-radius: 999px; font-weight: 600; }
      .agw-badge.is-in { color: var(--dsw-alias-state-success-primary, #16a34a); background: var(--dsw-alias-bg-layer-2, rgba(22,163,74,0.10)); }
      .agw-badge.is-out { color: var(--dsw-alias-label-secondary, #71717a); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06)); }
      .agw-badge.is-warn { color: var(--dsw-alias-state-warn-primary, #d97706); background: var(--dsw-alias-bg-layer-2, rgba(217,119,6,0.12)); }
      .agw-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px; margin: 0; }
      .agw-kv dt { color: var(--dsw-alias-label-secondary, #71717a); }
      .agw-kv dd { margin: 0; color: var(--dsw-alias-label-primary, #18181b); overflow-wrap: anywhere; }
      .agw-pending {
        display: flex; flex-direction: column; gap: 8px;
        padding: 12px;
        border: 1px dashed var(--dsw-alias-brand-primary, #247bbf);
        border-radius: 10px;
      }
      .agw-pending a { color: var(--dsw-alias-brand-primary, #247bbf); font-size: 12px; overflow-wrap: anywhere; }
      .agw-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #dc2626); margin: 0; overflow-wrap: anywhere; }
      .agw-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary, #16a34a); margin: 0; }
      .agw-model-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .agw-model-row {
        display: flex; flex-direction: column; gap: 4px;
        padding: 8px 12px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
        border-radius: 10px;
      }
      .agw-model-row.is-disabled { opacity: 0.72; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02)); }
      .agw-model-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .agw-model-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-primary, #18181b); overflow-wrap: anywhere; }
      .agw-model-name { font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); }
      .agw-model-meta { margin-left: auto; display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary, #71717a); }
      .agw-model-reason { font-size: 11px; color: var(--dsw-alias-label-secondary, #71717a); margin: 0; line-height: 1.45; }
      .agw-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #18181b); margin: 4px 0 0; }
      .agw-quota-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
      .agw-quota-card { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02)); display: flex; flex-direction: column; gap: 6px; }
      .agw-quota-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #18181b); margin: 0; }
      .agw-quota-bucket { font-size: 11px; color: var(--dsw-alias-label-secondary, #71717a); display: flex; justify-content: space-between; gap: 8px; }
      .agw-badge.is-err { color: var(--dsw-alias-state-error-primary, #dc2626); background: var(--dsw-alias-bg-layer-2, rgba(220,38,38,0.10)); }
      .agw-select {
        display: inline-flex; align-items: center;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.15));
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-2, transparent);
      }
      .agw-select select {
        margin: 0; padding: 5px 10px; font: inherit; font-size: 12px; line-height: 1.25;
        color: var(--dsw-alias-label-primary, #18181b);
        background: transparent; border: 0; border-radius: 8px; outline: none; cursor: pointer;
      }
      .agw-select:focus-within { border-color: var(--dsw-alias-brand-primary, #247bbf); }
      .agw-log-body {
        margin: 0; padding: 10px 12px; max-height: 460px; overflow: auto;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
      }
      .agw-log-line { display: block; }
      .agw-log-line.agw-debug { color: var(--dsw-alias-label-secondary, #71717a); }
      .agw-log-line.agw-info { color: var(--dsw-alias-label-primary, #18181b); }
      .agw-log-line.agw-warn { color: var(--dsw-alias-state-warn-primary, #d97706); }
      .agw-log-line.agw-error { color: var(--dsw-alias-state-error-primary, #dc2626); }
      .agw-tabbed {
        display: flex; flex-direction: column; gap: 0;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        overflow: hidden;
      }
      .agw-tabs {
        display: flex; align-items: flex-end; gap: 4px;
        padding: 8px 10px 0;
        border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
        background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03));
      }
      .agw-tab {
        position: relative; bottom: -1px; max-width: 260px;
        padding: 6px 14px; font: inherit; font-size: 12px; line-height: 1.25;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: var(--dsw-alias-label-secondary, #71717a);
        background: transparent;
        border: 1px solid transparent; border-bottom: 1px solid transparent;
        border-radius: 8px 8px 0 0; cursor: pointer;
      }
      .agw-tab:hover:not(.is-active) {
        color: var(--dsw-alias-label-primary, #18181b);
        background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.6));
      }
      .agw-tab.is-active {
        color: var(--dsw-alias-label-primary, #18181b); font-weight: 600;
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        border-color: var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
        border-bottom-color: var(--dsw-alias-bg-layer-1, #ffffff);
      }
      .agw-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2563eb); outline-offset: -3px; }
      .agw-tabpanel { padding: 12px; background: var(--dsw-alias-bg-layer-1, #ffffff); border: none; border-radius: 0; }
    `;

    const STYLE_ID = 'agw-styles';
    let styleRefs = 0;

    function useStyles() {
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        try {
          styleRefs += 1;
          let el = document.getElementById(STYLE_ID);
          if (!el) {
            el = document.createElement('style');
            el.id = STYLE_ID;
            el.textContent = CSS;
            document.head.appendChild(el);
          }
          return () => {
            styleRefs = Math.max(0, styleRefs - 1);
            if (styleRefs === 0 && el && el.parentNode) el.parentNode.removeChild(el);
          };
        } catch (e) { return undefined; }
      }, []);
    }

    /**
     * @param {RpcClientLike | null} rpc
     * @param {string} ns
     * @param {string} endpoint
     * @param {Record<string, unknown>} [payload]
     * @returns {Promise<RpcResult>}
     */
    async function rpcCall(rpc, ns, endpoint, payload) {
      if (!rpc) return { ok: false, error: { message: 'offline' } };
      try {
        const result = await rpc.call(RPC_CHANNEL, `${ns}/${endpoint}`, payload || {});
        return result || { ok: false, error: { message: 'empty response' } };
      } catch (/** @type {any} */ e) {
        return { ok: false, error: { message: String(e && e.message ? e.message : e) } };
      }
    }

    /** @param {PanelProps} [props] */
    function AccountPanel(props) {
      const t = (props && props.t) || AccountPanel.t || fallbackT;
      const rpc = (props && props.rpc) || AccountPanel.rpc || null;
      const [status, setStatus] = useState(/** @type {any} */ (null));
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const alive = useRef(true);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const load = useCallback(/** @param {boolean} [silent] */ async (silent) => {
        if (!silent) setBusy('status');
        if (!silent) setError('');
        const result = await rpcCall(rpc, ACCOUNT_NS, 'status', {});
        if (!alive.current) return;
        if (!result.ok) {
          const code = result.error && result.error.code;
          setError(code === 'loopback-required' ? t('loopbackRequired') : (result.error && result.error.message) || t('statusUnavailable'));
          setStatus(null);
        } else {
          setStatus(result.value || {});
          if (!silent) setError('');
        }
        if (!silent) setBusy('');
      }, [rpc, t]);

      useEffect(() => { void load(false); }, [load]);

      // Poll while a sign-in is pending so the card flips to "signed in"
      // as soon as the browser callback completes.
      const pending = !!(status && status.loginPending);
      useEffect(() => {
        if (!pending) return undefined;
        const timer = setInterval(() => { void load(true); }, 2000);
        return () => clearInterval(timer);
      }, [pending, load]);

      const act = useCallback(/** @param {string} endpoint @param {string} [okKey] */ async (endpoint, okKey) => {
        setBusy(endpoint); setError(''); setNotice('');
        const result = await rpcCall(rpc, ACCOUNT_NS, endpoint, {});
        if (!alive.current) return;
        if (!result.ok) {
          const code = result.error && result.error.code;
          setError(code === 'loopback-required' ? t('loopbackRequired') : (result.error && result.error.message) || t('statusUnavailable'));
        } else {
          if (okKey) setNotice(t(okKey));
          if (endpoint === 'login') setNotice(t('loginStarted'));
        }
        setBusy('');
        await load(true);
      }, [rpc, t, load]);

      const onLogout = useCallback(() => {
        try { if (!window.confirm(t('logoutConfirm'))) return; } catch (e) { /* proceed */ }
        void act('logout', 'logoutDone');
      }, [act, t]);

      const blocked = !!(status === null && error);
      return h('div', { className: 'agw-wrap' },
        h('div', { className: 'agw-card' },
          h('div', { className: 'agw-status-row' },
            h('span', { className: `agw-badge ${status && status.loggedIn ? 'is-in' : 'is-out'}`, role: 'status' },
              busy === 'status' ? t('loading') : status ? t(status.loggedIn ? 'signedIn' : 'notSignedIn') : t('statusUnavailable')),
            status && status.loginPending ? h('span', { className: 'agw-badge is-warn' }, t('pendingTitle')) : null),
          status && status.loggedIn ? h('dl', { className: 'agw-kv' },
            status.email ? h('dt', { key: 'ek' }, t('accountEmail')) : null,
            status.email ? h('dd', { key: 'ev' }, status.email) : null,
            status.projectId ? h('dt', { key: 'pk' }, t('accountProject')) : null,
            status.projectId ? h('dd', { key: 'pv' }, status.projectId) : null,
            status.tier && (status.tier.current || status.tier.paid) ? h('dt', { key: 'trk' }, t('accountTier')) : null,
            status.tier && (status.tier.current || status.tier.paid) ? h('dd', { key: 'trv' },
              [status.tier.current && `${status.tier.current.name || status.tier.current.id} (${status.tier.current.id})`, status.tier.paid && `${status.tier.paid.name || status.tier.paid.id} (${status.tier.paid.id})`].filter(Boolean).join(' · ')) : null,
            status.expiresAt ? h('dt', { key: 'tk' }, t('tokenExpiry')) : null,
            status.expiresAt ? h('dd', { key: 'tv' }, new Date(status.expiresAt).toLocaleString()) : null,
            h('dt', { key: 'bk' }, t('backend')),
            h('dd', { key: 'bv' }, status.backend)) : null,
          status && status.loginPending ? h('div', { className: 'agw-pending' },
            h('p', { className: 'agw-note' }, t('pendingHint')),
            status.loginUrl ? h('a', { href: status.loginUrl, target: '_blank', rel: 'noreferrer' }, t('openAuthUrl')) : null,
            h('div', { className: 'agw-actions' },
              h('button', { type: 'button', disabled: busy !== '', onClick: () => void act('cancel', 'loginCancelled') }, t('cancelLogin')))) : null,
          status && status.loginError && !status.loginPending ? h('p', { className: 'agw-error', role: 'alert' }, status.loginError) : null,
          h('div', { className: 'agw-actions' },
            !(status && status.loggedIn) && !(status && status.loginPending) ? h('button', { type: 'button', className: 'agw-primary', disabled: busy !== '' || blocked, onClick: () => void act('login') }, busy === 'login' ? t('starting') : t('signIn')) : null,
            !(status && status.loggedIn) ? h('button', { type: 'button', disabled: busy !== '' || blocked, onClick: () => void act('import', 'importDone') }, t('importAccount')) : null,
            status && status.loggedIn ? h('button', { type: 'button', disabled: busy !== '', onClick: onLogout }, t('logout')) : null,
            h('button', { type: 'button', disabled: busy !== '', onClick: () => void load(false) }, t('refresh'))),
          error ? h('p', { className: 'agw-error', role: 'alert' }, error) : null,
          notice ? h('p', { className: 'agw-ok', role: 'status' }, notice) : null,
          h('p', { className: 'agw-note' }, t('persistentNote'))),
        h('p', { className: 'agw-note' }, t('riskNote')));
    }

    /** @type {TranslateFn | undefined} */
    AccountPanel.t = undefined;
    /** @type {RpcClientLike | null | undefined} */
    AccountPanel.rpc = undefined;

    /** @param {PanelProps} [props] */
    function ModelsPanel(props) {
      const t = (props && props.t) || ModelsPanel.t || fallbackT;
      const rpc = (props && props.rpc) || ModelsPanel.rpc || null;
      const [report, setReport] = useState(/** @type {any} */ (null));
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const alive = useRef(true);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const load = useCallback(/** @param {boolean} [force] */ async (force) => {
        setBusy(true); setError('');
        const result = await rpcCall(rpc, ACCOUNT_NS, 'models', force ? { force: true } : {});
        if (!alive.current) return;
        if (!result.ok) {
          const code = result.error && result.error.code;
          setError(code === 'loopback-required' ? t('loopbackRequired') : (result.error && result.error.message) || t('modelsUnavailable'));
          setReport(null);
        } else {
          setReport(result.value || {});
        }
        setBusy(false);
      }, [rpc, t]);

      useEffect(() => { void load(false); }, [load]);

      const available = report ? (Array.isArray(report.available) ? report.available : Array.isArray(report.models) ? report.models : []) : [];
      const unavailable = report && Array.isArray(report.unavailable) ? report.unavailable : [];
      const quotaGroups = report && Array.isArray(report.quotaGroups) ? report.quotaGroups : [];
      const tier = report && report.tier;
      const tierLabel = tier ? [
        tier.current && `${tier.current.name || tier.current.id} (${tier.current.id})`,
        tier.paid && `${tier.paid.name || tier.paid.id} (${tier.paid.id})`,
      ].filter(Boolean).join(' · ') : '';
      const sourceKey = !report ? '' : report.source === 'live' ? 'sourceLive' : report.source === 'cached' ? 'sourceCached' : 'sourceFallback';
      const sourceBadgeClass = !report ? 'is-out' : report.source === 'live' ? 'is-in' : report.source === 'cached' ? 'is-warn' : 'is-out';

      return h('div', { className: 'agw-wrap' },
        h('p', { className: 'agw-note' }, t('modelsIntro')),
        h('div', { className: 'agw-toolbar' },
          h('button', { type: 'button', disabled: busy, onClick: () => void load(true) }, busy ? t('checking') : t('checkAvailability')),
          sourceKey ? h('span', { className: `agw-badge ${sourceBadgeClass}` }, t(sourceKey)) : null,
          tierLabel ? h('span', { className: 'agw-note' }, `${t('accountTier')}: ${tierLabel}`) : null,
          report && report.checkedAt ? h('span', { className: 'agw-note' }, `${t('checkedAt')}: ${new Date(report.checkedAt).toLocaleString()}`) : null),
        error ? h('p', { className: 'agw-error', role: 'alert' }, error) : null,
        report && report.error ? h('p', { className: 'agw-note' }, report.error) : null,
        quotaGroups.length > 0 ? h('div', { className: 'agw-wrap' },
          h('h3', { className: 'agw-section-title' }, t('quotaTitle')),
          h('div', { className: 'agw-quota-grid' },
            quotaGroups.map((/** @type {any} */ group, /** @type {number} */ idx) => h('div', { key: idx, className: 'agw-quota-card' },
              h('p', { className: 'agw-quota-title' }, group.displayName),
              (group.buckets || []).map((/** @type {any} */ bucket, /** @type {number} */ bi) => h('div', { key: bi, className: 'agw-quota-bucket' },
                h('span', null, bucket.displayName),
                h('span', null, `${Math.round(bucket.remainingFraction * 100)}%${bucket.resetTime ? ` · ${t('quotaResets')} ${new Date(bucket.resetTime).toLocaleTimeString()}` : ''}`))))))) : null,
        report && available.length === 0 && unavailable.length === 0 ? h('p', { className: 'agw-note' }, t('modelsEmpty')) : null,
        available.length > 0 ? h('div', { className: 'agw-wrap' },
          h('h3', { className: 'agw-section-title' }, `${t('availableSection')} (${available.length})`),
          h('ul', { className: 'agw-model-list' },
            available.map((/** @type {any} */ model) => h('li', { key: model.id, className: 'agw-model-row' },
              h('div', { className: 'agw-model-top' },
                h('span', { className: `agw-badge ${model.status === 'quota-exhausted' ? 'is-warn' : 'is-in'}` },
                  t(model.status === 'quota-exhausted' ? 'statusExhausted' : 'statusAvailable')),
                h('span', { className: 'agw-model-id' }, model.id),
                h('span', { className: 'agw-model-name' }, model.name),
                h('span', { className: 'agw-model-meta' },
                  model.efforts && model.efforts.length > 0 ? h('span', null, `${t('efforts')}: ${model.efforts.join('/')}`) : null,
                  typeof model.remainingFraction === 'number' ? h('span', null, `${Math.round(model.remainingFraction * 100)}% ${t('quotaLeft')}`) : null,
                  model.tagTitle ? h('span', { className: 'agw-badge is-warn' }, model.tagTitle) : null)),
              model.tagDescription ? h('p', { className: 'agw-model-reason' }, model.tagDescription) : null)))) : null,
        unavailable.length > 0 ? h('div', { className: 'agw-wrap' },
          h('h3', { className: 'agw-section-title' }, `${t('unavailableSection')} (${unavailable.length})`),
          h('ul', { className: 'agw-model-list' },
            unavailable.map((/** @type {any} */ model) => h('li', { key: model.id, className: 'agw-model-row is-disabled' },
              h('div', { className: 'agw-model-top' },
                h('span', { className: `agw-badge ${model.status === 'disabled' ? 'is-err' : 'is-out'}` },
                  t(model.status === 'disabled' ? 'statusDisabled' : 'statusNotOffered')),
                h('span', { className: 'agw-model-id' }, model.id),
                h('span', { className: 'agw-model-name' }, model.name),
                model.reasonTitle ? h('span', { className: 'agw-model-meta' },
                  h('span', { className: 'agw-badge is-warn' }, model.reasonTitle)) : null),
              model.reasonDetail ? h('p', { className: 'agw-model-reason' }, model.reasonDetail) : null)))) : null);
    }

    /** @type {TranslateFn | undefined} */
    ModelsPanel.t = undefined;
    /** @type {RpcClientLike | null | undefined} */
    ModelsPanel.rpc = undefined;

    /** @param {string} line */
    function levelClass(line) {
      if (line.indexOf('[ERROR]') >= 0) return 'agw-error';
      if (line.indexOf('[WARN ') >= 0) return 'agw-warn';
      if (line.indexOf('[DEBUG]') >= 0) return 'agw-debug';
      return 'agw-info';
    }

    /** @param {PanelProps} [props] */
    function LogPanel(props) {
      const t = (props && props.t) || LogPanel.t || fallbackT;
      const rpc = (props && props.rpc) || LogPanel.rpc || null;
      const [level, setLevel] = useState('info');
      const [lines, setLines] = useState(/** @type {string[]} */ ([]));
      const [meta, setMeta] = useState(/** @type {any} */ (null));
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [copied, setCopied] = useState('');
      const alive = useRef(true);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const load = useCallback(async () => {
        setBusy(true); setError('');
        const result = await rpcCall(rpc, LOG_NS, 'read', { level, limit: 800 });
        if (!alive.current) return;
        if (!result.ok) {
          const code = result.error && result.error.code;
          setError(code === 'loopback-required' ? t('loopbackRequired') : (result.error && result.error.message) || t('unavailable'));
        } else {
          const value = result.value || {};
          setLines(Array.isArray(value.lines) ? value.lines : []);
          setMeta(value);
        }
        setBusy(false);
      }, [rpc, level, t]);

      useEffect(() => { void load(); }, [load]);

      const onCopy = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(lines.join('\n'));
          if (alive.current) { setCopied(t('copied')); setTimeout(() => { if (alive.current) setCopied(''); }, 1500); }
        } catch (e) { if (alive.current) setCopied(t('copyFailed')); }
      }, [lines, t]);

      const onClear = useCallback(async () => {
        try { if (!window.confirm(t('clearConfirm'))) return; } catch (e) { /* proceed */ }
        setBusy(true);
        await rpcCall(rpc, LOG_NS, 'clear', {});
        if (alive.current) await load();
      }, [rpc, t, load]);

      return h('div', { className: 'agw-wrap' },
        h('p', { className: 'agw-note' }, t('logIntro')),
        h('div', { className: 'agw-toolbar' },
          h('label', { htmlFor: 'agw-log-level' }, t('level')),
          h('span', { className: 'agw-select' },
            h('select', { id: 'agw-log-level', value: level, onChange: (/** @type {any} */ e) => setLevel(e.target.value) },
              ['debug', 'info', 'warn', 'error'].map((lv) => h('option', { key: lv, value: lv }, lv)))),
          h('button', { type: 'button', disabled: busy, onClick: () => void load() }, t('refresh')),
          h('button', { type: 'button', disabled: busy || lines.length === 0, onClick: () => void onCopy() }, copied || t('copy')),
          h('button', { type: 'button', disabled: busy, onClick: () => void onClear() }, t('clear'))),
        error ? h('p', { className: 'agw-error', role: 'alert' }, error) : null,
        meta ? h('p', { className: 'agw-note' }, `${t('dir')}: ${meta.dir} · ${t('total')}: ${meta.totalBytes} bytes`) : null,
        meta && meta.truncated ? h('p', { className: 'agw-note' }, t('truncatedNote')) : null,
        h('pre', { className: 'agw-log-body', 'aria-live': 'polite' },
          lines.length === 0 ? t(busy ? 'loading' : 'empty') : lines.map((/** @type {string} */ line, /** @type {number} */ i) => h('span', { key: i, className: `agw-log-line ${levelClass(line)}` }, line))));
    }

    /** @type {TranslateFn | undefined} */
    LogPanel.t = undefined;
    /** @type {RpcClientLike | null | undefined} */
    LogPanel.rpc = undefined;

    /** @param {PanelProps} [props] */
    function GatewayPanel(props) {
      const t = (props && props.t) || GatewayPanel.t || fallbackT;
      const rpc = (props && props.rpc) || GatewayPanel.rpc || null;
      const [tab, setTab] = useState('account');
      useStyles();

      const tabs = [
        { id: 'account', label: t('tabAccount') },
        { id: 'models', label: t('tabModels') },
        { id: 'logs', label: t('tabLogs') },
      ];
      return h('div', { className: 'agw-wrap' },
        h('h1', { style: { margin: '0 0 4px', fontSize: '18px', color: 'var(--dsw-alias-label-primary, #18181b)' } }, t('pageTitle')),
        h('p', { className: 'agw-note' }, t('pageIntro')),
        h('div', { className: 'agw-tabbed' },
          h('div', { className: 'agw-tabs', role: 'tablist', 'aria-label': t('pageTitle') },
            tabs.map((item) => h('button', {
              key: item.id,
              type: 'button',
              role: 'tab',
              id: `agw-tab-${item.id}`,
              'aria-selected': tab === item.id,
              'aria-controls': 'agw-tabpanel',
              className: `agw-tab${tab === item.id ? ' is-active' : ''}`,
              onClick: () => setTab(item.id),
            }, item.label))),
          h('div', { className: 'agw-tabpanel', id: 'agw-tabpanel', role: 'tabpanel', 'aria-labelledby': `agw-tab-${tab}` },
            tab === 'account' ? h(AccountPanel, { rpc, t }) : tab === 'models' ? h(ModelsPanel, { rpc, t }) : h(LogPanel, { rpc, t }))));
    }

    /** @type {TranslateFn | undefined} */
    GatewayPanel.t = undefined;
    /** @type {RpcClientLike | null | undefined} */
    GatewayPanel.rpc = undefined;

    return {
      // Only slots is a hard dependency; locale/connection degrade gracefully.
      inject: ['slots'],
      /** @param {ClientHostContext} ctx */
      apply(ctx) {
        // 1. Locale — register the namespace BEFORE binding it.
        let t = fallbackT;
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            /** @type {(() => void) | null} */
            let dispose = null;
            try {
              dispose = ctx.locale.register(NS, { en, zh });
            } catch (e) {
              try {
                const d1 = ctx.locale.register(NS, 'en', en);
                const d2 = ctx.locale.register(NS, 'zh', zh);
                dispose = () => {
                  if (typeof d1 === 'function') d1();
                  if (typeof d2 === 'function') d2();
                };
              } catch (e2) {
                console.error('[dsh-antigravity-gateway] locale register failed:', e2);
              }
            }
            if (typeof dispose === 'function' && typeof ctx.effect === 'function') ctx.effect(() => dispose);
          }
          if (ctx.locale && typeof ctx.locale.bind === 'function') {
            t = ctx.locale.bind(NS) || fallbackT;
          }
        } catch (e) {
          console.error('[dsh-antigravity-gateway] locale setup failed:', e);
        }

        // 2. RPC client — soft access; panels report "unreachable" if absent.
        let rpc = null;
        try {
          const connection = ctx.get ? ctx.get('connection') : ctx.connection;
          rpc = (connection && connection.rpc) || null;
        } catch (e) {
          console.error('[dsh-antigravity-gateway] connection lookup failed:', e);
        }

        // Statics as a fallback for hosts that do not forward registration props.
        AccountPanel.t = t; AccountPanel.rpc = rpc;
        ModelsPanel.t = t; ModelsPanel.rpc = rpc;
        LogPanel.t = t; LogPanel.rpc = rpc;
        GatewayPanel.t = t; GatewayPanel.rpc = rpc;

        // 3. Slot registration — guarded: the settings slot may not be
        // declared yet at activation time. Never rethrow.
        try {
          const slots = ctx.slots;
          if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
            const registerSlot = slots.register;
            slots.inject('settings.section', () =>
              registerSlot(
                {
                  name: 'settings.section',
                  id: 'antigravity-gateway',
                  order: 31,
                  label: () => t('nav'),
                  inject: () => ({ rpc, t }),
                },
                GatewayPanel,
              ),
            );
          } else {
            console.error('[dsh-antigravity-gateway] slots service unavailable; settings page not registered');
          }
        } catch (e) {
          console.error('[dsh-antigravity-gateway] settings registration failed:', e);
        }
      },
    };
  },
});
