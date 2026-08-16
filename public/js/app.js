/**
 * P-Chat Main Application Controller
 * High-Performance Native Binary ArrayBuffer Protocol (Zero Base64 Overhead)
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
    this.revealedBurnMessages = new Set(); // msgId set
    this.burnBinaryStore = new Map(); // msgId -> { iv, cipherBuffer, meta }
    this.isPrivacyShieldLocked = false;
    this.pendingAttachment = null; // { name, size, type, mimeType, fileBlob, previewUrl }

    this.init();
  }

  cleanPassword(str) {
    if (!str) return '';
    return String(str).replace(/[\u200B-\u200D\uFEFF\r\n\t]/g, '').trim();
  }

  async init() {
    this.initIcons();
    this.initAntiPeek();
    this.initPasteHandler();
    this.generateNewPass();
    this.bindKeyboardShortcuts();
    
    // Fetch Client IP
    try {
      const ipRes = await fetch('/api/my-ip');
      const ipData = await ipRes.json();
      this.clientIp = ipData.ip || '127.0.0.1';
      document.getElementById('clientIpText').innerText = `IP: ${this.clientIp}`;
    } catch (e) {
      document.getElementById('clientIpText').innerText = `IP: 本地/内网`;
    }

    // Check Secure Context for WebCrypto
    if (!PCrypto.isAvailable()) {
      const banner = document.getElementById('httpsWarningBanner');
      if (banner) banner.style.display = 'block';
    }

    // Connect WebSocket
    try {
      await PSocket.connect();
      this.setWsStatus(true);
      this.bindSocketEvents();
      this.checkUrlHashForAutoJoin();
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
  }

  bindKeyboardShortcuts() {
    // 1. Chat Textarea (Shift+Enter to send, Enter to newline)
    const chatInput = document.getElementById('chatMsgInput');
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (e.shiftKey) {
            e.preventDefault();
            this.sendMessage();
          }
        }
      });
    }

    // 2. Join Password Input (Enter to join)
    const joinPassInput = document.getElementById('joinPasswordInput');
    if (joinPassInput) {
      joinPassInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.joinByPassword();
        }
      });
    }

    const joinAliasInput = document.getElementById('joinAliasInput');
    if (joinAliasInput) {
      joinAliasInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.joinByPassword();
        }
      });
    }

    // 3. Prompt Password Modal Input (Enter to confirm)
    const promptPassInput = document.getElementById('promptPassInput');
    if (promptPassInput) {
      promptPassInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.confirmJoinPromptedRoom();
        }
      });
    }
  }

  checkUrlHashForAutoJoin() {
    const hash = window.location.hash;
    if (!hash || hash.length < 2) return;

    try {
      const params = new URLSearchParams(hash.substring(1));
      const pass = params.get('pass') || params.get('pwd');
      const room = params.get('room');

      if (pass) {
        const cleanedPass = this.cleanPassword(pass);
        const joinInput = document.getElementById('joinPasswordInput');
        if (joinInput) joinInput.value = cleanedPass;
        setTimeout(() => {
          this.joinByPassword();
        }, 300);
      } else if (room) {
        setTimeout(() => {
          this.clickJoinPublicRoom(room, false);
        }, 300);
      }
    } catch (e) {
      console.warn('[PChat] Failed to parse URL hash for auto-join:', e);
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
    
    window.addEventListener('blur', () => {
      if (this.currentRoom) {
        shield.classList.add('active');
        this.isPrivacyShieldLocked = true;
      }
    });

    shield.addEventListener('click', () => {
      shield.classList.remove('active');
      this.isPrivacyShieldLocked = false;
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        shield.classList.toggle('active');
      }
    });
  }

  initPasteHandler() {
    window.addEventListener('paste', (e) => {
      if (!this.currentRoom) return;
      const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            this.processFileForAttachment(blob, 'pasted-image.png');
            break;
          }
        }
      }
    });
  }

  handleFileSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (file) {
      this.processFileForAttachment(file, file.name);
    }
    event.target.value = '';
  }

  processFileForAttachment(file, defaultName) {
    if (file.size > 80 * 1024 * 1024) {
      return alert('⚠️ 文件体积过大，单次附件请限制在 80MB 以内。');
    }

    let mediaType = 'file';
    if (file.type.startsWith('image/')) {
      mediaType = 'image';
    } else if (file.type.startsWith('video/')) {
      mediaType = 'video';
    }

    const previewUrl = (mediaType === 'image' || mediaType === 'video')
      ? URL.createObjectURL(file)
      : null;

    this.pendingAttachment = {
      name: file.name || defaultName || 'unnamed-attachment',
      size: file.size,
      type: mediaType,
      mimeType: file.type || 'application/octet-stream',
      fileBlob: file,
      previewUrl: previewUrl
    };

    this.renderAttachmentPreview();
  }

  renderAttachmentPreview() {
    const bar = document.getElementById('attachmentPreviewBar');
    const thumb = document.getElementById('attachmentPreviewThumb');
    if (!this.pendingAttachment) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'flex';
    if (this.pendingAttachment.type === 'image') {
      thumb.innerHTML = `
        <img src="${this.pendingAttachment.previewUrl}" style="width: 36px; height: 36px; object-fit: cover; border-radius: 4px; border: 1px solid var(--accent-cyan);">
        <div>
          <div style="font-weight: 600;">已捕获图片: ${this.escapeHtml(this.pendingAttachment.name)}</div>
          <div style="font-size: 0.7rem; color: var(--text-muted);">${this.formatFileSize(this.pendingAttachment.size)} · 纯二进制原生流传输</div>
        </div>
      `;
    } else if (this.pendingAttachment.type === 'video') {
      thumb.innerHTML = `
        <i data-lucide="video" style="width: 24px; height: 24px; color: var(--accent-cyan);"></i>
        <div>
          <div style="font-weight: 600;">已选定视频: ${this.escapeHtml(this.pendingAttachment.name)}</div>
          <div style="font-size: 0.7rem; color: var(--text-muted);">${this.formatFileSize(this.pendingAttachment.size)} · 纯二进制原生流传输</div>
        </div>
      `;
    } else {
      thumb.innerHTML = `
        <i data-lucide="file" style="width: 24px; height: 24px; color: var(--accent-cyan);"></i>
        <div>
          <div style="font-weight: 600;">已选定文件: ${this.escapeHtml(this.pendingAttachment.name)}</div>
          <div style="font-size: 0.7rem; color: var(--text-muted);">${this.formatFileSize(this.pendingAttachment.size)} · 纯二进制原生流传输</div>
        </div>
      `;
    }
    this.initIcons();
  }

  clearAttachment() {
    if (this.pendingAttachment && this.pendingAttachment.previewUrl) {
      URL.revokeObjectURL(this.pendingAttachment.previewUrl);
    }
    this.pendingAttachment = null;
    this.renderAttachmentPreview();
  }

  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  openLightbox(src) {
    const modal = document.getElementById('lightboxModal');
    const img = document.getElementById('lightboxImg');
    img.src = src;
    modal.classList.add('active');
  }

  closeLightbox() {
    const modal = document.getElementById('lightboxModal');
    modal.classList.remove('active');
    document.getElementById('lightboxImg').src = '';
  }

  bindSocketEvents() {
    PSocket.on('connected', () => this.setWsStatus(true));
    PSocket.on('disconnected', () => this.setWsStatus(false));

    // Native Binary Message Received
    PSocket.on('binary_message', async (arrayBuffer) => {
      await this.handleIncomingBinaryFrame(arrayBuffer);
    });

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

    PSocket.on('history_cleared', (payload) => {
      const stream = document.getElementById('messageStream');
      const info = document.createElement('div');
      info.className = 'history-divider';
      info.style.borderColor = 'rgba(255, 184, 0, 0.3)';
      info.innerHTML = `
        <span style="color: var(--accent-yellow);"><i data-lucide="trash-2" style="width: 13px; height: 13px; vertical-align: middle; margin-right: 4px;"></i> 管理员 (${this.escapeHtml(payload.byAlias)}) 已清空房间内存历史缓冲区</span>
      `;
      stream.appendChild(info);
      this.initIcons();
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
        this.currentRoom.enableHistory = payload.enableHistory;
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
      alert(`❌ 进群或操作失败: ${err.message || err.code}`);
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

  async createRoom() {
    const nameInput = document.getElementById('createNameInput');
    const passInput = document.getElementById('createPasswordInput');
    const isPublicCheck = document.getElementById('createIsPublic');
    const enableHistoryCheck = document.getElementById('createEnableHistory');
    const durationSelect = document.getElementById('createDestroyDuration');
    const ipsInput = document.getElementById('createAllowedIps');

    const name = nameInput.value.trim() || '未命名群组';
    const rawPassword = passInput.value;
    const password = this.cleanPassword(rawPassword);
    let isPublic = isPublicCheck.checked;
    const enableHistory = enableHistoryCheck ? enableHistoryCheck.checked : true;

    if (!password) {
      isPublic = true;
    }

    const allowedIps = ipsInput.value.split(',').map(s => s.trim()).filter(Boolean);
    const durationMinutes = parseInt(durationSelect.value) || 60;

    this.currentPassword = password;
    this.currentKey = await PCrypto.deriveKey(password);
    const passHash = password ? await PCrypto.sha256(password) : null;

    PSocket.send('create_room', {
      name: name,
      passHash: passHash,
      isPublic: isPublic,
      enableHistory: enableHistory,
      allowedIps: allowedIps,
      destroyDurationMinutes: durationMinutes,
      creatorAlias: 'Admin (' + this.myAlias + ')'
    });
  }

  async joinByPassword() {
    const passInput = document.getElementById('joinPasswordInput');
    const aliasInput = document.getElementById('joinAliasInput');
    const rawPassword = passInput.value;
    const password = this.cleanPassword(rawPassword);

    if (!password) {
      return alert('请输入群组专属口令！');
    }

    this.currentPassword = password;
    if (aliasInput && aliasInput.value.trim()) {
      this.myAlias = aliasInput.value.trim();
    }

    this.currentKey = await PCrypto.deriveKey(password);
    const passHash = await PCrypto.sha256(password);

    PSocket.send('join_room', {
      passHash: passHash,
      alias: this.myAlias
    });
  }

  clickJoinPublicRoom(roomId, hasPassword) {
    if (hasPassword) {
      this.activePromptRoomId = roomId;
      document.getElementById('promptPassInput').value = '';
      document.getElementById('passwordPromptModal').classList.add('active');
      document.getElementById('promptPassInput').focus();
    } else {
      this.currentPassword = '';
      PCrypto.deriveKey('').then(key => {
        this.currentKey = key;
        PSocket.send('join_room', {
          roomId: roomId,
          passHash: null,
          alias: this.myAlias
        });
      });
    }
  }

  closePasswordPrompt() {
    document.getElementById('passwordPromptModal').classList.remove('active');
    this.activePromptRoomId = null;
  }

  async confirmJoinPromptedRoom() {
    const rawPass = document.getElementById('promptPassInput').value;
    const password = this.cleanPassword(rawPass);

    if (!password) {
      return alert('请输入该群组的加入口令！');
    }

    this.currentPassword = password;
    this.currentKey = await PCrypto.deriveKey(password);
    const passHash = await PCrypto.sha256(password);

    PSocket.send('join_room', {
      roomId: this.activePromptRoomId,
      passHash: passHash,
      alias: this.myAlias
    });

    this.closePasswordPrompt();
  }

  enterChatRoomUI() {
    document.getElementById('lobbyView').classList.remove('active');
    document.getElementById('chatView').classList.add('active');

    document.getElementById('btnLeaveRoom').style.display = 'inline-flex';
    document.getElementById('btnAdminModal').style.display = this.isAdmin ? 'inline-flex' : 'none';
    const mobileAdminBtn = document.getElementById('btnMobileAdmin');
    if (mobileAdminBtn) mobileAdminBtn.style.display = this.isAdmin ? 'inline-flex' : 'none';

    document.getElementById('activeRoomName').innerText = this.currentRoom.name;
    this.updateRoomBadge();

    this.clearAttachment();
    document.getElementById('messageStream').innerHTML = `
      <div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; margin: 12px 0;">
        🔒 原生二进制端到端加密隧道已建立。数据在离开本机前完成加密，服务器仅进行二进制盲中继。
      </div>
    `;

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
    this.revealedBurnMessages = new Set();
    this.burnBinaryStore.clear();
    this.clearAttachment();

    document.getElementById('chatView').classList.remove('active');
    document.getElementById('lobbyView').classList.add('active');

    document.getElementById('btnLeaveRoom').style.display = 'none';
    document.getElementById('btnAdminModal').style.display = 'none';
    const mobileAdminBtn = document.getElementById('btnMobileAdmin');
    if (mobileAdminBtn) mobileAdminBtn.style.display = 'none';

    if (window.location.hash) {
      history.replaceState(null, null, ' ');
    }

    this.fetchPublicRooms();
  }

  showLobby() {
    if (this.currentRoom) {
      if (confirm('是否退出当前群组并返回大厅？')) {
        this.leaveRoom();
      }
    }
  }

  openMobileMembers() {
    document.getElementById('mobileMembersModal').classList.add('active');
  }

  closeMobileMembers() {
    document.getElementById('mobileMembersModal').classList.remove('active');
  }

  renderMemberList(payload) {
    const countText = payload.count;
    document.getElementById('memberCountBadge').innerText = countText;
    const mobileCount = document.getElementById('mobileMemberCountBadge');
    if (mobileCount) mobileCount.innerText = countText;

    const listHtml = payload.members.map(m => `
      <li class="member-item">
        <i data-lucide="user" style="width: 14px; height: 14px; color: var(--accent-green);"></i>
        <span>${this.escapeHtml(m.alias)}</span>
        ${m.isAdmin ? '<span class="member-badge-admin">管理员</span>' : ''}
      </li>
    `).join('');

    const ul = document.getElementById('memberListUl');
    if (ul) ul.innerHTML = listHtml;

    const mobileUl = document.getElementById('mobileMemberListUl');
    if (mobileUl) mobileUl.innerHTML = listHtml;

    this.initIcons();
  }

  toggleBurnControls() {
    const isChecked = document.getElementById('enableBurnCheck').checked;
    document.getElementById('burnConfigContainer').style.display = isChecked ? 'inline-flex' : 'none';
  }

  onBurnTypeChange() {
    const type = document.getElementById('burnTypeSelect').value;
    document.getElementById('burnTimerInputGroup').style.display = type === 'timer' ? 'inline-flex' : 'none';
    document.getElementById('burnViewsInputGroup').style.display = type === 'views' ? 'inline-flex' : 'none';
  }

  showSendProgress(statusText, percent) {
    const container = document.getElementById('uploadProgressBarContainer');
    const status = document.getElementById('uploadProgressStatusText');
    const percentElem = document.getElementById('uploadProgressPercentText');
    const fill = document.getElementById('uploadProgressBarFill');

    if (container) container.style.display = 'block';
    if (status) status.innerHTML = `<i data-lucide="loader-2" class="spin-anim" style="width: 12px; height: 12px; vertical-align: middle;"></i> ${statusText}`;
    if (percentElem) percentElem.innerText = `${percent}%`;
    if (fill) fill.style.width = `${percent}%`;
    this.initIcons();
  }

  updateSendProgress(statusText, percent) {
    const status = document.getElementById('uploadProgressStatusText');
    const percentElem = document.getElementById('uploadProgressPercentText');
    const fill = document.getElementById('uploadProgressBarFill');

    if (status) status.innerHTML = `<i data-lucide="loader-2" class="spin-anim" style="width: 12px; height: 12px; vertical-align: middle;"></i> ${statusText}`;
    if (percentElem) percentElem.innerText = `${percent}%`;
    if (fill) fill.style.width = `${percent}%`;
    this.initIcons();
  }

  hideSendProgress() {
    const container = document.getElementById('uploadProgressBarContainer');
    if (container) container.style.display = 'none';
  }

  // Send Message via Native Binary ArrayBuffer Frame (0% Base64 Overhead)
  async sendMessage() {
    const input = document.getElementById('chatMsgInput');
    const text = input.value.trim();
    const attachment = this.pendingAttachment;

    if ((!text && !attachment) || !this.currentRoom || !this.currentKey) return;

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

    try {
      const msgId = 'msg-' + Math.random().toString(36).substring(2, 11);
      const isMedia = Boolean(attachment);

      if (isMedia) {
        this.showSendProgress(`正在读取 ${this.escapeHtml(attachment.name)}...`, 20);
      }

      let payloadBuffer;
      let metaObject = {
        msgId: msgId,
        senderAlias: this.myAlias,
        timestamp: Date.now(),
        isBurn: isBurn,
        burnConfig: burnConfig,
        text: text || '',
        hasMedia: isMedia
      };

      if (isMedia) {
        this.updateSendProgress('正在进行原生硬件级 AES-256-GCM 二进制加密...', 50);
        metaObject.mediaMeta = {
          name: attachment.name,
          size: attachment.size,
          type: attachment.type,
          mimeType: attachment.mimeType
        };
        payloadBuffer = await attachment.fileBlob.arrayBuffer();
      } else {
        payloadBuffer = new TextEncoder().encode(text);
      }

      // Pack binary frame
      if (isMedia) {
        this.updateSendProgress('正在封装零拷贝二进制流...', 80);
      }
      const packet = await PCrypto.packBinaryFrame(metaObject, payloadBuffer, this.currentKey);

      // Send binary frame directly to WebSocket
      PSocket.sendBinary(packet);

      if (isMedia) {
        this.updateSendProgress('发送完成！', 100);
        setTimeout(() => this.hideSendProgress(), 400);
      }

      input.value = '';
      this.clearAttachment();
      input.focus();
    } catch (err) {
      console.error('[PChat] Failed to send binary message:', err);
      alert('⚠️ 发送失败: ' + (err.message || err));
      this.hideSendProgress();
    }
  }

  // Handle Incoming Binary Frame (Live message or History replay)
  async handleIncomingBinaryFrame(arrayBuffer) {
    try {
      const frame = PCrypto.unpackBinaryFrame(arrayBuffer);
      if (!frame) return;

      const { iv, meta, cipherBuffer } = frame;
      const stream = document.getElementById('messageStream');
      const isOwn = meta.senderAlias.includes(this.myAlias);
      const timeStr = new Date(meta.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const bubble = document.createElement('div');
      bubble.className = `msg-bubble ${isOwn ? 'own' : 'peer'}`;
      bubble.id = meta.msgId;

      if (meta.isBurn) {
        // Store cipherBuffer for on-demand reveal
        this.burnBinaryStore.set(meta.msgId, { iv, cipherBuffer, meta });

        const burnHint = meta.burnConfig?.type === 'views'
          ? `🔥 阅后即焚 (限 ${meta.burnConfig.maxViews} 人查看)`
          : `🔥 阅后即焚 (查看后 ${meta.burnConfig.viewDurationSec} 秒自毁)`;

        bubble.innerHTML = `
          <div class="msg-meta">
            <span>${this.escapeHtml(meta.senderAlias)}</span>
            <span>${timeStr}</span>
          </div>
          <div class="msg-content-card msg-burn-card" id="card-${meta.msgId}" onclick="app.revealBurnMessage('${meta.msgId}', ${isOwn})">
            <div class="burn-shield-overlay" id="burnMask-${meta.msgId}">
              <i data-lucide="eye" style="width: 16px; height: 16px;"></i>
              <span>${burnHint} · ${isOwn ? '发件人点击预览' : '点击解密查看'}</span>
            </div>
            <div class="burn-text" id="burnText-${meta.msgId}" style="display: none;"></div>
            <div class="burn-timer-bar" id="burnBar-${meta.msgId}" style="width: 0%;"></div>
          </div>
        `;
      } else {
        // Instant decrypt
        const plainBuffer = await PCrypto.decryptBinary(iv, cipherBuffer, this.currentKey);
        const renderedHtml = this.renderBinaryContentHtml(meta, plainBuffer);

        bubble.innerHTML = `
          <div class="msg-meta">
            <span>${this.escapeHtml(meta.senderAlias)}</span>
            <span>${timeStr}</span>
          </div>
          <div class="msg-content-card">
            ${renderedHtml}
          </div>
        `;
      }

      stream.appendChild(bubble);
      stream.scrollTop = stream.scrollHeight;
      this.initIcons();
    } catch (err) {
      console.error('[PChat] Decrypt binary frame failed:', err);
    }
  }

  // Helper to render Decrypted Plain Buffer into visual DOM elements
  renderBinaryContentHtml(meta, plainBuffer) {
    let html = '';

    if (meta.hasMedia && meta.mediaMeta) {
      const blob = new Blob([plainBuffer], { type: meta.mediaMeta.mimeType });
      const blobUrl = URL.createObjectURL(blob);

      if (meta.mediaMeta.type === 'image') {
        html += `
          <img src="${blobUrl}" class="media-img-preview" alt="加密图片" onclick="app.openLightbox('${blobUrl}')" title="点击放大查看">
        `;
      } else if (meta.mediaMeta.type === 'video') {
        html += `
          <video src="${blobUrl}" class="media-video-player" controls preload="metadata" playsinline></video>
        `;
      } else {
        html += `
          <a href="${blobUrl}" download="${this.escapeHtml(meta.mediaMeta.name)}" class="file-attachment-card" title="点击解密下载">
            <div class="file-icon-box">
              <i data-lucide="file-down" style="width: 20px; height: 20px;"></i>
            </div>
            <div class="file-info-text">
              <span class="file-name-text">${this.escapeHtml(meta.mediaMeta.name)}</span>
              <span class="file-size-text">${this.formatFileSize(meta.mediaMeta.size)} · 点击安全下载</span>
            </div>
          </a>
        `;
      }
    }

    if (meta.text) {
      html += `<div style="white-space: pre-wrap; ${meta.hasMedia ? 'margin-top: 8px;' : ''}">${this.escapeHtml(meta.text)}</div>`;
    } else if (!meta.hasMedia) {
      const text = new TextDecoder().decode(plainBuffer);
      html += `<div style="white-space: pre-wrap;">${this.escapeHtml(text)}</div>`;
    }

    return html || '<span style="color: var(--text-muted);">[空白消息]</span>';
  }

  async revealBurnMessage(msgId, isOwn) {
    const card = document.getElementById(`card-${msgId}`);
    const mask = document.getElementById(`burnMask-${msgId}`);
    const textElem = document.getElementById(`burnText-${msgId}`);
    const bar = document.getElementById(`burnBar-${msgId}`);
    if (!card || !mask || !textElem) return;

    if (this.revealedBurnMessages.has(msgId)) return;
    this.revealedBurnMessages.add(msgId);

    const frame = this.burnBinaryStore.get(msgId);
    if (!frame) return;

    try {
      const plainBuffer = await PCrypto.decryptBinary(frame.iv, frame.cipherBuffer, this.currentKey);
      const renderedHtml = this.renderBinaryContentHtml(frame.meta, plainBuffer);

      mask.style.display = 'none';
      textElem.innerHTML = `
        <div style="margin-bottom: 6px;">
          <span style="font-size: 0.72rem; color: var(--accent-red); font-weight: 600;">
            🔥 阅后即焚已激活 ${isOwn ? '(发件人预览模式，不计入读者配额)' : ''}
          </span>
        </div>
        ${renderedHtml}
        <div style="margin-top: 10px; display: flex; justify-content: flex-end;">
          <button class="btn btn-danger btn-sm" style="padding: 3px 8px; font-size: 0.72rem;" onclick="event.stopPropagation(); app.destroyMessageElement('${msgId}', 'user_destroyed_early')">
            <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i> 我已看完 · 立即销毁
          </button>
        </div>
      `;
      textElem.style.display = 'block';
      this.initIcons();

      // Notify server of read action
      PSocket.send('read_burn_message', { msgId: msgId });

      if (!isOwn) {
        const readDurationMs = 15000;
        const startTime = Date.now();
        const interval = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const pct = Math.min(100, (elapsed / readDurationMs) * 100);
          if (bar) bar.style.width = `${pct}%`;

          if (elapsed >= readDurationMs) {
            clearInterval(interval);
            this.destroyMessageElement(msgId, 'local_read_timeout');
          }
        }, 50);
        this.activeBurnIntervals.set(msgId, interval);
      }
    } catch (err) {
      console.error('[PChat] Failed to reveal burn message:', err);
    }
  }

  handleBurnCountdownStarted(payload) {
    const { msgId, durationMs, endAt } = payload;
    const bar = document.getElementById(`burnBar-${msgId}`);
    if (!bar) return;

    if (this.activeBurnIntervals.has(msgId)) {
      clearInterval(this.activeBurnIntervals.get(msgId));
    }

    const startTime = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - startTime;
      const progress = Math.min(100, (elapsed / durationMs) * 100);
      bar.style.width = `${progress}%`;

      if (now >= endAt) {
        clearInterval(interval);
        this.activeBurnIntervals.delete(msgId);
        this.destroyMessageElement(msgId, 'server_timer_done');
      }
    }, 50);

    this.activeBurnIntervals.set(msgId, interval);
  }

  handleBurnProgressUpdated(payload) {
    const { msgId, currentViews, maxViews } = payload;
    const mask = document.getElementById(`burnMask-${msgId}`);
    if (mask && mask.style.display !== 'none') {
      mask.innerHTML = `
        <i data-lucide="eye" style="width: 16px; height: 16px;"></i>
        <span>🔥 已被 ${currentViews}/${maxViews} 人查看 · 点击解密</span>
      `;
      this.initIcons();
    }
  }

  destroyMessageElement(msgId, reason) {
    if (reason === 'quota_exhausted' && this.revealedBurnMessages && this.revealedBurnMessages.has(msgId)) {
      return;
    }

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
    this.burnBinaryStore.delete(msgId);
  }

  openAdminModal() {
    if (!this.isAdmin || !this.currentRoom) return;
    document.getElementById('adminPasswordInput').value = this.currentPassword;
    document.getElementById('adminIsPublic').checked = this.currentRoom.isPublic;
    const enableHistoryToggle = document.getElementById('adminEnableHistory');
    if (enableHistoryToggle) {
      enableHistoryToggle.checked = Boolean(this.currentRoom.enableHistory);
    }
    document.getElementById('adminAllowedIps').value = (this.currentRoom.allowedIps || []).join(', ');
    document.getElementById('adminModal').classList.add('active');
  }

  closeAdminModal() {
    document.getElementById('adminModal').classList.remove('active');
  }

  async submitAdminUpdate() {
    const rawPass = document.getElementById('adminPasswordInput').value;
    const newPass = this.cleanPassword(rawPass);
    let isPublic = document.getElementById('adminIsPublic').checked;
    const enableHistory = document.getElementById('adminEnableHistory').checked;
    const ips = document.getElementById('adminAllowedIps').value.split(',').map(s => s.trim()).filter(Boolean);

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
      enableHistory: enableHistory,
      allowedIps: ips
    });

    this.closeAdminModal();
    alert('✅ 管理员安全配置已更新！');
  }

  clearRoomHistory() {
    if (!confirm('确定要立即清空房间内的所有内存历史缓冲区吗？新进群成员将不再能看到之前的历史消息。')) {
      return;
    }
    PSocket.send('admin_clear_history', {
      adminToken: this.adminToken
    });
    this.closeAdminModal();
    alert('🧹 已发送清空历史缓冲区指令！');
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
    const shareUrl = `${window.location.origin}/#pass=${encodeURIComponent(this.currentPassword)}`;
    const copyText = `【P-Chat 私密群组邀请】\n口令: ${this.currentPassword}\n直达链接: ${shareUrl}`;

    navigator.clipboard.writeText(copyText).then(() => {
      alert(`🔑 口令与直达链接已复制到剪贴板！\n\n${copyText}\n\n群友可直接在首页输入口令，或点击直达链接直接进入。`);
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
