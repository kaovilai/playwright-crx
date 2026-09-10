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

import type { RecorderEventData, RecorderMessage, RecorderWindow } from './crxRecorderApp';

export class PopupRecorderWindow implements RecorderWindow {
  private _recorderUrl: string;
  private _window?: chrome.windows.Window;
  private _port?: chrome.runtime.Port;
  private _portPromise?: Promise<chrome.runtime.Port>;
  private _connectListener?: (port: chrome.runtime.Port) => void;
  private _reconnectPending = false;
  private _windowRemovedListener?: (windowId: number) => void;
  private _isClosing = false;
  onMessage?: ({ type, event, params }: RecorderEventData) => void;
  hideApp?: () => any;

  constructor(recorderUrl?: string) {
    this._recorderUrl = recorderUrl ?? 'index.html';
  }

  isClosed() {
    return !this._window;
  }

  postMessage(msg: RecorderMessage) {
    this._portPromise?.then(port => port.postMessage({ ...msg })).catch(() => {});
  }

  async open() {
    if (this._window)
      return;
    this._portPromise = this._portPromise ?? this._waitForConnect();
    if (!this._windowRemovedListener) {
      this._windowRemovedListener = windowId => {
        if (this._window?.id !== windowId || this._isClosing)
          return;
        this.close().then(() => this.hideApp?.()).catch(() => {});
      };
      chrome.windows.onRemoved.addListener(this._windowRemovedListener);
    }
    const [wnd] = await Promise.all([
      chrome.windows.create({ type: 'popup', url: this._recorderUrl }),
      this._portPromise,
    ]);
    this._window = wnd;
  }

  async focus() {
    if (this._window?.id)
      await chrome.windows.update(this._window.id, { drawAttention: true, focused: true });
  }

  async close() {
    if (this._isClosing)
      return;

    this._isClosing = true;
    try {
      if (this._window?.id)
        await chrome.windows.remove(this._window.id).catch(() => {});
      this._cleanupPort(true);
      this._window = undefined;
      this._portPromise = undefined;
      if (this._connectListener) {
        chrome.runtime.onConnect.removeListener(this._connectListener);
        this._connectListener = undefined;
      }
      if (this._windowRemovedListener) {
        chrome.windows.onRemoved.removeListener(this._windowRemovedListener);
        this._windowRemovedListener = undefined;
      }
    } finally {
      this._isClosing = false;
    }
  }

  private _waitForConnect(): Promise<chrome.runtime.Port> {
    return new Promise(resolve => {
      this._connectListener = port => {
        chrome.runtime.onConnect.removeListener(this._connectListener!);
        this._connectListener = undefined;
        this._bindPort(port);
        resolve(port);
      };
      chrome.runtime.onConnect.addListener(this._connectListener);
    });
  }

  private _bindPort(port: chrome.runtime.Port) {
    this._cleanupPort(false);
    this._port = port;
    port.onDisconnect.addListener(this._onDisconnect);
    if (this.onMessage)
      port.onMessage.addListener(this.onMessage);
  }

  private _cleanupPort(disconnect: boolean) {
    if (!this._port)
      return;
    this._port.onDisconnect.removeListener(this._onDisconnect);
    if (this.onMessage)
      this._port.onMessage.removeListener(this.onMessage);
    if (disconnect)
      this._port.disconnect();
    this._port = undefined;
  }

  private _onDisconnect = () => {
    this._cleanupPort(false);
    this._portPromise = undefined;
    if (this._isClosing || !this._window?.id || this._reconnectPending || this._connectListener)
      return;
    const windowId = this._window.id;
    this._reconnectPending = true;
    chrome.windows.get(windowId)
        .then(() => {
          if (!this._isClosing && this._window?.id === windowId && !this._connectListener)
            this._portPromise = this._waitForConnect();
        })
        .catch(() => {})
        .finally(() => {
          this._reconnectPending = false;
        });
  };
}
