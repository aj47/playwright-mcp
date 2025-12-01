/**
 * Copyright (c) Microsoft Corporation.
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

import { RelayConnection, debugLog } from './relayConnection';

type PageMessage = {
  type: 'connectToMCPRelay';
  mcpRelayUrl: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  tabId?: number;
  windowId?: number;
  mcpRelayUrl: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'getAllConnections';
} | {
  type: 'disconnect';
  tabId?: number; // Optional: disconnect specific tab, or all if not provided
};

class TabShareExtension {
  // Map of tabId -> active connection (supports multiple simultaneous tabs)
  private _activeConnections = new Map<number, RelayConnection>();
  // Legacy: for backwards compatibility, track the most recently connected tab
  private _lastConnectedTabId: number | null = null;
  private _pendingTabSelection = new Map<number, { connection: RelayConnection, timerId?: number }>();

  constructor() {
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
    chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectToMCPRelay':
        this._connectToRelay(sender.tab!.id!, message.mcpRelayUrl).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'getTabs':
        this._getTabs().then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab':
        const tabId = message.tabId || sender.tab?.id!;
        const windowId = message.windowId || sender.tab?.windowId!;
        this._connectTab(sender.tab!.id!, tabId, windowId, message.mcpRelayUrl!).then(
            () => sendResponse({ success: true, tabId }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      case 'getConnectionStatus':
        // Legacy: return the last connected tab for backwards compatibility
        sendResponse({
          connectedTabId: this._lastConnectedTabId,
          // Also include all connected tabs
          connectedTabIds: Array.from(this._activeConnections.keys())
        });
        return false;
      case 'getAllConnections':
        // New: return all active connections
        sendResponse({
          connections: Array.from(this._activeConnections.keys()).map(tabId => ({ tabId }))
        });
        return false;
      case 'disconnect':
        this._disconnect(message.tabId).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
    }
    return false;
  }

  private async _connectToRelay(selectorTabId: number, mcpRelayUrl: string): Promise<void> {
    try {
      debugLog(`Connecting to relay at ${mcpRelayUrl}`);
      const socket = new WebSocket(mcpRelayUrl);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      const connection = new RelayConnection(socket);
      connection.onclose = () => {
        debugLog('Connection closed');
        this._pendingTabSelection.delete(selectorTabId);
        // TODO: show error in the selector tab?
      };
      this._pendingTabSelection.set(selectorTabId, { connection });
      debugLog(`Connected to MCP relay`);
    } catch (error: any) {
      const message = `Failed to connect to MCP relay: ${error.message}`;
      debugLog(message);
      throw new Error(message);
    }
  }

  private async _connectTab(selectorTabId: number, tabId: number, windowId: number, mcpRelayUrl: string): Promise<void> {
    try {
      debugLog(`Connecting tab ${tabId} to relay at ${mcpRelayUrl}`);

      // Check if this tab already has an active connection
      const existingConnection = this._activeConnections.get(tabId);
      if (existingConnection) {
        try {
          existingConnection.close('New connection requested for this tab');
        } catch (error: any) {
          debugLog(`Error closing existing connection for tab ${tabId}:`, error);
        }
        this._activeConnections.delete(tabId);
        await this._updateBadge(tabId, { text: '' });
      }

      const pendingConnection = this._pendingTabSelection.get(selectorTabId)?.connection;
      if (!pendingConnection)
        throw new Error('No active MCP relay connection');
      this._pendingTabSelection.delete(selectorTabId);

      pendingConnection.setTabId(tabId);
      pendingConnection.onclose = () => {
        debugLog(`MCP connection closed for tab ${tabId}`);
        this._activeConnections.delete(tabId);
        void this._removeConnectedTab(tabId);
      };

      // Add to active connections map
      this._activeConnections.set(tabId, pendingConnection);
      this._lastConnectedTabId = tabId;

      await Promise.all([
        this._addConnectedTab(tabId),
        chrome.tabs.update(tabId, { active: true }),
        chrome.windows.update(windowId, { focused: true }),
      ]);
      debugLog(`Connected to MCP bridge for tab ${tabId}. Total active connections: ${this._activeConnections.size}`);
    } catch (error: any) {
      await this._removeConnectedTab(tabId);
      debugLog(`Failed to connect tab ${tabId}:`, error.message);
      throw error;
    }
  }

  private async _addConnectedTab(tabId: number): Promise<void> {
    await this._updateBadge(tabId, { text: '✓', color: '#4CAF50', title: 'Connected to MCP client' });
  }

  private async _removeConnectedTab(tabId: number): Promise<void> {
    await this._updateBadge(tabId, { text: '' });
    // Update lastConnectedTabId if this was the last connected tab
    if (this._lastConnectedTabId === tabId) {
      const remainingTabs = Array.from(this._activeConnections.keys());
      this._lastConnectedTabId = remainingTabs.length > 0 ? remainingTabs[remainingTabs.length - 1] : null;
    }
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setTitle({ tabId, title: title || '' });
      if (color)
        await chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  private async _onTabRemoved(tabId: number): Promise<void> {
    // Check pending connections first
    const pendingConnection = this._pendingTabSelection.get(tabId)?.connection;
    if (pendingConnection) {
      this._pendingTabSelection.delete(tabId);
      pendingConnection.close('Browser tab closed');
      return;
    }

    // Check active connections
    const activeConnection = this._activeConnections.get(tabId);
    if (activeConnection) {
      activeConnection.close('Browser tab closed');
      this._activeConnections.delete(tabId);
      await this._removeConnectedTab(tabId);
    }
  }

  private _onTabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
    for (const [tabId, pending] of this._pendingTabSelection) {
      if (tabId === activeInfo.tabId) {
        if (pending.timerId) {
          clearTimeout(pending.timerId);
          pending.timerId = undefined;
        }
        continue;
      }
      if (!pending.timerId) {
        pending.timerId = setTimeout(() => {
          const existed = this._pendingTabSelection.delete(tabId);
          if (existed) {
            pending.connection.close('Tab has been inactive for 5 seconds');
            chrome.tabs.sendMessage(tabId, { type: 'connectionTimeout' });
          }
        }, 5000);
        return;
      }
    }
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) {
    // Update badge for any connected tab
    if (this._activeConnections.has(tabId))
      void this._addConnectedTab(tabId);
  }

  private async _getTabs(): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => tab.url && !['chrome:', 'edge:', 'devtools:'].some(scheme => tab.url!.startsWith(scheme)));
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }

  private async _disconnect(tabId?: number): Promise<void> {
    if (tabId !== undefined) {
      // Disconnect specific tab
      const connection = this._activeConnections.get(tabId);
      if (connection) {
        connection.close('User disconnected');
        this._activeConnections.delete(tabId);
        await this._removeConnectedTab(tabId);
      }
    } else {
      // Disconnect all tabs
      for (const [connectedTabId, connection] of this._activeConnections) {
        connection.close('User disconnected');
        await this._removeConnectedTab(connectedTabId);
      }
      this._activeConnections.clear();
      this._lastConnectedTabId = null;
    }
  }
}

new TabShareExtension();
