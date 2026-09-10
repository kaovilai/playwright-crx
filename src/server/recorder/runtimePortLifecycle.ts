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

type RuntimePortLifecycleOptions = {
  readonly name: string;
  readonly canReconnect: () => boolean;
  readonly acceptPort?: (port: chrome.runtime.Port) => boolean;
  readonly getMessageListener: () => ((message: any) => void) | undefined;
  readonly onConnected?: () => void;
  readonly onConnectionExhausted?: (error: Error) => void;
  readonly maxConnectAttempts?: number;
  readonly connectTimeoutMs?: number;
  readonly retryDelayMs?: number;
};

export type RuntimePortLifecycleRetryOptions = Pick<RuntimePortLifecycleOptions, 'maxConnectAttempts' | 'connectTimeoutMs' | 'retryDelayMs'>;

export class RuntimePortLifecycle<TMessage> {
  private _options: RuntimePortLifecycleOptions;
  private _port?: chrome.runtime.Port;
  private _active = false;
  private _queuedMessages: TMessage[] = [];
  private _connectingPromise?: Promise<chrome.runtime.Port>;
  private _connectListener?: (port: chrome.runtime.Port) => void;
  private _boundMessageListener?: (message: any) => void;

  constructor(options: RuntimePortLifecycleOptions) {
    this._options = options;
  }

  postMessage(message: TMessage) {
    if (!this._active)
      return;
    if (!this._port) {
      this._queuedMessages.push(message);
      this._ensureConnected().catch(() => {});
      return;
    }
    this._postToPort(this._port, message);
  }

  async open() {
    this._active = true;
    await this._ensureConnected();
  }

  async close({ disconnect }: { disconnect: boolean }) {
    this._active = false;
    this._queuedMessages = [];
    this._cleanupPort(disconnect);
    if (this._connectListener) {
      chrome.runtime.onConnect.removeListener(this._connectListener);
      this._connectListener = undefined;
    }
    this._connectingPromise = undefined;
  }

  private async _ensureConnected() {
    if (this._port)
      return this._port;
    if (this._connectingPromise)
      return await this._connectingPromise;
    this._connectingPromise = this._connectWithRetry().finally(() => {
      this._connectingPromise = undefined;
    });
    return await this._connectingPromise;
  }

  private async _connectWithRetry() {
    const maxAttempts = this._options.maxConnectAttempts ?? 3;
    const connectTimeoutMs = this._options.connectTimeoutMs ?? 5_000;
    const retryDelayMs = this._options.retryDelayMs ?? 250;

    let attempt = 0;
    let lastError: Error = new Error(`${this._options.name}: failed to connect`);
    while (this._active && this._options.canReconnect()) {
      attempt++;
      try {
        return await this._waitForConnect(connectTimeoutMs);
      } catch (error) {
        lastError = this._toError(error);
        if (attempt >= maxAttempts)
          break;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
    this._options.onConnectionExhausted?.(lastError);
    throw new Error(`${this._options.name}: ${lastError.message}`);
  }

  private _waitForConnect(connectTimeoutMs: number): Promise<chrome.runtime.Port> {
    if (!this._active || !this._options.canReconnect())
      return Promise.reject(new Error('connection closed'));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        if (this._connectListener) {
          chrome.runtime.onConnect.removeListener(this._connectListener);
          this._connectListener = undefined;
        }
      };
      this._connectListener = port => {
        if (this._options.acceptPort && !this._options.acceptPort(port))
          return;
        cleanup();
        this._bindPort(port);
        this._options.onConnected?.();
        resolve(port);
      };
      chrome.runtime.onConnect.addListener(this._connectListener);
    });
  }

  private _bindPort(port: chrome.runtime.Port) {
    this._cleanupPort(false);
    this._port = port;
    this._boundMessageListener = this._options.getMessageListener();
    if (this._boundMessageListener)
      port.onMessage.addListener(this._boundMessageListener);
    port.onDisconnect.addListener(this._onDisconnect);
    this._flushQueue();
  }

  private _flushQueue() {
    const port = this._port;
    if (!port || !this._queuedMessages.length)
      return;
    const pending = this._queuedMessages;
    this._queuedMessages = [];
    for (const message of pending)
      this._postToPort(port, message);
  }

  private _postToPort(port: chrome.runtime.Port, message: TMessage) {
    try {
      port.postMessage({ ...message });
    } catch (error) {
      this._queuedMessages.push(message);
      this._onDisconnect(this._toError(error));
    }
  }

  private _cleanupPort(disconnect: boolean) {
    if (!this._port)
      return;
    this._port.onDisconnect.removeListener(this._onDisconnect);
    if (this._boundMessageListener)
      this._port.onMessage.removeListener(this._boundMessageListener);
    this._boundMessageListener = undefined;
    if (disconnect)
      this._port.disconnect();
    this._port = undefined;
  }

  private _onDisconnect = () => {
    this._cleanupPort(false);
    if (!this._active || !this._options.canReconnect())
      return;
    this._ensureConnected().catch(() => {});
  };

  private _toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
