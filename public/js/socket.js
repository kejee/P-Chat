/**
 * P-Chat WebSocket Client Controller
 * Supports Text JSON + High Performance Native Binary ArrayBuffer
 */

class PSocketClient {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.pingTimer = null;
    this.pongTimeoutTimer = null;
    this.reconnectTimer = null;
    this.isConnected = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;

    // Universal wake & focus detection across PC, iOS Safari, Android Chrome, Mac & Windows
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.checkConnectionOrReconnect();
      }
    });

    window.addEventListener('focus', () => {
      this.checkConnectionOrReconnect();
    });

    window.addEventListener('online', () => {
      this.reconnect();
    });
  }

  checkConnectionOrReconnect() {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.reconnect();
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.isConnected = true;
        return resolve();
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (e) {
        this.scheduleAutoReconnect();
        return reject(e);
      }

      this.ws.binaryType = 'arraybuffer'; // Native Binary Mode

      this.ws.onopen = () => {
        this.isConnected = true;
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.startHeartbeat();
        this.emit('connected');
        resolve();
      };

      this.ws.onmessage = async (event) => {
        this.resetPongTimeout();
        let rawData = event.data;
        if (rawData instanceof Blob) {
          try {
            rawData = await rawData.arrayBuffer();
          } catch (e) {
            console.error('[PSocket] Failed to convert Blob to ArrayBuffer:', e);
          }
        }

        if (rawData instanceof ArrayBuffer) {
          // Native Binary Frame (Single Packet or 256KB Chunk Stream)
          this.emit('binary_message', rawData);
        } else {
          try {
            const data = JSON.parse(rawData);
            if (data.type === 'pong') {
              return; // Handled
            }
            this.emit(data.type, data.payload || data);
          } catch (e) {
            console.error('[PSocket] Failed to parse message:', e);
          }
        }
      };

      this.ws.onclose = () => {
        this.handleDisconnect();
      };

      this.ws.onerror = (err) => {
        console.error('[PSocket] Connection error:', err);
        this.handleDisconnect();
        reject(err);
      };
    });
  }

  handleDisconnect() {
    this.isConnected = false;
    this.stopHeartbeat();
    this.emit('disconnected');
    this.scheduleAutoReconnect();
  }

  scheduleAutoReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 8000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  async reconnect() {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    try {
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        try { this.ws.close(); } catch (e) {}
        this.ws = null;
      }
      await this.connect();
    } catch (e) {
      console.warn('[PSocket] Reconnect attempt failed:', e);
    } finally {
      this.isReconnecting = false;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
        // If no response within 8s -> treat as dead connection and reconnect
        this.pongTimeoutTimer = setTimeout(() => {
          console.warn('[PSocket] Heartbeat timeout, restarting socket connection...');
          this.reconnect();
        }, 8000);
      }
    }, 10000);
  }

  resetPongTimeout() {
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.resetPongTimeout();
  }

  send(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    } else {
      console.warn('[PSocket] Cannot send message, WebSocket not connected.');
    }
  }

  sendBinary(arrayBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(arrayBuffer);
    } else {
      console.warn('[PSocket] Cannot send binary message, WebSocket not connected.');
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  off(event, callback) {
    if (!this.listeners.has(event)) return;
    const list = this.listeners.get(event).filter(cb => cb !== callback);
    this.listeners.set(event, list);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      for (const cb of this.listeners.get(event)) {
        cb(data);
      }
    }
  }
}

window.PSocket = new PSocketClient();
