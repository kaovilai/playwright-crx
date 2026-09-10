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

import { expect, test } from '@playwright/test';
import { CrxTransport } from '../../src/server/transport/crxTransport';

class MockEvent<T extends (...args: any[]) => void> {
  private _listeners = new Set<T>();

  addListener(listener: T) {
    this._listeners.add(listener);
  }

  removeListener(listener: T) {
    this._listeners.delete(listener);
  }

  emit(...args: Parameters<T>) {
    for (const listener of [...this._listeners])
      listener(...args);
  }

  listenerCount() {
    return this._listeners.size;
  }
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

test.describe('transport reconnect', () => {
  let originalChrome: typeof globalThis.chrome | undefined;

  test.beforeEach(() => {
    originalChrome = globalThis.chrome;
  });

  test.afterEach(() => {
    if (originalChrome)
      globalThis.chrome = originalChrome;
    else
      delete (globalThis as any).chrome;
  });

  test('attach is idempotent under concurrent calls', async () => {
    const debuggerOnEvent = new MockEvent<(debuggee: any, method: string, params: any) => void>();
    const debuggerOnDetach = new MockEvent<(debuggee: any, reason: string) => void>();
    const tabsOnRemoved = new MockEvent<(tabId: number) => void>();
    const tabsOnCreated = new MockEvent<(tab: chrome.tabs.Tab) => void>();
    let attachCalls = 0;

    globalThis.chrome = {
      debugger: {
        onEvent: debuggerOnEvent,
        onDetach: debuggerOnDetach,
        async attach() {
          attachCalls++;
        },
        async detach() {},
        async sendCommand(_: any, method: string) {
          if (method === 'Target.getTargetInfo') {
            return {
              targetInfo: {
                targetId: 'target-1',
                browserContextId: 'context-1',
              }
            };
          }
          return {};
        }
      },
      tabs: {
        onRemoved: tabsOnRemoved,
        onCreated: tabsOnCreated,
        async get() {
          return { incognito: false };
        },
      },
    } as unknown as typeof chrome;

    const transport = new CrxTransport();
    const [t1, t2] = await Promise.all([transport.attach(1), transport.attach(1)]);
    expect(t1.targetId).toBe(t2.targetId);
    expect(attachCalls).toBe(1);
  });

  test('send retries through transient debugger disconnect', async () => {
    const debuggerOnEvent = new MockEvent<(debuggee: any, method: string, params: any) => void>();
    const debuggerOnDetach = new MockEvent<(debuggee: any, reason: string) => void>();
    const tabsOnRemoved = new MockEvent<(tabId: number) => void>();
    const tabsOnCreated = new MockEvent<(tab: chrome.tabs.Tab) => void>();
    let attachCalls = 0;
    let evalCalls = 0;

    globalThis.chrome = {
      debugger: {
        onEvent: debuggerOnEvent,
        onDetach: debuggerOnDetach,
        async attach() {
          attachCalls++;
        },
        async detach() {},
        async sendCommand(_: any, method: string) {
          if (method === 'Target.getTargetInfo') {
            return {
              targetInfo: {
                targetId: 'target-1',
                browserContextId: 'context-1',
              }
            };
          }
          if (method === 'Runtime.evaluate') {
            evalCalls++;
            if (evalCalls === 1)
              throw new Error('Debugger is not attached to tab with id: 1.');
            return { result: { type: 'number', value: 42 } };
          }
          return {};
        }
      },
      tabs: {
        onRemoved: tabsOnRemoved,
        onCreated: tabsOnCreated,
        async get() {
          return { incognito: false };
        },
      },
    } as unknown as typeof chrome;

    const transport = new CrxTransport();
    const messages: any[] = [];
    transport.onmessage = message => messages.push(message);

    await transport.attach(1);
    await transport.send({ id: 7, method: 'Runtime.evaluate', params: { expression: '21*2' }, sessionId: 'crx-tab-1' } as any);

    expect(attachCalls).toBe(2);
    expect(messages).toHaveLength(3);
    expect(messages[messages.length - 1].result?.result?.value).toBe(42);
  });

  test('detached tabs reconnect and close removes detach listener', async () => {
    const debuggerOnEvent = new MockEvent<(debuggee: any, method: string, params: any) => void>();
    const debuggerOnDetach = new MockEvent<(debuggee: any, reason: string) => void>();
    const tabsOnRemoved = new MockEvent<(tabId: number) => void>();
    const tabsOnCreated = new MockEvent<(tab: chrome.tabs.Tab) => void>();
    let attachCalls = 0;
    let detachCalls = 0;

    globalThis.chrome = {
      debugger: {
        onEvent: debuggerOnEvent,
        onDetach: debuggerOnDetach,
        async attach() {
          attachCalls++;
        },
        async detach() {
          detachCalls++;
        },
        async sendCommand(_: any, method: string) {
          if (method === 'Target.getTargetInfo') {
            return {
              targetInfo: {
                targetId: `target-${attachCalls}`,
                browserContextId: 'context-1',
              }
            };
          }
          return {};
        }
      },
      tabs: {
        onRemoved: tabsOnRemoved,
        onCreated: tabsOnCreated,
        async get() {
          return { incognito: false };
        },
      },
    } as unknown as typeof chrome;

    const transport = new CrxTransport();
    await transport.attach(1);
    debuggerOnDetach.emit({ tabId: 1 }, 'target_closed');
    await flush();
    await flush();

    expect(attachCalls).toBe(2);

    await transport.closeAndWait();
    expect(detachCalls).toBeGreaterThanOrEqual(1);
    expect(debuggerOnDetach.listenerCount()).toBe(0);
  });

  test('stale child sessions are renewed after reconnect', async () => {
    const debuggerOnEvent = new MockEvent<(debuggee: any, method: string, params: any) => void>();
    const debuggerOnDetach = new MockEvent<(debuggee: any, reason: string) => void>();
    const tabsOnRemoved = new MockEvent<(tabId: number) => void>();
    const tabsOnCreated = new MockEvent<(tab: chrome.tabs.Tab) => void>();
    let attachCalls = 0;
    let attachToTargetCalls = 0;

    globalThis.chrome = {
      debugger: {
        onEvent: debuggerOnEvent,
        onDetach: debuggerOnDetach,
        async attach() {
          attachCalls++;
        },
        async detach() {},
        async sendCommand(debuggee: any, method: string, params: any) {
          if (method === 'Target.getTargetInfo') {
            return {
              targetInfo: {
                targetId: `target-${attachCalls}`,
                browserContextId: 'context-1',
              }
            };
          }
          if (method === 'Target.attachToTarget') {
            attachToTargetCalls++;
            expect(params.targetId).toBe('child-target');
            return { sessionId: 'child-2' };
          }
          if (method === 'Runtime.evaluate') {
            expect(debuggee.sessionId).toBe('child-2');
            return { result: { type: 'number', value: 7 } };
          }
          return {};
        }
      },
      tabs: {
        onRemoved: tabsOnRemoved,
        onCreated: tabsOnCreated,
        async get() {
          return { incognito: false };
        },
      },
    } as unknown as typeof chrome;

    const transport = new CrxTransport();
    const messages: any[] = [];
    transport.onmessage = message => messages.push(message);

    await transport.attach(1);
    debuggerOnEvent.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'child-1', targetInfo: { targetId: 'child-target' } });
    debuggerOnDetach.emit({ tabId: 1 }, 'target_closed');
    await flush();
    await flush();

    await transport.send({ id: 8, method: 'Runtime.evaluate', params: { expression: '3+4' }, sessionId: 'child-1' } as any);
    expect(attachCalls).toBe(2);
    expect(attachToTargetCalls).toBe(1);
    expect(messages[messages.length - 1].result?.result?.value).toBe(7);
  });
});
