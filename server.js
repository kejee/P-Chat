/**
 * P-Chat (Privacy Chat) - Lightweight Zero-Knowledge Relay Server
 * 
 * High performance, zero-disk footprint, RAM-only state.
 * End-to-End Encryption blind relay with ephemeral burn-after-reading arbitration.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Data Structures (Zero Disk Storage)
const rooms = new Map(); // roomId -> RoomObject
const ipRateLimits = new Map(); // ip -> { failCount, resetTime }

// Helper to get client IP
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

// IP Rate Limiting helper (Anti-bruteforce)
function checkRateLimit(ip) {
  const now = Date.now();
  const record = ipRateLimits.get(ip);
  if (!record) return true;
  if (now > record.resetTime) {
    ipRateLimits.delete(ip);
    return true;
  }
  return record.failCount < 10; // Max 10 failed attempts per 5 minutes
}

function recordAuthFailure(ip) {
  const now = Date.now();
  const record = ipRateLimits.get(ip) || { failCount: 0, resetTime: now + 5 * 60 * 1000 };
  record.failCount += 1;
  ipRateLimits.set(ip, record);
}

// REST Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), activeRooms: rooms.size });
});

app.get('/api/my-ip', (req, res) => {
  res.json({ ip: getClientIp(req) });
});

app.get('/api/rooms', (req, res) => {
  const publicRooms = [];
  const now = Date.now();

  for (const [id, room] of rooms.entries()) {
    if (room.isPublic) {
      publicRooms.push({
        id: room.id,
        name: room.name,
        hasPassword: Boolean(room.passHash),
        memberCount: room.clients.size,
        createdAt: room.createdAt,
        destroyAt: room.destroyAt,
        remainingMs: Math.max(0, room.destroyAt - now)
      });
    }
  }

  res.json({ rooms: publicRooms });
});

// Clean and destroy a room permanently
function destroyRoom(roomId, reason = 'expired') {
  const room = rooms.get(roomId);
  if (!room) return;

  // Clear timers
  if (room.destroyTimer) clearTimeout(room.destroyTimer);
  for (const msg of room.burnMessages.values()) {
    if (msg.timer) clearTimeout(msg.timer);
  }

  // Notify all connected clients
  const payload = JSON.stringify({
    type: 'room_destroyed',
    reason: reason,
    timestamp: Date.now()
  });

  for (const client of room.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
        client.close(1000, `Room destroyed: ${reason}`);
      } catch (e) {
        // ignore
      }
    }
  }

  room.clients.clear();
  room.burnMessages.clear();
  rooms.delete(roomId);
  console.log(`[P-Chat] Room ${roomId} permanently destroyed. Reason: ${reason}`);
}

// WebSocket Connection & Relay Protocol
wss.on('connection', (ws, req) => {
  const clientIp = getClientIp(req);
  ws.clientIp = clientIp;
  ws.roomId = null;
  ws.isAdmin = false;
  ws.alias = 'Anonymous';

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return ws.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON' }));
    }

    const { type, payload } = msg;

    switch (type) {
      // 1. Create Room
      case 'create_room': {
        const { name, passHash, isPublic, allowedIps, destroyDurationMinutes, creatorAlias } = payload;

        if (!name || typeof name !== 'string') {
          return ws.send(JSON.stringify({ type: 'error', code: 'INVALID_ROOM_NAME' }));
        }

        const roomId = crypto.randomBytes(6).toString('hex'); // 12-char random id
        const adminToken = crypto.randomBytes(16).toString('hex');
        const now = Date.now();
        const durationMs = (Math.max(1, parseInt(destroyDurationMinutes) || 60)) * 60 * 1000;
        const destroyAt = now + durationMs;

        // If no password, room MUST be public
        const effectiveIsPublic = !passHash ? true : Boolean(isPublic);

        const newRoom = {
          id: roomId,
          name: name.trim().slice(0, 32),
          passHash: passHash || null,
          isPublic: effectiveIsPublic,
          allowedIps: Array.isArray(allowedIps) ? allowedIps.filter(Boolean) : [],
          adminToken: adminToken,
          createdAt: now,
          destroyAt: destroyAt,
          destroyDurationMs: durationMs,
          clients: new Set(),
          burnMessages: new Map()
        };

        // Schedule room destruction
        newRoom.destroyTimer = setTimeout(() => {
          destroyRoom(roomId, 'lifecycle_expired');
        }, durationMs);

        rooms.set(roomId, newRoom);

        // Bind creator to room
        ws.roomId = roomId;
        ws.isAdmin = true;
        ws.alias = creatorAlias || 'Admin';
        newRoom.clients.add(ws);

        ws.send(JSON.stringify({
          type: 'room_created',
          payload: {
            roomId: roomId,
            name: newRoom.name,
            adminToken: adminToken,
            hasPassword: Boolean(newRoom.passHash),
            isPublic: newRoom.isPublic,
            allowedIps: newRoom.allowedIps,
            destroyAt: newRoom.destroyAt,
            createdAt: newRoom.createdAt
          }
        }));

        broadcastMemberList(newRoom);
        break;
      }

      // 2. Join Room (via Room ID or Direct Password Matching)
      case 'join_room': {
        const { roomId, passHash, alias } = payload;
        if (!checkRateLimit(clientIp)) {
          return ws.send(JSON.stringify({ type: 'error', code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' }));
        }

        let targetRoom = null;

        if (roomId) {
          targetRoom = rooms.get(roomId);
        } else if (passHash) {
          // Direct password matching lookup
          for (const r of rooms.values()) {
            if (r.passHash && r.passHash === passHash) {
              targetRoom = r;
              break;
            }
          }
        }

        if (!targetRoom) {
          recordAuthFailure(clientIp);
          return ws.send(JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found or password invalid.' }));
        }

        // IP restriction verification
        if (targetRoom.allowedIps && targetRoom.allowedIps.length > 0) {
          const isAllowed = targetRoom.allowedIps.some(allowed => {
            if (allowed === clientIp) return true;
            // Basic subnet check (e.g. 192.168.1.0/24 or wildcard 192.168.1.*)
            if (allowed.includes('*')) {
              const prefix = allowed.replace('*', '');
              return clientIp.startsWith(prefix);
            }
            return false;
          });

          if (!isAllowed) {
            return ws.send(JSON.stringify({ type: 'error', code: 'IP_NOT_ALLOWED', message: `Your IP (${clientIp}) is not in the whitelist.` }));
          }
        }

        // Password verification (if room has password)
        if (targetRoom.passHash) {
          if (!passHash || targetRoom.passHash !== passHash) {
            recordAuthFailure(clientIp);
            return ws.send(JSON.stringify({ type: 'error', code: 'INVALID_PASSWORD', message: 'Incorrect room password.' }));
          }
        }

        // Join room
        ws.roomId = targetRoom.id;
        ws.alias = (alias || 'Guest').trim().slice(0, 24);
        targetRoom.clients.add(ws);

        ws.send(JSON.stringify({
          type: 'room_joined',
          payload: {
            roomId: targetRoom.id,
            name: targetRoom.name,
            hasPassword: Boolean(targetRoom.passHash),
            isPublic: targetRoom.isPublic,
            allowedIps: targetRoom.allowedIps,
            destroyAt: targetRoom.destroyAt,
            createdAt: targetRoom.createdAt
          }
        }));

        broadcastMemberList(targetRoom);
        break;
      }

      // 3. Blind Relay Chat Message
      case 'send_message': {
        if (!ws.roomId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;

        const { msgId, iv, ciphertext, isBurn, burnConfig } = payload;
        if (!msgId || !iv || !ciphertext) return;

        const messagePacket = {
          type: 'chat_message',
          payload: {
            msgId: msgId,
            senderAlias: ws.alias,
            iv: iv,
            ciphertext: ciphertext,
            isBurn: Boolean(isBurn),
            burnConfig: burnConfig || null,
            timestamp: Date.now()
          }
        };

        // Register burn tracker if requested
        if (isBurn && burnConfig) {
          room.burnMessages.set(msgId, {
            type: burnConfig.type || 'timer', // 'timer' | 'views'
            maxViews: parseInt(burnConfig.maxViews) || 1,
            viewDurationSec: parseInt(burnConfig.viewDurationSec) || 10,
            viewedBy: new Set(),
            timer: null,
            createdAt: Date.now()
          });
        }

        const rawPacket = JSON.stringify(messagePacket);
        for (const client of room.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(rawPacket);
          }
        }
        break;
      }

      // 4. Burn-After-Reading Ack (User clicked / viewed the burn message)
      case 'read_burn_message': {
        if (!ws.roomId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;

        const { msgId } = payload;
        const burnTracker = room.burnMessages.get(msgId);
        if (!burnTracker) return;

        burnTracker.viewedBy.add(ws);
        const currentViews = burnTracker.viewedBy.size;

        if (burnTracker.type === 'views') {
          // If view count reached threshold -> destroy immediately for everyone
          if (currentViews >= burnTracker.maxViews) {
            broadcastDestroyMessage(room, msgId, 'view_limit_reached');
            room.burnMessages.delete(msgId);
          } else {
            // Broadcast view count update
            broadcastBurnProgress(room, msgId, currentViews, burnTracker.maxViews);
          }
        } else if (burnTracker.type === 'timer') {
          // Trigger countdown once viewed
          if (!burnTracker.timer) {
            const countdownMs = burnTracker.viewDurationSec * 1000;
            
            // Notify clients of started countdown
            const startNotify = JSON.stringify({
              type: 'burn_countdown_started',
              payload: { msgId: msgId, durationMs: countdownMs, endAt: Date.now() + countdownMs }
            });
            for (const client of room.clients) {
              if (client.readyState === WebSocket.OPEN) client.send(startNotify);
            }

            burnTracker.timer = setTimeout(() => {
              broadcastDestroyMessage(room, msgId, 'timer_expired');
              room.burnMessages.delete(msgId);
            }, countdownMs);
          }
        }
        break;
      }

      // 5. Admin Settings Update
      case 'admin_update_room': {
        if (!ws.roomId || !ws.isAdmin) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED' }));
        }
        const room = rooms.get(ws.roomId);
        if (!room || payload.adminToken !== room.adminToken) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED' }));
        }

        const { passHash, isPublic, allowedIps } = payload;

        if (passHash !== undefined) {
          room.passHash = passHash || null;
        }

        // Rule: If no password, room MUST be public
        if (!room.passHash) {
          room.isPublic = true;
        } else if (isPublic !== undefined) {
          room.isPublic = Boolean(isPublic);
        }

        if (Array.isArray(allowedIps)) {
          room.allowedIps = allowedIps.filter(Boolean);
        }

        const updateNotify = JSON.stringify({
          type: 'room_config_updated',
          payload: {
            hasPassword: Boolean(room.passHash),
            isPublic: room.isPublic,
            allowedIps: room.allowedIps
          }
        });

        for (const client of room.clients) {
          if (client.readyState === WebSocket.OPEN) client.send(updateNotify);
        }
        break;
      }

      // 6. Admin Panic Button (Emergency Instant Self-Destruction)
      case 'admin_panic_destroy': {
        if (!ws.roomId || !ws.isAdmin) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED' }));
        }
        const room = rooms.get(ws.roomId);
        if (!room || payload.adminToken !== room.adminToken) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED' }));
        }

        destroyRoom(room.id, 'panic_by_admin');
        break;
      }

      // 7. Ping / Heartbeat
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        room.clients.delete(ws);
        broadcastMemberList(room);
      }
    }
  });
});

function broadcastMemberList(room) {
  const members = Array.from(room.clients).map(c => ({
    alias: c.alias,
    isAdmin: c.isAdmin
  }));

  const payload = JSON.stringify({
    type: 'member_list_updated',
    payload: {
      count: room.clients.size,
      members: members
    }
  });

  for (const client of room.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastDestroyMessage(room, msgId, reason) {
  const payload = JSON.stringify({
    type: 'destroy_message',
    payload: { msgId: msgId, reason: reason }
  });
  for (const client of room.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastBurnProgress(room, msgId, currentViews, maxViews) {
  const payload = JSON.stringify({
    type: 'burn_progress_updated',
    payload: { msgId: msgId, currentViews: currentViews, maxViews: maxViews }
  });
  for (const client of room.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Start Server
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🔒 P-Chat Server is active on http://localhost:${PORT}`);
  console.log(`🛡️  Zero-Knowledge Relay mode enabled (RAM only)`);
  console.log(`====================================================`);
});
