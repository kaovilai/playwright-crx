/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { LogName } from 'playwright-core/lib/server/utils/debugLogger';
import { debugLogger } from 'playwright-core/lib/server/utils/debugLogger';
import type { Protocol } from 'playwright-core/lib/server/chromium/protocol';
import type { Progress } from 'playwright-core/lib/server/progress';
import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from 'playwright-core/lib/server/transport';
import { createTab } from '../utils';

type Tab = chrome.tabs.Tab;

// mimics DebuggerSession on https://chromium-review.googlesource.com/c/chromium/src/+/5398119/12/chrome/common/extensions/api/debugger.json
// TODO replace with proper type when available
type DebuggerSession = chrome.debugger.Debuggee & { sessionId?: string };

export class CrxTransport implements ConnectionTransport {
  private _progress?: Progress;
  private _closePromise?: Promise<void>;
  private _closing = false;
  private _targetToTab: Map<string, number>;
  private _tabToTarget: Map<number, Protocol.Target.TargetInfo>;
  private _sessions: Map<string, number>;
  private _sessionTargets: Map<string, string>;
  private _sessionTargetInfos: Map<string, Protocol.Target.TargetInfo>;
  private _staleSessions: Map<string, number>;
  private _staleSessionTargets: Map<string, string>;
  private _staleSessionTargetInfos: Map<string, Protocol.Target.TargetInfo>;
  private _sessionAliases: Map<string, string>;
  private _sessionRecoveryPromises: Map<string, Promise<{ tabId: number, sessionId: string }>>;
  private _attachPromises: Map<number, Promise<Protocol.Target.TargetInfo>>;
  private _detachPromises: Map<number, Promise<void>>;
  private _reconnectPromises: Map<number, Promise<void>>;
  private _detachingTabs: Set<number>;
  private _defaultBrowserContextId?: string;

  onmessage?: (message: ProtocolResponse) => void;
  onclose?: () => void;

  constructor(progress?: Progress) {
    this._progress = progress;
    this._tabToTarget = new Map();
    this._targetToTab = new Map();
    this._sessions = new Map();
    this._sessionTargets = new Map();
    this._sessionTargetInfos = new Map();
    this._staleSessions = new Map();
    this._staleSessionTargets = new Map();
    this._staleSessionTargetInfos = new Map();
    this._sessionAliases = new Map();
    this._sessionRecoveryPromises = new Map();
    this._attachPromises = new Map();
    this._detachPromises = new Map();
    this._reconnectPromises = new Map();
    this._detachingTabs = new Set();
    chrome.debugger.onEvent.addListener(this._onDebuggerEvent);
    chrome.debugger.onDetach.addListener(this._onDebuggerDetach);
    chrome.tabs.onRemoved.addListener(this._onTabRemoved);
    chrome.tabs.onCreated.addListener(this._onPopupCreated);
  }

  isIncognito(tabIdOrTargetId: number | string | undefined) {
    if (typeof tabIdOrTargetId === 'string')
      tabIdOrTargetId = this.getTabId(tabIdOrTargetId);
    if (!tabIdOrTargetId)
      return;
    return this._tabToTarget.get(tabIdOrTargetId)?.browserContextId !== this._defaultBrowserContextId;
  }

  getTargetId(tabId: number) {
    return this._tabToTarget.get(tabId)?.targetId;
  }

  getTabId(targetId: string) {
    return this._targetToTab.get(targetId);
  }

  async send(message: ProtocolRequest) {
    try {
      if (this._closing)
        throw new Error('Connection is closing');
      const { tabId, debuggee } = await this._resolveDebuggee(message);

      let result;
      // chrome extensions doesn't support all CDP commands so we need to handle them
      if (message.method === 'Target.setAutoAttach' && !debuggee.tabId) {
        // no tab to attach, just skip for now...
        result = await Promise.resolve();
      } else if (message.method === 'Target.setAutoAttach') {
        const [, versionStr] = navigator.userAgent.match(/Chrome\/([0-9]+)./) ?? [];

        // we need to exclude service workers, see:
        // https://github.com/ruifigueira/playwright-crx/issues/1
        // https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach
        result = await this._send(debuggee, message.method, { ...message.params, filter: [
          { exclude: true, type: 'service_worker' },
          // and these are the defaults:
          // https://chromedevtools.github.io/devtools-protocol/tot/Target/#type-TargetFilter
          { exclude: true, type: 'browser' },
          { exclude: true, type: 'tab' },
          // in versions prior to 126, this fallback doesn't work,
          // but it is necessary for oopif frames to be discoverable in version 126 or greater
          ...(versionStr && parseInt(versionStr, 10) >= 126 ? [{}] : []),
        ] });
      } else if (message.method === 'Target.getTargetInfo' && !debuggee.tabId) {
        // most likely related with https://chromium-review.googlesource.com/c/chromium/src/+/2885888
        // See CRBrowser.connect
        result = await Promise.resolve();
      } else if (message.method === 'Target.createTarget') {
        const { browserContextId } = message.params;
        const incognito = !!browserContextId && browserContextId !== this._defaultBrowserContextId;
        const tab = await createTab({ incognito });
        const { targetId } = await this.attach(tab.id!);
        result = { targetId };
      } else if (message.method === 'Target.closeTarget') {
        const { targetId } = message.params;
        const tabId = this._targetToTab.get(targetId);
        if (tabId) {
          await chrome.tabs.remove(tabId);
          result = true;
        } else {
          result = false;
        }
      } else if (message.method === 'Target.disposeBrowserContext') {
        // do nothing...
        result = await Promise.resolve();
      } else if (message.method === 'Browser.getVersion') {
        const userAgent = navigator.userAgent;
        const [, product] = userAgent.match(/(Chrome\/[0-9\.]+)\b/) ?? [];
        result = await Promise.resolve({ product, userAgent }).then();
      } else if (message.method === 'Browser.getWindowForTarget') {
        // just don't send a window ID...
        result = await Promise.resolve({}).then();
      } else if (message.method === 'Browser.setDownloadBehavior') {
        // do nothing...
        result = await Promise.resolve();
      } else if (message.method === 'Emulation.setEmulatedMedia') {
        // avoids crashing on chrome.debugger.detach
        // see: https://github.com/ruifigueira/playwright-crx/issues/2
        result = await Promise.resolve();
      } else if (message.method === 'Storage.getCookies') {
        const { browserContextId, ...params } = message.params;
        const debuggees = this._debuggeesFromBrowserContextId(browserContextId);
        // we need to use Network.getCookies instead because Storage.getCookies always returns the non-incognito cookies
        // and iterate over all pages to get all cookies
        const results = await Promise.all(debuggees.map(debuggee => this._send(debuggee, 'Network.getCookies', params)));
        // remove duplicates
        const cookies = new Map<string, Protocol.Network.Cookie>(results.flatMap(({ cookies }) => cookies.map(cookie => [JSON.stringify(cookie), cookie])));
        result = { cookies: [...cookies.values()] };
      } else if (message.method === 'Storage.setCookies') {
        const { browserContextId, ...params } = message.params;
        const debuggees = this._debuggeesFromBrowserContextId(browserContextId);
        // apply to all pages
        await Promise.all(debuggees.map(debuggee => this._send(debuggee, 'Network.setCookies', params)));
        result = {};
      } else {
        result = await this._sendWithRecovery(tabId, debuggee, message.method as keyof Protocol.CommandParameters, { ...message.params }, message.sessionId);
      }

      this._emitMessage({
        ...message,
        result,
      });
    } catch (error) {
      this._emitMessage({
        ...message,
        error,
      });
    }
  }

  async attach(tabId: number, onBeforeEmitAttachedToTarget?: (targetInfo: Protocol.Target.TargetInfo) => any) {
    if (this._closing)
      throw new Error('Connection is closing');
    let targetInfo = this._tabToTarget.get(tabId);

    if (targetInfo)
      return targetInfo;
    const pending = this._attachPromises.get(tabId);
    if (pending)
      return await pending;

    const promise = (async () => {
      const debuggee = { tabId };
      await chrome.debugger.attach(debuggee, '1.3');
      this._progress?.log(`<chrome debugger attached to tab ${tabId}>`);
      const response = await this._send(debuggee, 'Target.getTargetInfo');
      targetInfo = response.targetInfo;

      if (!this._defaultBrowserContextId) {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.incognito)
          this._defaultBrowserContextId = targetInfo.browserContextId;
      }

      await onBeforeEmitAttachedToTarget?.(targetInfo!);

      this._emitAttachedToTarget(tabId, targetInfo);

      this._tabToTarget.set(tabId, targetInfo);
      this._targetToTab.set(targetInfo.targetId, tabId);
      return targetInfo;
    })().finally(() => this._attachPromises.delete(tabId));
    this._attachPromises.set(tabId, promise);
    return await promise;
  }

  async detach(tabOrTarget: number | string) {
    const tabId = typeof tabOrTarget === 'number' ? tabOrTarget : this._targetToTab.get(tabOrTarget);
    if (!tabId)
      return;
    const pending = this._detachPromises.get(tabId);
    if (pending)
      return await pending;

    const promise = (async () => {
      this._detachingTabs.add(tabId);
      try {
        await chrome.debugger.detach({ tabId }).catch(() => {});
        this._dropTabMappings(tabId, true);
        this._progress?.log(`<chrome debugger detached from tab ${tabId}>`);
      } finally {
        this._detachingTabs.delete(tabId);
      }
    })().finally(() => this._detachPromises.delete(tabId));
    this._detachPromises.set(tabId, promise);
    return await promise;
  }

  close() {
    if (this._closePromise)
      return;
    this._closing = true;
    this._closePromise = Promise.all([...this._tabToTarget.keys()]
        .map(tabId => this.detach(tabId)))
        .then(() => this.onclose?.());
  }

  async closeAndWait() {
    this._progress?.log(`<chrome debugger disconnecting>`);
    this._closing = true;
    this.close();
    await this._closePromise;
    chrome.debugger.onEvent.removeListener(this._onDebuggerEvent);
    chrome.debugger.onDetach.removeListener(this._onDebuggerDetach);
    chrome.tabs.onCreated.removeListener(this._onPopupCreated);
    chrome.tabs.onRemoved.removeListener(this._onTabRemoved);
    this._progress?.log(`<chrome debugger disconnected>`);
  }


  private async _send<T extends keyof Protocol.CommandParameters>(
    debuggee: DebuggerSession,
    method: T,
    commandParams?: Protocol.CommandParameters[T]
  ) {
    if (debugLogger.isEnabled('chromedebugger' as LogName))
      debugLogger.log('chromedebugger' as LogName, `SEND> ${method} #${debuggee.tabId}`);

    return await chrome.debugger.sendCommand(debuggee, method, commandParams) as
      Protocol.CommandReturnValues[T];
  }

  private _onPopupCreated = async ({ openerTabId, id }: Tab) => {
    if (!openerTabId || !id)
      return;

    if (this._tabToTarget.has(openerTabId))
      // it can fail due to "Cannot access a chrome:// URL"
      await this.attach(id).catch(() => {});
  };

  private _onTabRemoved = (tabId: number) => {
    if (!tabId)
      return;
    this._dropTabMappings(tabId, true);
  };

  private _onDebuggerDetach = async ({ tabId }: DebuggerSession, reason: string) => {
    if (!tabId)
      return;
    if (this._detachingTabs.has(tabId)) {
      this._dropTabMappings(tabId, true);
      return;
    }
    if (reason === 'canceled_by_user' || reason === 'replaced_with_devtools') {
      this._dropTabMappings(tabId, true);
      return;
    }
    const transient = this._isTransientDetachReason(reason);
    const detachedTargetId = this._dropTabMappings(tabId, !transient);
    if (this._closing || !transient)
      return;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) {
      if (detachedTargetId)
        this._emitDetachedToTarget(tabId, detachedTargetId);
      return;
    }
    await this._reconnect(tabId).catch(() => {
      if (detachedTargetId)
        this._emitDetachedToTarget(tabId, detachedTargetId);
    });
  };

  private _onDebuggerEvent = ({ tabId, sessionId }: DebuggerSession, message?: string, params?: any) => {
    if (!tabId)
      return;
    if (!sessionId)
      sessionId = this._sessionIdFor(tabId);

    if (message === 'Target.attachedToTarget') {
      const { sessionId: attachedSessionId, targetInfo } = params as Protocol.Target.attachedToTargetPayload;
      this._sessions.set(attachedSessionId, tabId);
      if (targetInfo?.targetId)
        this._sessionTargets.set(attachedSessionId, targetInfo.targetId);
      if (targetInfo)
        this._sessionTargetInfos.set(attachedSessionId, targetInfo);
      this._sessionAliases.delete(attachedSessionId);
    } else if (message === 'Target.detachedFromTarget') {
      const { sessionId: detachedSessionId } = params as Protocol.Target.detachedFromTargetPayload;
      const targetId = this._sessionTargets.get(detachedSessionId);
      if (targetId)
        this._staleSessionTargets.set(detachedSessionId, targetId);
      const targetInfo = this._sessionTargetInfos.get(detachedSessionId);
      if (targetInfo)
        this._staleSessionTargetInfos.set(detachedSessionId, targetInfo);
      this._staleSessions.set(detachedSessionId, tabId);
      this._sessions.delete(detachedSessionId);
      this._sessionTargets.delete(detachedSessionId);
      this._sessionTargetInfos.delete(detachedSessionId);
      this._cleanupAliasesForSession(detachedSessionId);
    }


    if (debugLogger.isEnabled(`chromedebugger` as LogName))
      debugLogger.log('chromedebugger' as LogName, `<RECV ${message} #${tabId}`);


    this._emitMessage({
      method: message,
      sessionId,
      params,
    });
  };

  private _emitMessage(message: ProtocolResponse) {
    if (this.onmessage)
      this.onmessage(message);
  }

  private _sessionIdFor(tabId: number): string {
    return `crx-tab-${tabId}`;
  }

  private _emitAttachedToTarget(tabId: number, targetInfo: Protocol.Target.TargetInfo) {
    const sessionId = this._sessionIdFor(tabId);
    this._emitMessage({
      method: 'Target.attachedToTarget',
      sessionId: '',
      params: {
        sessionId,
        targetInfo,
      }
    });
  }

  private _emitDetachedToTarget(tabId: number, targetId: string) {
    const sessionId = this._sessionIdFor(tabId);
    this._emitMessage({
      method: 'Target.detachedFromTarget',
      sessionId: '',
      params: {
        sessionId,
        targetId,
      }
    });
  }

  private _debuggeesFromBrowserContextId(browserContextId?: string) {
    if (!browserContextId)
      browserContextId = this._defaultBrowserContextId;
    if (!browserContextId)
      throw new Error(`No attached tab found for browserContextId ${browserContextId}`);
    return [...this._tabToTarget]
        .filter(([, targetInfo]) => targetInfo.browserContextId === browserContextId)
        .map(([tabId, targetInfo]) => ({ tabId, targetId: targetInfo?.targetId } satisfies chrome.debugger.Debuggee));
  }

  private _dropTabMappings(tabId: number, emitDetached: boolean) {
    const targetInfo = this._tabToTarget.get(tabId);
    this._tabToTarget.delete(tabId);
    if (!targetInfo)
      return;
    this._targetToTab.delete(targetInfo.targetId);
    if (emitDetached)
      this._emitDetachedToTarget(tabId, targetInfo.targetId);
    for (const [sessionId, sessionTabId] of this._sessions) {
      if (sessionTabId === tabId) {
        this._staleSessions.set(sessionId, tabId);
        const targetId = this._sessionTargets.get(sessionId);
        if (targetId)
          this._staleSessionTargets.set(sessionId, targetId);
        const targetInfo = this._sessionTargetInfos.get(sessionId);
        if (targetInfo)
          this._staleSessionTargetInfos.set(sessionId, targetInfo);
        this._sessions.delete(sessionId);
        this._sessionTargets.delete(sessionId);
        this._sessionTargetInfos.delete(sessionId);
        this._cleanupAliasesForSession(sessionId);
      }
    }
    return targetInfo.targetId;
  }

  private async _resolveDebuggee(message: ProtocolRequest) {
    const [, tabIdStr] = /crx-tab-(\d+)/.exec(message.sessionId ?? '') ?? [];
    if (tabIdStr) {
      const tabId = parseInt(tabIdStr, 10);
      await this._reconnect(tabId);
      return { tabId, debuggee: { tabId } satisfies DebuggerSession };
    }
    const originalSessionId = message.sessionId!;
    const sessionId = this._sessionAliases.get(originalSessionId) ?? originalSessionId;
    const tabId = this._sessions.get(sessionId);
    if (tabId)
      return { tabId, debuggee: { tabId, sessionId } satisfies DebuggerSession };

    const staleTabId = this._staleSessions.get(originalSessionId);
    const targetId = this._sessionTargets.get(originalSessionId) ?? this._staleSessionTargets.get(originalSessionId);
    const targetInfo = this._sessionTargetInfos.get(originalSessionId) ?? this._staleSessionTargetInfos.get(originalSessionId);
    if (staleTabId === undefined || !targetId)
      throw new Error(`Session ${originalSessionId} is no longer attached`);

    const pendingRecovery = this._sessionRecoveryPromises.get(originalSessionId);
    if (pendingRecovery) {
      const recovered = await pendingRecovery;
      return { tabId: recovered.tabId, debuggee: recovered satisfies DebuggerSession };
    }

    const recovery = (async () => {
      await this._reconnect(staleTabId);
      const { sessionId: renewedSessionId } = await this._sendWithRecovery(staleTabId, { tabId: staleTabId }, 'Target.attachToTarget', { targetId, flatten: true });
      const wasKnownSession = this._sessions.has(renewedSessionId);
      const previousSessionId = this._sessionAliases.get(originalSessionId);
      if (previousSessionId && previousSessionId !== renewedSessionId && previousSessionId !== originalSessionId) {
        this._sessions.delete(previousSessionId);
        this._sessionTargets.delete(previousSessionId);
        this._sessionTargetInfos.delete(previousSessionId);
        this._clearStaleSession(previousSessionId);
        for (const [sourceSessionId, targetSessionId] of this._sessionAliases) {
          if (targetSessionId === previousSessionId) {
            this._sessionAliases.set(sourceSessionId, renewedSessionId);
            this._clearStaleSession(sourceSessionId);
          }
        }
        this._sessionAliases.delete(previousSessionId);
      }
      this._sessions.set(renewedSessionId, staleTabId);
      this._sessionTargets.set(renewedSessionId, targetId);
      if (targetInfo)
        this._sessionTargetInfos.set(renewedSessionId, targetInfo);
      this._sessionAliases.set(originalSessionId, renewedSessionId);
      this._clearStaleSession(originalSessionId);
      this._clearStaleSession(renewedSessionId);
      if (!wasKnownSession && targetInfo) {
        this._emitMessage({
          method: 'Target.attachedToTarget',
          sessionId: '',
          params: {
            sessionId: renewedSessionId,
            targetInfo,
          } satisfies Protocol.Target.attachedToTargetPayload
        });
      }
      return { tabId: staleTabId, sessionId: renewedSessionId };
    })().finally(() => this._sessionRecoveryPromises.delete(originalSessionId));
    this._sessionRecoveryPromises.set(originalSessionId, recovery);
    const recovered = await recovery;
    return { tabId: recovered.tabId, debuggee: recovered satisfies DebuggerSession };
  }

  private async _reconnect(tabId: number) {
    if (this._closing)
      return;
    if (this._tabToTarget.has(tabId))
      return;
    const pending = this._reconnectPromises.get(tabId);
    if (pending)
      return await pending;
    const promise = (async () => {
      const retryLimit = 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= retryLimit; attempt++) {
        try {
          await this.attach(tabId);
          return;
        } catch (error) {
          lastError = error;
          if (!this._isRetryableError(error))
            throw error;
          await new Promise(resolve => setTimeout(resolve, attempt * 100));
        }
      }
      throw lastError;
    })().finally(() => this._reconnectPromises.delete(tabId));
    this._reconnectPromises.set(tabId, promise);
    return await promise;
  }

  private async _sendWithRecovery<T extends keyof Protocol.CommandParameters>(
    tabId: number,
    debuggee: DebuggerSession,
    method: T,
    commandParams?: Protocol.CommandParameters[T],
    sessionIdForRetry?: string
  ) {
    const retryLimit = 3;
    let lastError: unknown;
    let currentTabId = tabId;
    let currentDebuggee = debuggee;
    for (let attempt = 1; attempt <= retryLimit; attempt++) {
      try {
        return await this._send(currentDebuggee, method, commandParams);
      } catch (error) {
        lastError = error;
        if (this._closing || !this._isRetryableError(error))
          throw error;
        this._dropTabMappings(currentTabId, false);
        await this._reconnect(currentTabId);
        if (sessionIdForRetry && !/crx-tab-\d+/.test(sessionIdForRetry)) {
          const renewed = await this._resolveDebuggee({ sessionId: sessionIdForRetry } as ProtocolRequest);
          currentTabId = renewed.tabId;
          currentDebuggee = renewed.debuggee;
        }
        await new Promise(resolve => setTimeout(resolve, attempt * 100));
      }
    }
    throw lastError;
  }

  private _isRetryableError(error: unknown) {
    const message = String((error as any)?.message ?? error ?? '').toLowerCase();
    return [
      'debugger is not attached',
      'no tab with given id',
      'session with given id',
      'target closed',
      'inspected target navigated or closed'
    ].some(token => message.includes(token));
  }

  private _isTransientDetachReason(reason: string) {
    return ['target_closed', 'connection_closed'].includes(reason);
  }

  private _cleanupAliasesForSession(sessionId: string) {
    this._sessionAliases.delete(sessionId);
    for (const [sourceSessionId, targetSessionId] of this._sessionAliases) {
      if (targetSessionId === sessionId)
        this._sessionAliases.delete(sourceSessionId);
    }
  }

  private _clearStaleSession(sessionId: string) {
    this._staleSessions.delete(sessionId);
    this._staleSessionTargets.delete(sessionId);
    this._staleSessionTargetInfos.delete(sessionId);
  }
}
