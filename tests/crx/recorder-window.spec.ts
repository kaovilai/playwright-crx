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
import { PopupRecorderWindow } from '../../src/server/recorder/popupRecorderWindow';
import { SidepanelRecorderWindow } from '../../src/server/recorder/sidepanelRecorderWindow';

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

type MockPort = chrome.runtime.Port & {
  postedMessages: any[];
  emitMessage: (message: any) => void;
};

function createPort(name = 'recorder'): MockPort {
  const onDisconnect = new MockEvent<(port: chrome.runtime.Port) => void>();
  const onMessage = new MockEvent<(message: any, port: chrome.runtime.Port) => void>();
  let disconnected = false;

  const port = {
    name,
    onDisconnect,
    onMessage,
    postedMessages: [],
    postMessage(message: any) {
      port.postedMessages.push(message);
    },
    disconnect() {
      if (disconnected)
        return;
      disconnected = true;
      onDisconnect.emit(port as unknown as chrome.runtime.Port);
    },
    emitMessage(message: any) {
      onMessage.emit(message, port as unknown as chrome.runtime.Port);
    },
  } as unknown as MockPort;

  return port;
}

function createChromeMock() {
  const runtimeOnConnect = new MockEvent<(port: chrome.runtime.Port) => void>();
  const windowsOnRemoved = new MockEvent<(windowId: number) => void>();
  const updatedWindows: Array<{ id: number, options: { drawAttention?: boolean, focused?: boolean } }> = [];
  const removedWindowIds: number[] = [];
  const sidePanelOptions: Array<{ path: string }> = [];
  const activeWindowIds = new Set<number>();
  let lastWindowId = 100;

  const chromeMock = {
    runtime: {
      onConnect: runtimeOnConnect,
    },
    windows: {
      onRemoved: windowsOnRemoved,
      async create() {
        const wnd = { id: ++lastWindowId };
        activeWindowIds.add(wnd.id);
        return wnd;
      },
      async get(id: number) {
        if (!activeWindowIds.has(id))
          throw new Error(`Window ${id} not found`);
        return { id };
      },
      async update(id: number, options: { drawAttention?: boolean, focused?: boolean }) {
        updatedWindows.push({ id, options });
      },
      async remove(id: number) {
        removedWindowIds.push(id);
        if (activeWindowIds.delete(id))
          windowsOnRemoved.emit(id);
      },
    },
    sidePanel: {
      async setOptions(options: { path?: string }) {
        if (!options.path)
          throw new Error('Expected side panel path');
        sidePanelOptions.push(options);
      },
    },
  };

  const closeWindowExternally = (id: number) => {
    activeWindowIds.delete(id);
    windowsOnRemoved.emit(id);
  };

  return { chromeMock, runtimeOnConnect, updatedWindows, sidePanelOptions, closeWindowExternally };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test.describe.configure({ mode: 'serial' });

test.describe('recorder window regressions', () => {
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

  test('popup reconnect preserves recorder state without duplicating handlers', async () => {
    const { chromeMock, runtimeOnConnect } = createChromeMock();
    globalThis.chrome = chromeMock as typeof chrome;

    const popup = new PopupRecorderWindow('index.html');
    const events: any[] = [];
    let hides = 0;
    popup.onMessage = message => events.push(message);
    popup.hideApp = () => ++hides;

    const openPromise = popup.open();
    const port1 = createPort();
    runtimeOnConnect.emit(port1);
    await openPromise;

    expect(runtimeOnConnect.listenerCount()).toBe(0);

    port1.disconnect();
    await flush();

    expect(hides).toBe(0);
    expect(popup.isClosed()).toBe(false);
    expect(runtimeOnConnect.listenerCount()).toBe(1);

    popup.postMessage({ type: 'recorder', method: 'resetCallLogs' });

    const port2 = createPort();
    runtimeOnConnect.emit(port2);
    await flush();

    expect(port2.postedMessages).toEqual([{ type: 'recorder', method: 'resetCallLogs' }]);

    port2.emitMessage({ type: 'recorderEvent', event: 'clear', params: {} });
    expect(events).toEqual([{ type: 'recorderEvent', event: 'clear', params: {} }]);

    port2.disconnect();
    await flush();

    const port3 = createPort();
    runtimeOnConnect.emit(port3);
    await flush();
    port3.emitMessage({ type: 'recorderEvent', event: 'clear', params: {} });

    expect(events).toHaveLength(2);
    expect(runtimeOnConnect.listenerCount()).toBe(0);
  });

  test('popup close still hides recorder and focus uses created window id', async () => {
    const { chromeMock, runtimeOnConnect, updatedWindows, closeWindowExternally } = createChromeMock();
    globalThis.chrome = chromeMock as typeof chrome;

    const popup = new PopupRecorderWindow('index.html');
    let hides = 0;
    popup.hideApp = () => ++hides;

    const openPromise = popup.open();
    runtimeOnConnect.emit(createPort());
    await openPromise;

    await popup.focus();
    expect(updatedWindows).toEqual([{
      id: (popup as any)._window.id,
      options: { drawAttention: true, focused: true },
    }]);

    closeWindowExternally((popup as any)._window.id);
    await flush();

    expect(hides).toBe(1);
    expect(popup.isClosed()).toBe(true);
  });

  test('sidepanel reconnect preserves recorder state without duplicating handlers', async () => {
    const { chromeMock, runtimeOnConnect, sidePanelOptions } = createChromeMock();
    globalThis.chrome = chromeMock as typeof chrome;

    const sidepanel = new SidepanelRecorderWindow('index.html');
    const events: any[] = [];
    let hides = 0;
    sidepanel.onMessage = message => events.push(message);
    sidepanel.hideApp = () => ++hides;

    const openPromise = sidepanel.open();
    const port1 = createPort();
    runtimeOnConnect.emit(port1);
    await openPromise;

    expect(sidePanelOptions).toEqual([{ path: 'index.html' }]);

    port1.disconnect();
    await flush();

    expect(hides).toBe(0);
    expect(sidepanel.isClosed()).toBe(false);
    expect(runtimeOnConnect.listenerCount()).toBe(1);

    sidepanel.postMessage({ type: 'recorder', method: 'resetCallLogs' });

    const port2 = createPort();
    runtimeOnConnect.emit(port2);
    await flush();

    expect(port2.postedMessages).toEqual([{ type: 'recorder', method: 'resetCallLogs' }]);

    port2.emitMessage({ type: 'recorderEvent', event: 'clear', params: {} });
    expect(events).toEqual([{ type: 'recorderEvent', event: 'clear', params: {} }]);

    port2.disconnect();
    await flush();

    const port3 = createPort();
    runtimeOnConnect.emit(port3);
    await flush();
    port3.emitMessage({ type: 'recorderEvent', event: 'clear', params: {} });

    expect(events).toHaveLength(2);
    expect(runtimeOnConnect.listenerCount()).toBe(0);
  });
});
