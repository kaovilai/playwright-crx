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
import type { RuntimePortLifecycleRetryOptions } from './runtimePortLifecycle';
import { RuntimePortLifecycle } from './runtimePortLifecycle';

export class PopupRecorderWindow implements RecorderWindow {
  private _recorderUrl: string;
  private _window?: chrome.windows.Window;
  private _connection: RuntimePortLifecycle<RecorderMessage>;
  private _windowRemovedListener?: (windowId: number) => void;
  private _isClosing = false;
  private _opening = false;
  onMessage?: ({ type, event, params }: RecorderEventData) => void;
  onConnected?: (() => void) | undefined;
  hideApp?: () => any;

  constructor(recorderUrl?: string, connectionOptions?: RuntimePortLifecycleRetryOptions) {
    this._recorderUrl = recorderUrl ?? 'index.html';
    this._connection = new RuntimePortLifecycle<RecorderMessage>({
      name: 'popup recorder connection',
      canReconnect: () => !this._isClosing && (this._opening || !!this._window?.id),
      getMessageListener: () => this.onMessage,
      onConnected: () => this.onConnected?.(),
      onConnectionExhausted: () => {
        if (!this._isClosing && this._window)
          this.close().then(() => this.hideApp?.()).catch(() => {});
      },
      ...connectionOptions
    });
  }

  isClosed() {
    return !this._window;
  }

  postMessage(msg: RecorderMessage) {
    this._connection.postMessage(msg);
  }

  async open() {
    if (this._window)
      return;
    this._isClosing = false;
    this._opening = true;
    if (!this._windowRemovedListener) {
      this._windowRemovedListener = windowId => {
        if (this._window?.id !== windowId || this._isClosing)
          return;
        this.close().then(() => this.hideApp?.()).catch(() => {});
      };
      chrome.windows.onRemoved.addListener(this._windowRemovedListener);
    }
    try {
      const [wnd] = await Promise.all([
        chrome.windows.create({ type: 'popup', url: this._recorderUrl }),
        this._connection.open(),
      ]);
      this._window = wnd;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this._opening = false;
    }
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
      await this._connection.close({ disconnect: true });
      this._window = undefined;
      if (this._windowRemovedListener) {
        chrome.windows.onRemoved.removeListener(this._windowRemovedListener);
        this._windowRemovedListener = undefined;
      }
    } finally {
      this._isClosing = false;
    }
  }
}
