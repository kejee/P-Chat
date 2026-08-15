/**
 * P-Chat Main Application Controller
 */

class PChatApp {
  constructor() {
    this.currentRoom = null;
    this.currentKey = null;
    this.currentPassword = '';
    this.isAdmin = false;
    this.adminToken = null;
    this.myAlias = 'User-' + Math.floor(100 + Math.random() * 900);
    this.clientIp = '未知';
    this.activePromptRoomId = null;
    this.roomTimerInterval = null;
    this.activeBurnIntervals = new Map(); // msgId -> interval
    this.isPrivacyShieldLocked = false;

    this.init();
  }

  async init() {
    this.initIcons();
    this.initAntiPeek();
    this.generateNewPass();
    
    // Fetch Client IP
    try {
      const ipRes = await fetch('/api/my-ip');
      const ipData = await ipRes.json();
      this.clientIp = ipData.ip || '127.0.0.1';
      document.getElementById('clientIpText').innerText = `IP: ${this.clientIp}`;
    } catch (e) {
      document.getElementById('clientIpText').innerText = `IP: 本地/内网`;
    }

    // Connect WebSocket
    try {
      await PSocket.connect();
      this.setWsStatus(true);
      this.bindSocketEvents();
    } catch (e) {
      this.setWsStatus(false);
    }

    // Fetch Public Rooms
    this.fetchPublicRooms();
    setInterval(() => {
      if (!this.currentRoom) {
        this.fetchPublicRooms();
      }
    }, 10000);

    // Enter key handler in chat
    const chatInput = document.getElementById('chatMsgInput');
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
    }
  }

  initIcons() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  setWsStatus(isOnline) {
    const dot = document.getElementById('wsStatusDot');
    const text = document.getElementById('wsStatusText');
    if (isOnline) {
      dot.className = 'status-dot online';
      text.innerText = '安全在线';
    } else {
      dot.className = 'status-dot';
      text.innerText = '离线 / 正在重连';
    }
  }

  initAntiPeek() {
    const shield = document.getElementById('privacyShield');
    
    // Auto blur when tab loses focus
    window.addEventListener('blur', () => {
      if (this.currentRoom) {
        shield.classList.add('active');
        this.isPrivacyShieldLocked = true;
      }
    });

    // Dismiss blur on click
    shield.addEventListener('click', () => {
      shield.classList.remove('active');
      this.isPrivacyShieldLocked = false;
    });

    // ESC to trigger manual lock
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        shield.classList.toggle('active');
      }
    });
  }

  bindSocketEvents() {
    PSocket.on('connected', () => this.setWsStatus(true));
    PSocket.on('disconnected', () => this.setWsStatus(false));

    PSocket.on('room_created', (payload) => {
      this.currentRoom = payload;
      this.isAdmin = true;
      this.adminToken = payload.adminToken;
      this.enterChatRoomUI();
    });

    PSocket.on('room_joined', (payload) => {
      this.currentRoom = payload;
      this.isAdmin = false;
      this.enterChatRoomUI();
    });

    PSocket.on('chat_message', (payload) => {
      this.renderIncomingMessage(payload);
    });

    PSocket.on('burn_countdown_started', (payload) => {
      this.handleBurnCountdownStarted(payload);
    });

    PSocket.on('burn_progress_updated', (payload) => {
      this.handleBurnProgressUpdated(payload);
    });

    PSocket.on('destroy_message', (payload) => {
      this.destroyMessageElement(payload.msgId, payload.reason);
    });

    PSocket.on('room_config_updated', (payload) => {
      if (this.currentRoom) {
        this.currentRoom.hasPassword = payload.hasPassword;
        this.currentRoom.isPublic = payload.isPublic;
        this.currentRoom.allowedIps = payload.allowedIps;
        this.updateRoomBadge();
      }
    });

    PSocket.on('member_list_updated', (payload) => {
      this.renderMemberList(payload);
    });

    PSocket.on('room_destroyed', (payload) => {
      alert(`⚠️ 房间已被销毁 (原因: ${payload.reason === 'panic_by_admin' ? '管理员触发紧急自毁核按钮' : '达到生命周期时限'})`);
      this.leaveRoom();
    });

    PSocket.on('error', (err) => {
      alert(`❌ 错误提示: ${err.message || err.code}`);
    });
  }

  generateNewPass() {
    const pass = PCrypto.generateStrongPassword(12);
    const input = document.getElementById('createPasswordInput');
    if (input) input.value = pass;
  }

  generateAdminPass() {
    const pass = PCrypto.generateStrongPassword(12);
    const input = document.getElementById('adminPasswordInput');
    if (input) input.value = pass;
  }

  // Fetch Public Rooms list for Lobby
  async fetchPublicRooms() {
    try {
      const res = await fetch('/api/rooms');
      const data = await res.json();
      const grid = document.getElementById('publicRoomsGrid');
      if (!grid) return;

      if (!data.rooms || data.rooms.length === 0) {
        grid.innerHTML = `
          <div class="room-card" style="text-align: center; color: var(--text-muted); grid-column: 1 / -1; padding: 40px;">
            暂无开放的公开群组，您可以点击上方创建专属群组。
          </div>
        `;
        return;
      }

      grid.innerHTML = data.rooms.map(r => `
        <div class="room-card">
          <div class="room-card-top">
            <div>
              <div class="room-card-name">${this.escapeHtml(r.name)}</div>
              <div class="room-card-stats" style="margin-top: 4px;">
                <span>👥 在线 ${r.memberCount} 人</span>
                <span>⏳ 剩余约 ${Math.ceil(r.remainingMs / 60000)} 分钟</span>
              </div>
            </div>
            <div class="room-badge-group">
              ${r.hasPassword ? '<span class="badge badge-locked">需要口令</span>' : '<span class="badge badge-open">免密直达</span>'}
            </div>
          </div>
          <button class="btn btn-outline btn-sm" style="width: 100%; justify-content: center;" onclick="app.clickJoinPublicRoom('${r.id}', ${r.hasPassword})">
            ${r.hasPassword ? '输入口令进入' : '直接加入'}
          </button>
        </div>
      `).join('');
      this.initIcons();
    } catch (e) {
      console.error('Failed to fetch rooms:', e);
    }
  }

  // Create Room
  async createRoom() {
    const nameInput = document.getElementById('createNameInput');
    const passInput = document.getElementById('createPasswordInput');
    const isPublicCheck = document.getElementById('createIsPublic');
    const durationSelect = document.getElementById('createDestroyDuration');
    const ipsInput = document.getElementById('createAllowedIps');

    const name = nameInput.value.trim() || '未命名群组';
    const password = passInput.value.trim();
    let isPublic = isPublicCheck.checked;

    // Rule: If password is empty, room MUST be public
    if (!password) {
      isPublic = true;
    }

    const allowedIps = ipsInput.value.split(',').map(s => s.trim()).filter(Boolean);
    const durationMinutes = parseInt(durationSelect.value) || 60;

    // Derive CryptoKey & passHash
    this.currentPassword = password;
    this.currentKey = await PCrypto.deriveKey(password);
    const passHash = password ? await PCrypto.sha256(password) : null;

    PSocket.send('create_room', {
      name: name,
      passHash: passHash,
      isPublic: isPublic,
      allowedIps: allowedIps,
      destroyDurationMinutes: durationMinutes,
      creatorAlias: 'Admin (' + this.myAlias + ')'
    });
  }

  // Join Room by Password
  async joinByPassword() {
    const passInput = document.getElementById('joinPasswordInput');
    const aliasInput = document.getElementById('joinAliasInput');
    const password = passInput.value.trim();

    if (!password) {
      return alert('请输入群组口令！');
    }

    this.currentPassword = password;
    if (aliasInput.value.trim()) {
      this.myAlias = aliasInput.value.trim();
    }

    this.currentKey = await PCrypto.deriveKey(password);
    const passHash = await PCrypto.sha256(password);

    PSocket.send('join_room', {
      passHash: passHash,
      alias: this.myAlias
    });
  }

  // Join Public Room click handler
  clickJoinPublicRoom(roomId, hasPassword) {
    if (hasPassword) {
      this.activePromptRoomId = roomId;
      document.getElementById('promptPassInput').value = '';
      document.getElementById('passwordPromptModal').classList.add('active');
    } else {
      this.confirmJoinPasswordlessRoom(roomId);
    }
  }

  async confirmJoinPasswordlessRoom(roomId) {
    this.currentPassword = '';
    this.currentKey = await PCrypto.deriveKey('');
    PSocket.send('join_room', {
      roomId: roomId,
      passHash: null,
      alias: this.myAlias
    });
  }

  async confirmJoinPromptedRoom() {
    const pass = document.getElementById('promptPassInput').value.trim();
    if (!pass) return alert('请输入口令！');

    this.currentPassword = pass;
    this.currentKey = await PCrypto.deriveKey(pass);
    const passHash = await PCrypto.sha256(pass);

    PSocket.send('join_room', {
      roomId: this.activePromptRoomId,
      passHash: passHash,
      alias: this.myAlias
    });

    this.closePasswordPrompt();
  }

  closePasswordPrompt() {
    document.getElementById('passwordPromptModal').classList.remove('active');
    this.activePromptRoomId = null;
  }

  // Switch UI to Chat Room
  enterChatRoomUI() {
    document.getElementById('lobbyView').classList.remove('active');
    document.getElementById('chatView').classList.add('active');

    // Header buttons
    document.getElementById('btnLeaveRoom').style.display = 'inline-flex';
    document.getElementById('btnAdminModal').style.display = this.isAdmin ? 'inline-flex' : 'none';

    document.getElementById('activeRoomName').innerText = this.currentRoom.name;
    this.updateRoomBadge();

    // Clear messages
    document.getElementById('messageStream').innerHTML = `
      <div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; margin: 12px 0;">
        🔒 端到端加密隧道已建立。消息离开本机前已加密，任何第三方及服务器均无法解密。
      </div>
    `;

    // Start Room Lifetime Countdown
    this.startRoomCountdown();
    this.initIcons();
  }

  updateRoomBadge() {
    const badge = document.getElementById('roomSecurityBadge');
    if (this.currentRoom.hasPassword) {
      badge.className = 'badge badge-locked';
      badge.innerText = 'E2EE 口令加密';
    } else {
      badge.className = 'badge badge-open';
      badge.innerText = '公开频道 (无密码)';
    }
  }

  startRoomCountdown() {
    if (this.roomTimerInterval) clearInterval(this.roomTimerInterval);
    const timerElem = document.getElementById('countdownTimerText');

    const updateTimer = () => {
      if (!this.currentRoom || !this.currentRoom.destroyAt) return;
      const remainingMs = Math.max(0, this.currentRoom.destroyAt - Date.now());
      if (remainingMs <= 0) {
        timerElem.innerText = '即将销毁';
        return;
      }
      const totalSec = Math.floor(remainingMs / 1000);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      timerElem.innerText = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    updateTimer();
    this.roomTimerInterval = setInterval(updateTimer, 1000);
  }

  leaveRoom() {
    if (this.roomTimerInterval) clearInterval(this.roomTimerInterval);
    this.currentRoom = null;
    this.currentKey = null;
    this.currentPassword = '';
    this.isAdmin = false;
    this.adminToken = null;

    document.getElementById('chatView').classList.remove('active');
    document.getElementById('lobbyView').classList.add('active');

    document.getElementById('btnLeaveRoom').style.display = 'none';
    document.getElementById('btnAdminModal').style.display = 'none';

    this.fetchPublicRooms();
  }

  showLobby() {
    if (this.currentRoom) {
      if (confirm('是否退出当前群组并返回大厅？')) {
        this.leaveRoom();
      }
    }
  }

  renderMemberList(payload) {
    document.getElementById('memberCountBadge').innerText = payload.count;
    const ul = document.getElementById('memberListUl');
    ul.innerHTML = payload.members.map(m => `
      <li class="member-item">
        <i data-lucide="user" style="width: 14px; height: 14px; color: var(--accent-green);"></i>
        <span>${this.escapeHtml(m.alias)}</span>
        ${m.isAdmin ? '<span class="member-badge-admin">管理员</span>' : ''}
      </li>
    `).join('');
    this.initIcons();
  }

  // Toggle Burn Controls
  toggleBurnControls() {
    const isChecked = document.getElementById('enableBurnCheck').checked;
    document.getElementById('burnConfigContainer').style.display = isChecked ? 'inline-flex' : 'none';
  }

  onBurnTypeChange() {
    const type = document.getElementById('burnTypeSelect').value;
    document.getElementById('burnTimerInputGroup').style.display = type === 'timer' ? 'inline-flex' : 'none';
    document.getElementById('burnViewsInputGroup').style.display = type === 'views' ? 'inline-flex' : 'none';
  }

  // Send Message
  async sendMessage() {
    const input = document.getElementById('chatMsgInput');
    const text = input.value.trim();
    if (!text || !this.currentRoom || !this.currentKey) return;

    const isBurn = document.getElementById('enableBurnCheck').checked;
    let burnConfig = null;

    if (isBurn) {
      const type = document.getElementById('burnTypeSelect').value;
      burnConfig = {
        type: type,
        viewDurationSec: parseInt(document.getElementById('burnTimerSecSelect').value) || 10,
        maxViews: parseInt(document.getElementById('burnMaxViewsSelect').value) || 1
      };
    }

    // Encrypt in Browser
    const msgId = 'msg-' + Math.random().toString(36).substring(2, 11);
    const { iv, ciphertext } = await PCrypto.encrypt(text, this.currentKey);

    PSocket.send('send_message', {
      msgId: msgId,
      iv: iv,
      ciphertext: ciphertext,
      isBurn: isBurn,
      burnConfig: burnConfig
    });

    input.value = '';
    input.focus();
  }

  // Render Incoming Message
  async renderIncomingMessage(payload) {
    const stream = document.getElementById('messageStream');
    const isOwn = payload.senderAlias.includes(this.myAlias);
    const timeStr = new Date(payload.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${isOwn ? 'own' : 'peer'}`;
    bubble.id = payload.msgId;

    if (payload.isBurn) {
      // Burn After Reading Mask Card
      const burnHint = payload.burnConfig?.type === 'views'
        ? `🔥 阅后即焚 (限 ${payload.burnConfig.maxViews} 人查看)`
        : `🔥 阅后即焚 (查看后 ${payload.burnConfig.viewDurationSec} 秒自毁)`;

      bubble.innerHTML = `
        <div class="msg-meta">
          <span>${this.escapeHtml(payload.senderAlias)}</span>
          <span>${timeStr}</span>
        </div>
        <div class="msg-content-card msg-burn-card" id="card-${payload.msgId}" onclick="app.revealBurnMessage('${payload.msgId}', '${payload.iv}', '${payload.ciphertext}', '${payload.burnConfig?.type}')">
          <div class="burn-shield-overlay" id="burnMask-${payload.msgId}">
            <i data-lucide="eye" style="width: 16px; height: 16px;"></i>
            <span>${burnHint} · 点击解密查看</span>
          </div>
          <div class="burn-text" id="burnText-${payload.msgId}" style="display: none;"></div>
          <div class="burn-timer-bar" id="burnBar-${payload.msgId}" style="width: 0%;"></div>
        </div>
      `;
    } else {
      // Normal E2EE Message - Instant Decrypt
      const decryptedText = await PCrypto.decrypt(payload.iv, payload.ciphertext, this.currentKey);
      bubble.innerHTML = `
        <div class="msg-meta">
          <span>${this.escapeHtml(payload.senderAlias)}</span>
          <span>${timeStr}</span>
        </div>
        <div class="msg-content-card">
          ${this.escapeHtml(decryptedText)}
        </div>
      `;
    }

    stream.appendChild(bubble);
    stream.scrollTop = stream.scrollHeight;
    this.initIcons();
  }

  // Reveal Burn Message on Click
  async revealBurnMessage(msgId, iv, ciphertext, burnType) {
    const mask = document.getElementById(`burnMask-${msgId}`);
    const textElem = document.getElementById(`burnText-${msgId}`);
    const card = document.getElementById(`card-${msgId}`);

    if (!mask || !textElem || textElem.style.display !== 'none') return;

    // Decrypt on demand
    const decrypted = await PCrypto.decrypt(iv, ciphertext, this.currentKey);
    mask.style.display = 'none';
    textElem.style.display = 'block';
    textElem.innerHTML = `
      <div style="color: var(--accent-red); font-size: 0.72rem; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 4px;">
        <i data-lucide="flame" style="width: 12px; height: 12px;"></i> 机密已读
      </div>
      <div>${this.escapeHtml(decrypted)}</div>
    `;
    this.initIcons();

    // Send Read Ack to server
    PSocket.send('read_burn_message', { msgId: msgId });
  }

  // Handle countdown started from server
  handleBurnCountdownStarted(payload) {
    const { msgId, durationMs, endAt } = payload;
    const bar = document.getElementById(`burnBar-${msgId}`);
    if (!bar) return;

    const startTime = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - startTime;
      const progress = Math.min(100, (elapsed / durationMs) * 100);
      bar.style.width = `${progress}%`;

      if (now >= endAt) {
        clearInterval(interval);
        this.activeBurnIntervals.delete(msgId);
      }
    }, 50);

    this.activeBurnIntervals.set(msgId, interval);
  }

  handleBurnProgressUpdated(payload) {
    const { msgId, currentViews, maxViews } = payload;
    const mask = document.getElementById(`burnMask-${msgId}`);
    if (mask) {
      mask.innerHTML = `
        <i data-lucide="eye" style="width: 16px; height: 16px;"></i>
        <span>🔥 已被 ${currentViews}/${maxViews} 人查看 · 点击解密</span>
      `;
      this.initIcons();
    }
  }

  // Destroy Message with ash animation
  destroyMessageElement(msgId, reason) {
    const elem = document.getElementById(msgId);
    if (elem) {
      elem.classList.add('burn-destroying');
      setTimeout(() => {
        if (elem.parentNode) {
          elem.parentNode.removeChild(elem);
        }
      }, 600);
    }
    if (this.activeBurnIntervals.has(msgId)) {
      clearInterval(this.activeBurnIntervals.get(msgId));
      this.activeBurnIntervals.delete(msgId);
    }
  }

  // Admin Modal Methods
  openAdminModal() {
    if (!this.isAdmin || !this.currentRoom) return;
    document.getElementById('adminPasswordInput').value = this.currentPassword;
    document.getElementById('adminIsPublic').checked = this.currentRoom.isPublic;
    document.getElementById('adminAllowedIps').value = (this.currentRoom.allowedIps || []).join(', ');
    document.getElementById('adminModal').classList.add('active');
  }

  closeAdminModal() {
    document.getElementById('adminModal').classList.remove('active');
  }

  async submitAdminUpdate() {
    const newPass = document.getElementById('adminPasswordInput').value.trim();
    let isPublic = document.getElementById('adminIsPublic').checked;
    const ips = document.getElementById('adminAllowedIps').value.split(',').map(s => s.trim()).filter(Boolean);

    // If password cleared, MUST be public
    if (!newPass) {
      isPublic = true;
    }

    this.currentPassword = newPass;
    this.currentKey = await PCrypto.deriveKey(newPass);
    const passHash = newPass ? await PCrypto.sha256(newPass) : null;

    PSocket.send('admin_update_room', {
      adminToken: this.adminToken,
      passHash: passHash,
      isPublic: isPublic,
      allowedIps: ips
    });

    this.closeAdminModal();
    alert('✅ 管理员安全配置已更新！');
  }

  panicDestroyRoom() {
    if (!confirm('⚠️ 警告：紧急核按钮将立即物理擦除本群组所有内存与消息，所有成员将被强制踢出！确定继续？')) {
      return;
    }
    PSocket.send('admin_panic_destroy', {
      adminToken: this.adminToken
    });
    this.closeAdminModal();
  }

  copyCurrentPass() {
    if (!this.currentPassword) {
      return alert('本群组为免密公开群组，无专属口令。');
    }
    navigator.clipboard.writeText(this.currentPassword).then(() => {
      alert(`🔑 口令已复制到剪贴板:\n${this.currentPassword}\n\n群友凭此口令即可在首页直达并解密加入。`);
    });
  }

  escapeHtml(text) {
    if (!text) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new PChatApp();
});
