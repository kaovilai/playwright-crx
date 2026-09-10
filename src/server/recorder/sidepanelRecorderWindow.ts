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

export class SidepanelRecorderWindow implements RecorderWindow {
  private _recorderUrl: string;
  private _connection: RuntimePortLifecycle<RecorderMessage>;
  private _closed = true;
  onMessage?: (({ type, event, params }: RecorderEventData) => void) | undefined;
  onConnected?: (() => void) | undefined;
  hideApp?: (() => any) | undefined;

  constructor(recorderUrl?: string, connectionOptions?: RuntimePortLifecycleRetryOptions) {
    this._recorderUrl = recorderUrl ?? 'index.html';
    this._connection = new RuntimePortLifecycle<RecorderMessage>({
      name: 'sidepanel recorder connection',
      canReconnect: () => !this._closed,
      acceptPort: port => port.name === 'recorder',
      getMessageListener: () => this.onMessage,
      onConnected: () => this.onConnected?.(),
      onConnectionExhausted: () => {
        if (!this._closed)
          this.close().catch(() => {}).finally(() => this.hideApp?.());
        else
          this.hideApp?.();
      },
      ...connectionOptions
    });
  }

  isClosed(): boolean {
    return this._closed;
  }

  postMessage(msg: RecorderMessage) {
    this._connection.postMessage(msg);
  }

  async open() {
    this._closed = false;
    try {
      await Promise.all([
        chrome.sidePanel.setOptions({ path: this._recorderUrl }),
        this._connection.open(),
      ]);
    } catch (error) {
      this._closed = true;
      await this._connection.close({ disconnect: true });
      throw error;
    }
  }

  async focus() {
  }

  async close() {
    if (this._closed)
      return;
    this._closed = true;
    await this._connection.close({ disconnect: true });
  }
}
