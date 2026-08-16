/**
 * P-Chat WebSocket Client Controller
 * Supports Text JSON + High Performance Native Binary ArrayBuffer
 */

class PSocketClient {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.pingTimer = null;
    this.isConnected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;

      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer'; // Native Binary Mode

      this.ws.onopen = () => {
        this.isConnected = true;
        this.startHeartbeat();
        this.emit('connected');
        resolve();
      };

      this.ws.onmessage = async (event) => {
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
            this.emit(data.type, data.payload || data);
          } catch (e) {
            console.error('[PSocket] Failed to parse message:', e);
          }
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.stopHeartbeat();
        this.emit('disconnected');
      };

      this.ws.onerror = (err) => {
        console.error('[PSocket] Connection error:', err);
        reject(err);
      };
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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
