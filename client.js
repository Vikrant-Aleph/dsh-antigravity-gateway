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
 *   remote?: { $on?: (event: string, fn: (...args: any[]) => void) => (() => void) | void },
 *   modelDirectories?: { directoryFor?: (sessionId: string) => { store?: { getSnapshot: () => any, subscribe: (fn: () => void) => () => void } } },
 *   effect?: (fn: () => any) => void,
 *   inject?: (names: string[], fn: (scope: ClientHostContext) => any) => any,
 *   slots?: { inject?: (name: string, fn: () => any) => any, register?: (def: any, component: any) => any }
 * }} ClientHostContext
 * @typedef {{ sessionId?: string, directory?: { store?: { getSnapshot: () => any, subscribe: (fn: () => void) => () => void } } | null, rpc?: RpcClientLike | null, t?: TranslateFn }} ComposerProps
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
    /** @type {{ createPortal?: (node: any, container: any) => any } | null} */
    let ReactDOM = null;
    try { ReactDOM = loadModule('react-dom'); } catch (e) { ReactDOM = null; }

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
      addAccount: 'Add Google account',
      starting: 'Starting…',
      cancelLogin: 'Cancel sign-in',
      importAccount: 'Import from antigravity-auth',
      logout: 'Sign out',
      removeAccount: 'Remove',
      switchAccount: 'Use this account',
      switchedAccount: 'Switched active account.',
      activeBadge: 'Active',
      accountsTitle: 'Signed-in accounts',
      autoSwitchOn: 'Auto-switch on quota exhaustion: enabled (keeps selected model)',
      autoSwitchOff: 'Auto-switch on quota exhaustion: disabled',
      multiAccountCount: 'accounts',
      activeAccountLabel: 'Active account',
      refresh: 'Refresh',
      pendingTitle: 'Waiting for Google authorization…',
      pendingHint: 'Complete the sign-in in the browser window that opened. If nothing opened, use the link below.',
      openAuthUrl: 'Open the Google authorization page',
      loginStarted: 'Sign-in started. Complete authorization in the browser.',
      loginDone: 'Sign-in complete.',
      loginCancelled: 'Sign-in cancelled.',
      importDone: 'Account imported from dsh-antigravity-auth.',
      logoutDone: 'Account removed from local storage.',
      logoutConfirm: 'Remove this account credential from local storage?',
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
      quotaResets: 'Resets in',
      resetSoon: 'Resetting soon',
      quotaCurrentModel: 'Selected model',
      quotaNoData: 'Quota details unavailable yet. Click to refresh.',
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
      addAccount: '添加 Google 账号',
      starting: '正在启动…',
      cancelLogin: '取消登录',
      importAccount: '从 antigravity-auth 导入',
      logout: '退出登录',
      removeAccount: '移除',
      switchAccount: '设为当前',
      switchedAccount: '已切换当前账号。',
      activeBadge: '当前使用',
      accountsTitle: '已登录账号列表',
      autoSwitchOn: '额度耗尽自动切换账号：已开启（保留当前所选模型）',
      autoSwitchOff: '额度耗尽自动切换账号：已关闭',
      multiAccountCount: '个账号',
      activeAccountLabel: '当前账号',
      refresh: '刷新',
      pendingTitle: '等待 Google 授权…',
      pendingHint: '请在已打开的浏览器窗口中完成登录。如果没有自动打开，请使用下面的链接。',
      openAuthUrl: '打开 Google 授权页面',
      loginStarted: '登录已启动，请在浏览器中完成授权。',
      loginDone: '登录完成。',
      loginCancelled: '登录已取消。',
      importDone: '已从 dsh-antigravity-auth 导入账号。',
      logoutDone: '已移除本地账号凭据。',
      logoutConfirm: '确定移除该账号的本地凭据吗？',
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
      quotaResets: '重置于',
      resetSoon: '即将重置',
      quotaCurrentModel: '当前所选模型',
      quotaNoData: '暂无额度明细，点击可刷新。',
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
      .agw-model-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
      .agw-model-row {
        display: flex; flex-direction: column; gap: 8px;
        padding: 14px 16px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.025));
      }
      .agw-model-row.is-disabled { opacity: 0.78; padding: 10px 14px; }
      .agw-model-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .agw-model-identity { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; min-width: 0; }
      .agw-model-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #18181b); line-height: 1.35; }
      .agw-model-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); overflow-wrap: anywhere; }
      .agw-model-pct { font-size: 18px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, #18181b); flex-shrink: 0; }
      .agw-model-pct.is-warn { color: var(--dsw-alias-state-warn-primary, #d97706); }
      .agw-model-pct.is-err { color: var(--dsw-alias-state-error-primary, #dc2626); }
      .agw-model-sub { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); line-height: 1.4; }
      .agw-model-status-text { font-weight: 500; }
      .agw-model-status-text.is-in { color: var(--dsw-alias-state-success-primary, #16a34a); }
      .agw-model-status-text.is-err { color: var(--dsw-alias-state-error-primary, #dc2626); }
      .agw-model-reason { font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); margin: 2px 0 0; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06)); line-height: 1.5; }
      .agw-panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .agw-panel-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .agw-panel-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #18181b); margin: 0; line-height: 1.35; }
      .agw-panel-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); }
      .agw-section-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #18181b); margin: 4px 0 0; }
      .agw-quota-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
      .agw-quota-card { padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.025)); display: flex; flex-direction: column; gap: 8px; }
      .agw-quota-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .agw-quota-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary, #71717a); margin: 0; }
      .agw-quota-big { font-size: 20px; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, #18181b); }
      .agw-quota-big.is-warn { color: var(--dsw-alias-state-warn-primary, #d97706); }
      .agw-quota-big.is-err { color: var(--dsw-alias-state-error-primary, #dc2626); }
      .agw-quota-bucket-wrap { display: flex; flex-direction: column; gap: 4px; }
      .agw-quota-bucket { font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); display: flex; justify-content: space-between; gap: 8px; align-items: center; }
      .agw-quota-window { font-weight: 700; color: var(--dsw-alias-label-primary, #18181b); white-space: nowrap; }
      .agw-quota-reset { font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); white-space: nowrap; }
      .agw-details { border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); padding-top: 8px; }
      .agw-details summary { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, #18181b); cursor: pointer; padding: 4px 0; list-style: none; display: flex; align-items: center; justify-content: space-between; }
      .agw-details summary::-webkit-details-marker { display: none; }
      .agw-details[open] summary { margin-bottom: 8px; }
      .agw-progress-track { width: 100%; height: 5px; border-radius: 999px; background: var(--dsw-alias-border-l1, rgba(0,0,0,0.09)); overflow: hidden; }
      .agw-progress-fill { height: 100%; border-radius: 999px; transition: width 0.2s ease; }
      .agw-progress-fill.is-good { background: var(--dsw-alias-state-success-primary, #16a34a); }
      .agw-progress-fill.is-warn { background: var(--dsw-alias-state-warn-primary, #d97706); }
      .agw-progress-fill.is-err { background: var(--dsw-alias-state-error-primary, #dc2626); }
      .agw-account-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .agw-account-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.5)); }
      .agw-account-item.is-active { border-color: var(--dsw-alias-brand-primary, #247bbf); }
      .agw-account-info { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
      .agw-account-ops { display: flex; align-items: center; gap: 6px; }
      .agw-account-ops button { font-size: 11px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.15)); background: var(--dsw-alias-bg-layer-2, transparent); color: var(--dsw-alias-label-primary, #18181b); cursor: pointer; }
      .agw-account-ops button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #247bbf); }
      .agw-composer-wrap { position: relative; display: inline-flex; align-items: center; height: 28px; }
      .agw-composer-chip {
        display: inline-flex; align-items: center;
        height: 28px; padding: 0 4px; margin: 0;
        border: none; border-radius: var(--dsw-radius-sm, 6px);
        background: transparent;
        color: var(--dsw-alias-label-secondary, #71717a);
        font-family: inherit;
        font-size: 13px; line-height: 20px; font-weight: 600;
        font-variant-numeric: tabular-nums;
        cursor: pointer; white-space: nowrap;
      }
      .agw-composer-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #18181b); }
      .agw-composer-chip.is-warn { color: var(--dsw-alias-state-warn-primary, #d97706); }
      .agw-composer-chip.is-err { color: var(--dsw-alias-state-error-primary, #dc2626); }
      .agw-quota-popover {
        position: fixed; z-index: 9999; min-width: 260px; max-width: 340px;
        padding: 10px 12px; border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        color: var(--dsw-alias-label-primary, #18181b);
        box-shadow: 0 10px 28px rgba(0,0,0,0.16);
        display: flex; flex-direction: column; gap: 8px; font-size: 12px;
      }
      .agw-popover-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 600; font-size: 12px; }
      .agw-popover-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, #71717a); }
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

    /** @param {number} fraction */
    function clampFraction(fraction) {
      if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return 0;
      return Math.max(0, Math.min(1, fraction));
    }

    /** @param {number} fraction */
    function quotaTone(fraction) {
      const f = clampFraction(fraction);
      if (f <= 0) return 'is-err';
      if (f <= 0.25) return 'is-warn';
      return 'is-good';
    }

    /** @param {any} bucket */
    function formatBucketWindowLabel(bucket) {
      const w = bucket && typeof bucket.window === 'string' ? bucket.window.trim() : '';
      const text = `${w} ${(bucket && bucket.displayName) || ''} ${(bucket && bucket.bucketId) || ''}`;
      if (/^5\s*h$/i.test(w) || /\b5\s*h\b|five\s*hour/i.test(text)) return '5h';
      if (/^(?:weekly|7\s*d)$/i.test(w) || /weekly|\b7\s*d\b/i.test(text)) return 'weekly';
      return w || (bucket && bucket.displayName) || '';
    }

    /**
     * @param {string | undefined} iso
     * @param {TranslateFn} t
     * @returns {string}
     */
    function formatResetTime(iso, t) {
      if (!iso) return '';
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return '';
      const diffMs = ms - Date.now();
      if (diffMs <= 0) return t('resetSoon');
      const totalMins = Math.ceil(diffMs / 60_000);
      let countdown;
      if (totalMins >= 1440) {
        const d = Math.floor(totalMins / 1440);
        const hPart = Math.floor((totalMins % 1440) / 60);
        countdown = hPart > 0 ? `${d}d ${hPart}h` : `${d}d`;
      } else if (totalMins >= 60) {
        const hPart = Math.floor(totalMins / 60);
        const mPart = totalMins % 60;
        countdown = mPart > 0 ? `${hPart}h ${mPart}m` : `${hPart}h`;
      } else {
        countdown = `${totalMins}m`;
      }
      const clock = totalMins >= 1440
        ? new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `${countdown} (${clock})`;
    }

    /** @param {{ fraction: number, compact?: boolean, label?: string }} props */
    function ProgressBar(props) {
      const pct = Math.round(clampFraction(props.fraction) * 100);
      return h('div', {
        className: `agw-progress-track${props.compact ? ' is-compact' : ''}`,
        role: 'progressbar',
        'aria-valuenow': pct,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        ...(props.label ? { 'aria-label': props.label } : {}),
      }, h('div', { className: `agw-progress-fill ${quotaTone(props.fraction)}`, style: { width: `${pct}%` } }));
    }

    /**
     * @param {any} report
     * @param {string} modelId
     * @returns {{ window: string, remainingFraction: number, resetTime?: string, label?: string } | null}
     */
    function selectCompactQuota(report, modelId) {
      if (!report) return null;
      const lower = String(modelId || '').toLowerCase();
      const family = lower.includes('claude') ? 'claude' : lower.includes('gemini') ? 'gemini' : lower.includes('gpt') ? 'gpt' : '';
      const groups = Array.isArray(report.quotaGroups) ? report.quotaGroups : [];
      const available = Array.isArray(report.available) ? report.available : [];
      const modelDetail = available.find((/** @type {any} */ item) => item && item.id === modelId) || null;

      /** @param {any} b */
      const is5h = (b) => (b && typeof b.window === 'string' && /^5\s*h$/i.test(b.window.trim())) || /\b5\s*h\b|five\s*hour/i.test(`${(b && b.displayName) || ''} ${(b && b.bucketId) || ''}`);
      /** @param {any} g @param {any} b */
      const matchesFam = (g, b) => {
        const txt = `${(g && g.displayName) || ''} ${(b && b.bucketId) || ''}`.toLowerCase();
        if (family === 'claude') return txt.indexOf('claude') >= 0;
        if (family === 'gemini') return txt.indexOf('gemini') >= 0;
        if (family === 'gpt') return txt.indexOf('gpt') >= 0 || txt.indexOf('openai') >= 0;
        return false;
      };

      let matched = null;
      if (family) {
        for (const g of groups) {
          for (const b of (g && g.buckets) || []) {
            if (is5h(b) && matchesFam(g, b)) { matched = b; break; }
          }
          if (matched) break;
        }
      }
      if (!matched) {
        const all5h = [];
        for (const g of groups) {
          for (const b of (g && g.buckets) || []) {
            if (is5h(b)) all5h.push(b);
          }
        }
        if (all5h.length === 1) matched = all5h[0];
      }
      if (matched && typeof matched.remainingFraction === 'number') {
        const frac = modelDetail && typeof modelDetail.remainingFraction === 'number'
          ? Math.min(matched.remainingFraction, modelDetail.remainingFraction)
          : matched.remainingFraction;
        return {
          window: '5h',
          remainingFraction: frac,
          resetTime: matched.resetTime || (modelDetail && modelDetail.resetTime) || undefined,
          label: matched.displayName,
        };
      }
      if (modelDetail && typeof modelDetail.remainingFraction === 'number') {
        return {
          window: 'model',
          remainingFraction: modelDetail.remainingFraction,
          resetTime: modelDetail.resetTime,
          label: modelDetail.name,
        };
      }
      return null;
    }

    /** Shared client catalog/quota state so Settings & Composer stay synchronized. */
    const sharedQuotaState = {
      /** @type {any} */
      report: null,
      /** @type {string[]} */
      providers: ['antigravity-gateway'],
      lastFetchedAt: 0,
      /** @type {Promise<any> | null} */
      inflight: null,
      /** @type {Set<() => void>} */
      listeners: new Set(),
    };

    /** @param {any} value */
    function publishSharedQuota(value) {
      if (value && Array.isArray(value.providers) && value.providers.length > 0) {
        sharedQuotaState.providers = value.providers;
      }
      if (value && (Array.isArray(value.quotaGroups) || Array.isArray(value.available))) {
        sharedQuotaState.report = value;
        sharedQuotaState.lastFetchedAt = Date.now();
      }
      for (const fn of Array.from(sharedQuotaState.listeners)) {
        try { fn(); } catch (e) { /* ignore */ }
      }
    }

    /**
     * @param {RpcClientLike | null} rpc
     * @param {boolean} [force]
     * @returns {Promise<RpcResult>}
     */
    async function fetchModelsReport(rpc, force) {
      if (!force && sharedQuotaState.inflight) return sharedQuotaState.inflight;
      const run = rpcCall(rpc, ACCOUNT_NS, 'models', force ? { force: true } : {}).then((res) => {
        if (res.ok && res.value) publishSharedQuota(res.value);
        return res;
      }).finally(() => {
        if (sharedQuotaState.inflight === run) sharedQuotaState.inflight = null;
      });
      sharedQuotaState.inflight = run;
      return run;
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

      const act = useCallback(/** @param {string} endpoint @param {string} [okKey] @param {Record<string, unknown>} [payload] */ async (endpoint, okKey, payload) => {
        setBusy(endpoint); setError(''); setNotice('');
        const result = await rpcCall(rpc, ACCOUNT_NS, endpoint, payload || {});
        if (!alive.current) return;
        if (!result.ok) {
          const code = result.error && result.error.code;
          setError(code === 'loopback-required' ? t('loopbackRequired') : (result.error && result.error.message) || t('statusUnavailable'));
        } else {
          if (okKey) setNotice(t(okKey));
          if (endpoint === 'login') setNotice(t('loginStarted'));
          if (endpoint === 'switch' || endpoint === 'logout' || endpoint === 'import') {
            void fetchModelsReport(rpc, false);
          }
        }
        setBusy('');
        await load(true);
      }, [rpc, t, load]);

      const onLogout = useCallback(/** @param {string} [accountId] */ (accountId) => {
        try { if (!window.confirm(t('logoutConfirm'))) return; } catch (e) { /* proceed */ }
        void act('logout', 'logoutDone', accountId ? { accountId } : {});
      }, [act, t]);

      const blocked = !!(status === null && error);
      const accounts = status && Array.isArray(status.accounts) ? status.accounts : [];
      return h('div', { className: 'agw-wrap' },
        h('div', { className: 'agw-card' },
          h('div', { className: 'agw-status-row' },
            h('span', { className: `agw-badge ${status && status.loggedIn ? 'is-in' : 'is-out'}`, role: 'status' },
              busy === 'status' ? t('loading') : status ? t(status.loggedIn ? 'signedIn' : 'notSignedIn') : t('statusUnavailable')),
            accounts.length > 1 ? h('span', { className: 'agw-badge is-in' }, `${accounts.length} ${t('multiAccountCount')}`) : null,
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
          accounts.length > 0 ? h('div', { className: 'agw-wrap' },
            h('p', { className: 'agw-section-title' }, `${t('accountsTitle')} (${accounts.length})`),
            h('ul', { className: 'agw-account-list' },
              accounts.map((/** @type {any} */ acct) => h('li', { key: acct.id, className: `agw-account-item${acct.active ? ' is-active' : ''}` },
                h('div', { className: 'agw-account-info' },
                  acct.active ? h('span', { className: 'agw-badge is-in' }, t('activeBadge')) : null,
                  h('span', null, acct.email || acct.projectId || acct.id),
                  acct.email && acct.projectId ? h('span', { className: 'agw-note' }, `(${acct.projectId})`) : null),
                h('div', { className: 'agw-account-ops' },
                  !acct.active ? h('button', { type: 'button', disabled: busy !== '', onClick: () => void act('switch', 'switchedAccount', { accountId: acct.id }) }, t('switchAccount')) : null,
                  h('button', { type: 'button', disabled: busy !== '', onClick: () => onLogout(acct.id) }, t('removeAccount')))))),
            h('p', { className: 'agw-note' }, t(status && status.autoSwitchAccount !== false ? 'autoSwitchOn' : 'autoSwitchOff'))) : null,
          status && status.loginPending ? h('div', { className: 'agw-pending' },
            h('p', { className: 'agw-note' }, t('pendingHint')),
            status.loginUrl ? h('a', { href: status.loginUrl, target: '_blank', rel: 'noreferrer' }, t('openAuthUrl')) : null,
            h('div', { className: 'agw-actions' },
              h('button', { type: 'button', disabled: busy !== '', onClick: () => void act('cancel', 'loginCancelled') }, t('cancelLogin')))) : null,
          status && status.loginError && !status.loginPending ? h('p', { className: 'agw-error', role: 'alert' }, status.loginError) : null,
          h('div', { className: 'agw-actions' },
            !(status && status.loginPending) ? h('button', { type: 'button', className: 'agw-primary', disabled: busy !== '' || blocked, onClick: () => void act('login') }, busy === 'login' ? t('starting') : t(status && status.loggedIn ? 'addAccount' : 'signIn')) : null,
            h('button', { type: 'button', disabled: busy !== '' || blocked, onClick: () => void act('import', 'importDone') }, t('importAccount')),
            status && status.loggedIn ? h('button', { type: 'button', disabled: busy !== '', onClick: () => onLogout() }, t('logout')) : null,
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
        const result = await fetchModelsReport(rpc, force);
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
      const activeAccount = report && report.activeAccount;
      const tier = report && report.tier;
      const tierLabel = tier ? [
        tier.current && `${tier.current.name || tier.current.id} (${tier.current.id})`,
        tier.paid && `${tier.paid.name || tier.paid.id} (${tier.paid.id})`,
      ].filter(Boolean).join(' · ') : '';
      const sourceKey = !report ? '' : report.source === 'live' ? 'sourceLive' : report.source === 'cached' ? 'sourceCached' : 'sourceFallback';
      const sourceBadgeClass = !report ? 'is-out' : report.source === 'live' ? 'is-in' : report.source === 'cached' ? 'is-warn' : 'is-out';

      return h('div', { className: 'agw-wrap' },
        h('div', { className: 'agw-panel-header' },
          h('div', { className: 'agw-panel-heading' },
            h('h2', { className: 'agw-panel-title' }, t('modelsTitle')),
            h('div', { className: 'agw-panel-meta' },
              sourceKey ? h('span', { className: `agw-badge ${sourceBadgeClass}` }, t(sourceKey)) : null,
              activeAccount && (activeAccount.email || activeAccount.projectId) ? h('span', null, `${t('activeAccountLabel')}: ${activeAccount.email || activeAccount.projectId}`) : null,
              tierLabel ? h('span', null, `${t('accountTier')}: ${tierLabel}`) : null,
              report && report.checkedAt ? h('span', null, `${t('checkedAt')} ${new Date(report.checkedAt).toLocaleString()}`) : null)),
          h('div', { className: 'agw-toolbar' },
            h('button', { type: 'button', disabled: busy, onClick: () => void load(true) }, busy ? t('checking') : t('checkAvailability')))),
        error ? h('p', { className: 'agw-error', role: 'alert' }, error) : null,
        report && report.error ? h('p', { className: 'agw-note' }, report.error) : null,
        quotaGroups.length > 0 ? h('div', { className: 'agw-wrap' },
          h('h3', { className: 'agw-section-title' }, t('quotaTitle')),
          h('div', { className: 'agw-quota-grid' },
            quotaGroups.flatMap((/** @type {any} */ group, /** @type {number} */ idx) =>
              (group.buckets || []).map((/** @type {any} */ bucket, /** @type {number} */ bi) => {
                const resetLabel = formatResetTime(bucket.resetTime, t);
                const pct = Math.round(clampFraction(bucket.remainingFraction) * 100);
                const tone = quotaTone(bucket.remainingFraction);
                const bigTone = tone === 'is-err' ? ' is-err' : tone === 'is-warn' ? ' is-warn' : '';
                return h('div', { key: `${idx}-${bi}`, className: 'agw-quota-card' },
                  h('div', { className: 'agw-quota-card-head' },
                    h('p', { className: 'agw-quota-title' }, group.displayName),
                    h('span', { className: `agw-quota-big${bigTone}` }, `${pct}%`)),
                  h(ProgressBar, { fraction: bucket.remainingFraction, label: `${group.displayName} ${bucket.displayName}` }),
                  h('div', { className: 'agw-quota-bucket' },
                    h('strong', { className: 'agw-quota-window' }, formatBucketWindowLabel(bucket)),
                    resetLabel ? h('span', { className: 'agw-quota-reset' }, `${t('quotaResets')} ${resetLabel}`) : null));
              })))) : null,
        report && available.length === 0 && unavailable.length === 0 ? h('p', { className: 'agw-note' }, t('modelsEmpty')) : null,
        available.length > 0 ? h('div', { className: 'agw-wrap' },
          h('h3', { className: 'agw-section-title' }, `${t('availableSection')} (${available.length})`),
          h('ul', { className: 'agw-model-list' },
            available.map((/** @type {any} */ model) => {
              const statusText = t(model.status === 'quota-exhausted' ? 'statusExhausted' : 'statusAvailable');
              return h('li', { key: model.id, className: 'agw-model-row' },
                h('div', { className: 'agw-model-head' },
                  h('div', { className: 'agw-model-identity' },
                    h('span', { className: 'agw-model-title' }, model.name || model.id),
                    model.tagTitle ? h('span', { className: 'agw-badge is-warn' }, model.tagTitle) : null),
                  h('span', { className: `agw-badge ${model.status === 'quota-exhausted' ? 'is-err' : 'is-in'}` }, statusText)),
                model.efforts && model.efforts.length > 0
                  ? h('div', { className: 'agw-model-sub' },
                      h('span', null, `${t('efforts')}: ${model.efforts.join(' / ')}`))
                  : null);
            }))) : null,
        unavailable.length > 0 ? h('details', { className: 'agw-details', ...(available.length === 0 ? { open: true } : {}) },
          h('summary', null,
            h('span', null, `${t('unavailableSection')} (${unavailable.length})`),
            h('span', { className: 'agw-note' }, '▾')),
          h('ul', { className: 'agw-model-list' },
            unavailable.map((/** @type {any} */ model) => h('li', { key: model.id, className: 'agw-model-row is-disabled' },
              h('div', { className: 'agw-model-head' },
                h('div', { className: 'agw-model-identity' },
                  h('span', { className: 'agw-model-title' }, model.name || model.id)),
                h('span', { className: `agw-badge ${model.status === 'disabled' ? 'is-err' : 'is-out'}` },
                  t(model.status === 'disabled' ? 'statusDisabled' : 'statusNotOffered'))),
              model.reasonTitle || model.reasonDetail
                ? h('p', { className: 'agw-model-reason' }, [model.reasonTitle, model.reasonDetail].filter(Boolean).join(' — '))
                : null)))) : null);
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

    /**
     * Compact 5h quota chip (`5h | 87%`) rendered to the left of the model name
     * inside `conversation.input.right`. Hidden unless an owned provider model
     * is selected; hover/focus opens a body-portaled card with full quota info.
     * @param {ComposerProps} [props]
     */
    function ComposerQuotaBadge(props) {
      const t = (props && props.t) || ComposerQuotaBadge.t || fallbackT;
      const rpc = (props && props.rpc) || ComposerQuotaBadge.rpc || null;
      const directory = props && props.directory;
      const store = directory && directory.store;
      useStyles();

      const [selection, setSelection] = useState(() => (store ? store.getSnapshot()?.current ?? null : null));
      const [quotaVer, setQuotaVer] = useState(0);
      const [open, setOpen] = useState(false);
      const [coords, setCoords] = useState({ left: 16, bottom: 56 });
      const chipRef = useRef(/** @type {any} */ (null));
      const closeTimer = useRef(/** @type {any} */ (null));

      useEffect(() => {
        if (!store) return undefined;
        setSelection(store.getSnapshot()?.current ?? null);
        return store.subscribe(() => {
          setSelection(store.getSnapshot()?.current ?? null);
        });
      }, [store]);

      useEffect(() => {
        const listener = () => setQuotaVer((/** @type {number} */ v) => v + 1);
        sharedQuotaState.listeners.add(listener);
        return () => { sharedQuotaState.listeners.delete(listener); };
      }, []);

      const isOwned = !!(selection && sharedQuotaState.providers.includes(selection.provider));

      useEffect(() => {
        if (!isOwned || !rpc) return undefined;
        if (!sharedQuotaState.report || Date.now() - sharedQuotaState.lastFetchedAt > 30_000) {
          void fetchModelsReport(rpc, false);
        }
        const timer = setInterval(() => {
          void fetchModelsReport(rpc, false);
        }, 60_000);
        return () => clearInterval(timer);
      }, [isOwned, rpc, selection && selection.provider, selection && selection.model]);

      useEffect(() => () => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
      }, []);

      if (!isOwned || !selection) return null;

      void quotaVer;
      const report = sharedQuotaState.report;
      const compact = selectCompactQuota(report, selection.model);
      const pct = compact ? Math.round(clampFraction(compact.remainingFraction) * 100) : null;
      const chipText = pct !== null ? `5h | ${pct}%` : '5h | --';
      const tone = compact ? quotaTone(compact.remainingFraction) : 'is-out';
      const toneClass = tone === 'is-err' ? ' is-err' : tone === 'is-warn' ? ' is-warn' : '';

      const updateAnchor = () => {
        try {
          const el = chipRef.current;
          if (el && typeof el.getBoundingClientRect === 'function') {
            const rect = el.getBoundingClientRect();
            const winW = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1024;
            const winH = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 768;
            setCoords({
              left: Math.max(8, Math.min(rect.left, winW - 350)),
              bottom: Math.max(8, winH - rect.top + 8),
            });
          }
        } catch (e) { /* non-DOM test */ }
      };

      const openPopover = () => {
        if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
        updateAnchor();
        setOpen(true);
      };
      const scheduleClose = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => { setOpen(false); }, 120);
      };

      const groups = report && Array.isArray(report.quotaGroups) ? report.quotaGroups : [];
      const activeAccount = report && report.activeAccount;
      const accountCount = report && typeof report.accountCount === 'number' ? report.accountCount : 0;

      const popover = open
        ? h('div', {
            className: 'agw-quota-popover',
            role: 'tooltip',
            style: { left: `${coords.left}px`, bottom: `${coords.bottom}px` },
            onMouseEnter: openPopover,
            onMouseLeave: scheduleClose,
          },
          h('div', { className: 'agw-popover-head' },
            h('span', null, t('quotaTitle')),
            accountCount > 1 ? h('span', { className: 'agw-badge is-in' }, `${accountCount} ${t('multiAccountCount')}`) : null),
          activeAccount && (activeAccount.email || activeAccount.projectId)
            ? h('div', { className: 'agw-popover-sub' }, `${t('activeAccountLabel')}: ${activeAccount.email || activeAccount.projectId}`)
            : null,
          groups.length > 0
            ? groups.map((/** @type {any} */ g, /** @type {number} */ gi) => h('div', { key: gi, className: 'agw-quota-bucket-wrap' },
                h('div', { className: 'agw-popover-sub', style: { fontWeight: 600 } }, g.displayName),
                (g.buckets || []).map((/** @type {any} */ b, /** @type {number} */ bi) => {
                  const resetStr = formatResetTime(b.resetTime, t);
                  return h('div', { key: bi, className: 'agw-quota-bucket-wrap' },
                    h('div', { className: 'agw-quota-bucket' },
                      h('strong', { className: 'agw-quota-window' }, formatBucketWindowLabel(b)),
                      h('strong', null, `${Math.round(clampFraction(b.remainingFraction) * 100)}%`)),
                    h(ProgressBar, { fraction: b.remainingFraction, label: `${g.displayName} ${b.displayName}` }),
                    resetStr ? h('span', { className: 'agw-quota-reset' }, `${t('quotaResets')} ${resetStr}`) : null);
                })))
            : h('div', { className: 'agw-popover-sub' }, t('quotaNoData')))
        : null;

      const portalTarget = typeof document !== 'undefined' ? document.body : null;
      const renderedPopover = popover && ReactDOM && typeof ReactDOM.createPortal === 'function' && portalTarget
        ? ReactDOM.createPortal(popover, portalTarget)
        : popover;

      return h('span', {
        ref: chipRef,
        className: 'agw-composer-wrap',
        onMouseEnter: openPopover,
        onMouseLeave: scheduleClose,
      },
      h('button', {
        type: 'button',
        className: `agw-composer-chip${toneClass}`,
        onFocus: openPopover,
        onBlur: scheduleClose,
        onClick: () => { if (rpc) void fetchModelsReport(rpc, true); },
        'aria-label': `${t('quotaTitle')}: ${chipText}`,
      }, chipText),
      renderedPopover);
    }

    /** @type {TranslateFn | undefined} */
    ComposerQuotaBadge.t = undefined;
    /** @type {RpcClientLike | null | undefined} */
    ComposerQuotaBadge.rpc = undefined;

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
        ComposerQuotaBadge.t = t; ComposerQuotaBadge.rpc = rpc;

        // Subscribe to Host model catalog updates so composer quota refreshes
        // automatically after account switch / failover.
        try {
          const remote = (ctx.get ? ctx.get('remote') : ctx.remote);
          if (remote && typeof remote.$on === 'function') {
            const off = remote.$on('llm/models-updated', (/** @type {any} */ provider) => {
              if (!provider || sharedQuotaState.providers.includes(String(provider))) {
                if (rpc) void fetchModelsReport(rpc, false);
              }
            });
            if (typeof off === 'function' && typeof ctx.effect === 'function') ctx.effect(() => off);
          }
        } catch (e) { /* optional remote events */ }

        // Warm provider list + quota cache softly.
        if (rpc) void fetchModelsReport(rpc, false);

        // 3. Slot registration — guarded: the settings slot may not be
        // declared yet at activation time. Never rethrow.
        try {
          const slots = ctx.slots;
          if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
            const registerSlot = slots.register;
            slots.inject('settings.section', () => {
              try {
                return registerSlot.call(
                  slots,
                  {
                    name: 'settings.section',
                    id: 'antigravity-gateway',
                    order: 31,
                    label: () => t('nav'),
                    inject: () => ({ rpc, t }),
                  },
                  GatewayPanel,
                );
              } catch (e) {
                console.error('[dsh-antigravity-gateway] settings slot callback failed:', e);
                return undefined;
              }
            });
          } else {
            console.error('[dsh-antigravity-gateway] slots service unavailable; settings page not registered');
          }
        } catch (e) {
          console.error('[dsh-antigravity-gateway] settings registration failed:', e);
        }

        // 4. Composer inline 5h quota chip (`conversation.input.right`, soft dependency on modelDirectories).
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['slots', 'modelDirectories'], (scope) => {
              try {
                const scopedSlots = scope.slots;
                const dirs = scope.modelDirectories;
                if (!scopedSlots || typeof scopedSlots.inject !== 'function' || typeof scopedSlots.register !== 'function') {
                  return undefined;
                }
                const registerComposerSlot = scopedSlots.register;
                return scopedSlots.inject('conversation.input.right', () => {
                  try {
                    return registerComposerSlot.call(
                      scopedSlots,
                      {
                        name: 'conversation.input.right',
                        id: 'antigravity-gateway-quota',
                        order: 10,
                        inject: (/** @type {string} */ sessionId) => {
                          let directory = null;
                          try {
                            directory = dirs && typeof dirs.directoryFor === 'function' ? dirs.directoryFor(sessionId) : null;
                          } catch (e) {
                            directory = null;
                          }
                          return { sessionId, directory, rpc, t };
                        },
                      },
                      ComposerQuotaBadge,
                    );
                  } catch (e) {
                    console.error('[dsh-antigravity-gateway] composer quota slot callback failed:', e);
                    return undefined;
                  }
                });
              } catch (e) {
                console.error('[dsh-antigravity-gateway] composer quota setup failed:', e);
                return undefined;
              }
            });
          }
        } catch (e) {
          console.error('[dsh-antigravity-gateway] composer quota inject failed:', e);
        }
      },
    };
  },
});
