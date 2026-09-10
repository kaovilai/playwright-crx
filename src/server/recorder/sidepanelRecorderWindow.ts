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

export class SidepanelRecorderWindow implements RecorderWindow {
  private _recorderUrl: string;
  private _port?: chrome.runtime.Port;
  private _portPromise?: Promise<chrome.runtime.Port>;
  private _connectListener?: (port: chrome.runtime.Port) => void;
  private _closed = true;
  onMessage?: (({ type, event, params }: RecorderEventData) => void) | undefined;
  hideApp?: (() => any) | undefined;

  constructor(recorderUrl?: string) {
    this._recorderUrl = recorderUrl ?? 'index.html';
    this._portPromise = this._waitConnect();
  }

  isClosed(): boolean {
    return this._closed;
  }

  postMessage(msg: RecorderMessage) {
    this._portPromise?.then(port => port.postMessage({ ...msg })).catch(() => {});
  }

  async open() {
    this._closed = false;
    await chrome.sidePanel.setOptions({ path: this._recorderUrl });
    this._portPromise = this._portPromise ?? this._waitConnect();
    await this._portPromise;
  }

  async focus() {
  }

  async close() {
    if (this._closed)
      return;
    this._closed = true;
    this._cleanupPort(true);
    this._portPromise = undefined;
    if (this._connectListener) {
      chrome.runtime.onConnect.removeListener(this._connectListener);
      this._connectListener = undefined;
    }
  }

  private _waitConnect(): Promise<chrome.runtime.Port> {
    return new Promise(resolve => {
      this._connectListener = (port: chrome.runtime.Port) => {
        chrome.runtime.onConnect.removeListener(this._connectListener!);
        this._connectListener = undefined;
        this._bindPort(port);
        if (this.onMessage)
          port.onMessage.addListener(this.onMessage);
        resolve(port);
      };
      chrome.runtime.onConnect.addListener(this._connectListener);
    });
  }

  private _bindPort(port: chrome.runtime.Port) {
    this._cleanupPort(false);
    this._port = port;
    port.onDisconnect.addListener(this._onDisconnect);
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
    if (!this._closed)
      this._portPromise = this._waitConnect();
  };
}
