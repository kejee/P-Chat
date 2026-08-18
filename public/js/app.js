/**
 * P-Chat Main Application Controller (v1.3.3)
 * Features:
 * - 256KB Chunked E2EE Stream Engine for Zero Server RAM Footprint
 * - WeChat-Style Optimistic Instant UI with Inline Progress & Failure Retry
 * - Flawless Mobile & iOS Safari VisualViewport Integration
 * - Persistent Identity (localStorage alias) - no identity change on refresh
 * - Silent Reconnection Recovery: room_rejoined does NOT clear chat DOM
 * - Strict Admin Role Verification & Seamless Token Session Recovery
 */

class PChatApp {
  constructor() {
    this.currentRoom = null;
    this.currentKey = null;
    this.currentPassword = '';
    this.isAdmin = false;
    this.adminToken = null;

    // --- FIX: Persistent Identity across page refresh ---
    // Load alias from localStorage, generate only if first visit
    try {
      let savedAlias = localStorage.getItem('pchat_alias');
      if (!savedAlias) {
        savedAlias = 'User-' + Math.floor(100 + Math.random() * 900);
        localStorage.setItem('pchat_alias', savedAlias);
      }
      this.myAlias = savedAlias;
    } catch (e) {
      this.myAlias = 'User-' + Math.floor(100 + Math.random() * 900);
    }

    this.clientIp = '未知';
    this.activePromptRoomId = null;
    this.roomTimerInterval = null;
    this.activeBurnIntervals = new Map(); // msgId -> interval
    this.revealedBurnMessages = new Set(); // msgId set
    this.burnBinaryStore = new Map(); // msgId -> { iv, cipherBuffer, meta }
    this.incomingChunkStore = new Map(); // msgId -> { meta, chunks: [], totalChunks, receivedCount }
    this.pendingRetries = new Map(); // msgId -> messageDataObject
    this.renderedMessageIds = new Set(); // msgId set for deduplication
    this.isPrivacyShieldLocked = false;
    this.pendingAttachment = null; // { name, size, type, mimeType, fileBlob, previewUrl }

    this.init();
  }

  cleanPassword(str) {
    if (!str) return '';
    return String(str).replace(/[\u200B-\u200D\uFEFF\r\n\t]/g, '').trim();
  }

  initViewportHeightSync() {
    const updateRealViewport = () => {
      const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--vh-real', `${vh}px`);
    };

    updateRealViewport();
    window.addEventListener('resize', updateRealViewport, { passive: true });
    window.addEventListener('orientationchange', () => {
      setTimeout(updateRealViewport, 150);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateRealViewport, { passive: true });
      window.visualViewport.addEventListener('scroll', updateRealViewport, { passive: true });
    }
  }

  async init() {
    this.initViewportHeightSync();
    this.initIcons();
    this.initAntiPeek();
    this.initPasteHandler();
    this.generateNewPass();
    this.bindKeyboardShortcuts();
    this.bindMobileKeyboardFocus();
    
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

    // Fetch Public Rooms periodically
    this.fetchPublicRooms();
    setInterval(() => {
      if (!this.currentRoom) {
        this.fetchPublicRooms();
      }
    }, 10000);
  }

  bindMobileKeyboardFocus() {
    const chatInput = document.getElementById('chatMsgInput');
    if (!chatInput) return;

    // Smooth viewport adjustment when virtual keyboard pops on iOS Chrome / Safari
    chatInput.addEventListener('focus', () => {
      setTimeout(() => {
        if (window.visualViewport) {
          const vh = window.visualViewport.height;
          document.documentElement.style.setProperty('--vh-real', `${vh}px`);
        }
        const stream = document.getElementById('messageStream');
        if (stream) stream.scrollTop = stream.scrollHeight;
      }, 100);
    });

    chatInput.addEventListener('blur', () => {
      setTimeout(() => {
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        document.documentElement.style.setProperty('--vh-real', `${vh}px`);
      }, 150);
    });
  }

  bindKeyboardShortcuts() {
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

  // Update Online/Offline Status Indicator (Global Header & Chat Topbar)
  setWsStatus(isOnline) {
    const dot = document.getElementById('wsStatusDot');
    const text = document.getElementById('wsStatusText');
    const chatCapsule = document.getElementById('chatRoomWsCapsule');
    const chatDot = document.getElementById('chatWsDot');
    const chatText = document.getElementById('chatWsText');

    if (isOnline) {
      if (dot) dot.className = 'status-dot online';
      if (text) text.innerText = '安全在线';
      if (chatCapsule) chatCapsule.className = 'chat-status-capsule';
      if (chatDot) chatDot.className = 'status-dot online';
      if (chatText) chatText.innerText = '安全在线';
    } else {
      if (dot) dot.className = 'status-dot';
      if (text) text.innerText = '已断开 (重连中)';
      if (chatCapsule) chatCapsule.className = 'chat-status-capsule offline';
      if (chatDot) chatDot.className = 'status-dot';
      if (chatText) chatText.innerText = '已断开 (点此重连)';
    }
  }

  // Manual Reconnection Handler
  async manualReconnect() {
    const chatText = document.getElementById('chatWsText');
    if (chatText) chatText.innerText = '正在重连...';
    await PSocket.reconnect();
  }

  initAntiPeek() {
    const shield = document.getElementById('privacyShield');
    
    window.addEventListener('blur', () => {
      if (this.currentRoom && this.currentRoom.enableAntiPeek) {
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
        if (this.currentRoom && this.currentRoom.enableAntiPeek) {
          shield.classList.toggle('active');
        }
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
    if (file.size > 100 * 1024 * 1024) {
      return alert('⚠️ 文件体积过大，单次附件请限制在 100MB 以内。');
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
          <div style="font-size: 0.7rem; color: var(--text-muted);">${this.formatFileSize(this.pendingAttachment.size)} · 256KB 微分块流加密就绪</div>
        </div>
      `;
    } else if (this.pendingAttachment.type === 'video') {
      thumb.innerHTML = `
        <i data-lucide="video" style="width: 24px; height: 24px; color: var(--accent-cyan);"></i>
        <div>
          <div style="font-weight: 600;">已选定视频: ${this.escapeHtml(this.pendingAttachment.name)}</div>
          <div style="font-size: 0.7rem; color: var(--text-muted);">${this.formatFileSize(this.pendingAttachment.size)} · 256KB 微分块流加密就绪</div>
        </div>
      `;
    } else {
      thumb.innerHTML = `
        <i data-lucide="file" style="width: 24px; height: 24px; color: var(--accent-cyan);"></i>
        <div>
          <div style="font-weight: 600;">已选定文件: ${this.escapeHtml(this.pendingAttachment.name)}</div>
          <div style="font-size: 0.7rem; color: var(--text-muted);">${this.formatFileSize(this.pendingAttachment.size)} · 256KB 微分块流加密就绪</div>
        </div>
      `;
    }
    this.initIcons();
  }

  clearAttachment(shouldRevoke = false) {
    if (shouldRevoke && this.pendingAttachment && this.pendingAttachment.previewUrl) {
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
    PSocket.on('connected', () => {
      this.setWsStatus(true);
      // --- FIX: Silent reconnection - auto rejoin without clearing DOM ---
      if (this.currentRoom && this.currentRoom.id && this.currentKey) {
        this.performAutoRejoin();
      }
    });

    PSocket.on('disconnected', () => {
      this.setWsStatus(false);
    });

    // Handle Incoming Binary Frames (Single Packet or 256KB Chunk Stream)
    PSocket.on('binary_message', async (arrayBuffer) => {
      await this.dispatchIncomingBinaryFrame(arrayBuffer);
    });

    PSocket.on('room_created', (payload) => {
      this.currentRoom = payload;
      this.isAdmin = true;
      this.adminToken = payload.adminToken;
      try {
        sessionStorage.setItem('admin_token_' + payload.roomId, payload.adminToken);
      } catch (e) {}
      this.enterChatRoomUI(false);
    });

    PSocket.on('room_joined', (payload) => {
      this.currentRoom = payload;
      this.isAdmin = Boolean(payload.isAdmin);
      this.adminToken = payload.adminToken || null;
      if (this.isAdmin && this.adminToken) {
        try {
          sessionStorage.setItem('admin_token_' + payload.roomId, payload.adminToken);
        } catch (e) {}
      }
      this.enterChatRoomUI(false);
    });

    // --- FIX: room_rejoined = silent reconnect, DO NOT clear the chat DOM ---
    PSocket.on('room_rejoined', (payload) => {
      this.currentRoom = payload;
      this.isAdmin = Boolean(payload.isAdmin);
      this.adminToken = payload.adminToken || null;
      if (this.isAdmin && this.adminToken) {
        try {
          sessionStorage.setItem('admin_token_' + payload.roomId, payload.adminToken);
        } catch (e) {}
      }
      this.silentRejoinUI();
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
        this.currentRoom.enableAntiPeek = payload.enableAntiPeek;
        this.currentRoom.allowedIps = payload.allowedIps;
        this.updateRoomBadge();

        if (!this.currentRoom.enableAntiPeek) {
          const shield = document.getElementById('privacyShield');
          if (shield) shield.classList.remove('active');
          this.isPrivacyShieldLocked = false;
        }
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

  async performAutoRejoin() {
    const savedAdminToken = this.adminToken || sessionStorage.getItem('admin_token_' + this.currentRoom.id);
    const passHash = this.currentPassword ? await PCrypto.sha256(this.currentPassword) : null;

    // --- FIX: Send isRejoin:true so server returns room_rejoined (silent, no DOM clear) ---
    PSocket.send('join_room', {
      roomId: this.currentRoom.id,
      passHash: passHash,
      alias: this.myAlias,
      adminToken: savedAdminToken || null,
      isRejoin: true
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
    const enableAntiPeekCheck = document.getElementById('createEnableAntiPeek');
    const durationSelect = document.getElementById('createDestroyDuration');
    const ipsInput = document.getElementById('createAllowedIps');

    const name = nameInput.value.trim() || '未命名群组';
    const rawPassword = passInput.value;
    const password = this.cleanPassword(rawPassword);
    let isPublic = isPublicCheck.checked;
    const enableHistory = enableHistoryCheck ? enableHistoryCheck.checked : true;
    const enableAntiPeek = enableAntiPeekCheck ? enableAntiPeekCheck.checked : true;

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
      enableAntiPeek: enableAntiPeek,
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
        const savedToken = sessionStorage.getItem('admin_token_' + roomId);
        PSocket.send('join_room', {
          roomId: roomId,
          passHash: null,
          alias: this.myAlias,
          adminToken: savedToken || null
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
    const savedToken = sessionStorage.getItem('admin_token_' + this.activePromptRoomId);

    PSocket.send('join_room', {
      roomId: this.activePromptRoomId,
      passHash: passHash,
      alias: this.myAlias,
      adminToken: savedToken || null
    });

    this.closePasswordPrompt();
  }

  enterChatRoomUI(isSilentRejoin = false) {
    document.body.classList.add('in-chat-view');
    document.getElementById('lobbyView').classList.remove('active');
    document.getElementById('chatView').classList.add('active');

    document.getElementById('btnLeaveRoom').style.display = 'inline-flex';

    // Strict Admin Button Visibility: ONLY show buttons if user is verified Admin
    const desktopAdminBtn = document.getElementById('btnDesktopAdmin');
    if (desktopAdminBtn) desktopAdminBtn.style.display = this.isAdmin ? 'inline-flex' : 'none';
    const mobileAdminBtn = document.getElementById('btnMobileAdmin');
    if (mobileAdminBtn) mobileAdminBtn.style.display = this.isAdmin ? 'inline-flex' : 'none';

    document.getElementById('activeRoomName').innerText = this.currentRoom.name;
    this.updateRoomBadge();
    this.startRoomCountdown();

    if (!isSilentRejoin) {
      // Full fresh entry: clear the DOM and start over
      this.clearAttachment();
      this.renderedMessageIds.clear();
      document.getElementById('messageStream').innerHTML = `
        <div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; margin: 12px 0;">
          🔒 256KB 微分块流式端到端加密隧道已就绪 · 服务端零内存积压 · 零写盘
        </div>
      `;
      this.initIcons();
    }

    // Trigger History Fetch after UI & CryptoKey are ready
    // When silentRejoin: renderedMessageIds still has old IDs, so dedup prevents re-rendering existing messages
    if (this.currentRoom.enableHistory) {
      setTimeout(() => {
        PSocket.send('fetch_history');
      }, 50);
    }
  }

  // --- FIX: Silent rejoin after reconnect - keeps existing chat DOM, just re-syncs state ---
  silentRejoinUI() {
    // Update admin button visibility in case state changed
    const desktopAdminBtn = document.getElementById('btnDesktopAdmin');
    if (desktopAdminBtn) desktopAdminBtn.style.display = this.isAdmin ? 'inline-flex' : 'none';
    const mobileAdminBtn = document.getElementById('btnMobileAdmin');
    if (mobileAdminBtn) mobileAdminBtn.style.display = this.isAdmin ? 'inline-flex' : 'none';

    // Show a subtle "reconnected" notification in the stream without clearing it
    const stream = document.getElementById('messageStream');
    if (stream) {
      const notice = document.createElement('div');
      notice.className = 'history-divider';
      notice.style.borderColor = 'rgba(0, 229, 255, 0.25)';
      notice.innerHTML = `<span style="color: var(--accent-cyan); font-size: 0.72rem;">🔄 重连成功 · 正在同步最新消息...</span>`;
      stream.appendChild(notice);
      stream.scrollTop = stream.scrollHeight;
    }

    // Pull any messages received while disconnected (dedup via renderedMessageIds)
    if (this.currentRoom && this.currentRoom.enableHistory) {
      setTimeout(() => {
        PSocket.send('fetch_history');
      }, 50);
    }
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
    document.body.classList.remove('in-chat-view');
    if (this.roomTimerInterval) clearInterval(this.roomTimerInterval);
    this.currentRoom = null;
    this.currentKey = null;
    this.currentPassword = '';
    this.isAdmin = false;
    this.adminToken = null;
    this.revealedBurnMessages = new Set();
    this.burnBinaryStore.clear();
    this.incomingChunkStore.clear();
    this.pendingRetries.clear();
    this.renderedMessageIds.clear();
    this.clearAttachment(true);

    document.getElementById('chatView').classList.remove('active');
    document.getElementById('lobbyView').classList.add('active');

    document.getElementById('btnLeaveRoom').style.display = 'none';
    const desktopAdminBtn = document.getElementById('btnDesktopAdmin');
    if (desktopAdminBtn) desktopAdminBtn.style.display = 'none';
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

  /**
   * WeChat-Style Instant Send with Optimistic UI & 256KB Chunked Streaming
   */
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

    const msgId = 'msg-' + Math.random().toString(36).substring(2, 11);
    const messageData = {
      msgId: msgId,
      text: text,
      attachment: attachment ? { ...attachment } : null,
      isBurn: isBurn,
      burnConfig: burnConfig,
      timestamp: Date.now()
    };

    // 1. Instant Optimistic UI: Render bubble immediately into stream
    this.renderOptimisticSendingBubble(messageData);

    // 2. Clear inputs immediately & keep preview URL alive
    input.value = '';
    this.clearAttachment(false);
    input.focus();

    // 3. Pump transmission pipeline
    this.executeSendPipeline(messageData);
  }

  renderOptimisticSendingBubble(messageData) {
    const stream = document.getElementById('messageStream');
    const timeStr = new Date(messageData.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble own';
    bubble.id = messageData.msgId;

    let contentHtml = '';
    if (messageData.attachment) {
      const att = messageData.attachment;
      if (att.type === 'image') {
        contentHtml += `<img src="${att.previewUrl}" class="media-img-preview" alt="发送预览" onclick="app.openLightbox('${att.previewUrl}')">`;
      } else if (att.type === 'video') {
        contentHtml += `<video src="${att.previewUrl}" class="media-video-player" controls preload="metadata" playsinline webkit-playsinline></video>`;
      } else {
        contentHtml += `
          <div class="file-attachment-card">
            <div class="file-icon-box"><i data-lucide="file" style="width: 20px; height: 20px;"></i></div>
            <div class="file-info-text">
              <span class="file-name-text">${this.escapeHtml(att.name)}</span>
              <span class="file-size-text">${this.formatFileSize(att.size)}</span>
            </div>
          </div>
        `;
      }
    }

    if (messageData.text) {
      contentHtml += `<div style="white-space: pre-wrap; ${messageData.attachment ? 'margin-top: 8px;' : ''}">${this.escapeHtml(messageData.text)}</div>`;
    }

    bubble.innerHTML = `
      <div class="msg-meta">
        <span>${this.escapeHtml(this.myAlias)}</span>
        <span>${timeStr}</span>
        <span class="msg-sending-tag" id="statusTag-${messageData.msgId}">
          <i data-lucide="loader-2" class="spin-anim" style="width: 10px; height: 10px;"></i> 正在加密发送...
        </span>
      </div>
      <div class="msg-content-card" id="contentCard-${messageData.msgId}">
        ${contentHtml}
        <div class="msg-inline-status" id="inlineStatus-${messageData.msgId}">
          <div style="display: flex; justify-content: space-between; font-size: 0.7rem;">
            <span id="progressText-${messageData.msgId}">正在准备微流加密...</span>
            <span id="progressPercent-${messageData.msgId}">0%</span>
          </div>
          <div class="msg-progress-track">
            <div class="msg-progress-fill" id="progressFill-${messageData.msgId}" style="width: 0%;"></div>
          </div>
        </div>
      </div>
    `;

    stream.appendChild(bubble);
    stream.scrollTop = stream.scrollHeight;
    this.renderedMessageIds.add(messageData.msgId);
    this.initIcons();
  }

  updateBubbleProgress(msgId, percent, statusText) {
    const fill = document.getElementById(`progressFill-${msgId}`);
    const pct = document.getElementById(`progressPercent-${msgId}`);
    const txt = document.getElementById(`progressText-${msgId}`);
    if (fill) fill.style.width = `${percent}%`;
    if (pct) pct.innerText = `${percent}%`;
    if (txt) txt.innerText = statusText;
  }

  markBubbleSuccess(msgId) {
    const inlineStatus = document.getElementById(`inlineStatus-${msgId}`);
    const statusTag = document.getElementById(`statusTag-${msgId}`);
    if (inlineStatus) inlineStatus.style.display = 'none';
    if (statusTag) {
      statusTag.innerHTML = `<span style="color: var(--accent-green);">已送达</span>`;
      setTimeout(() => {
        if (statusTag) statusTag.style.display = 'none';
      }, 2000);
    }
  }

  markBubbleFailed(msgId, errMessage) {
    const inlineStatus = document.getElementById(`inlineStatus-${msgId}`);
    const statusTag = document.getElementById(`statusTag-${msgId}`);
    if (statusTag) {
      statusTag.innerHTML = `<span style="color: var(--accent-red); font-weight: bold;">⚠️ 发送失败</span>`;
    }
    if (inlineStatus) {
      inlineStatus.innerHTML = `
        <div class="msg-failed-wrapper">
          <span>❌ 发送中断 (${this.escapeHtml(errMessage || '网络异常')})</span>
          <button class="msg-retry-btn" onclick="app.retrySendMessage('${msgId}')">
            <i data-lucide="rotate-cw" style="width: 10px; height: 10px;"></i> 重试
          </button>
        </div>
      `;
      this.initIcons();
    }
  }

  retrySendMessage(msgId) {
    const messageData = this.pendingRetries.get(msgId);
    if (!messageData) return;

    const inlineStatus = document.getElementById(`inlineStatus-${msgId}`);
    const statusTag = document.getElementById(`statusTag-${msgId}`);
    if (statusTag) {
      statusTag.innerHTML = `<i data-lucide="loader-2" class="spin-anim" style="width: 10px; height: 10px;"></i> 正在重新发送...`;
    }
    if (inlineStatus) {
      inlineStatus.innerHTML = `
        <div style="display: flex; justify-content: space-between; font-size: 0.7rem;">
          <span id="progressText-${msgId}">重新加密传输中...</span>
          <span id="progressPercent-${msgId}">0%</span>
        </div>
        <div class="msg-progress-track">
          <div class="msg-progress-fill" id="progressFill-${msgId}" style="width: 0%;"></div>
        </div>
      `;
      this.initIcons();
    }

    this.executeSendPipeline(messageData);
  }

  async executeSendPipeline(messageData) {
    const { msgId, text, attachment, isBurn, burnConfig, timestamp } = messageData;
    this.pendingRetries.set(msgId, messageData);

    try {
      if (!PSocket.isConnected) {
        throw new Error('网络连接已断开，请检查网络');
      }

      const hasMedia = Boolean(attachment);
      const CHUNK_SIZE = PCrypto.CHUNK_SIZE;

      if (!hasMedia || attachment.size <= CHUNK_SIZE) {
        this.updateBubbleProgress(msgId, 30, '正在生成 AES-256-GCM 密文...');

        let payloadBuffer;
        let meta = {
          msgId: msgId,
          senderAlias: this.myAlias,
          timestamp: timestamp,
          isBurn: isBurn,
          burnConfig: burnConfig,
          text: text || '',
          hasMedia: hasMedia
        };

        if (hasMedia) {
          meta.mediaMeta = {
            name: attachment.name,
            size: attachment.size,
            type: attachment.type,
            mimeType: attachment.mimeType
          };
          payloadBuffer = await attachment.fileBlob.arrayBuffer();
        } else {
          payloadBuffer = new TextEncoder().encode(text);
        }

        const packet = await PCrypto.packBinaryFrame(meta, payloadBuffer, this.currentKey);
        this.updateBubbleProgress(msgId, 80, '正在极速传输...');

        PSocket.sendBinary(packet);
        this.updateBubbleProgress(msgId, 100, '发送完成');
        this.markBubbleSuccess(msgId);
        this.pendingRetries.delete(msgId);
        return;
      }

      const totalChunks = Math.ceil(attachment.size / CHUNK_SIZE);
      const fileBlob = attachment.fileBlob;

      for (let i = 0; i < totalChunks; i++) {
        if (!PSocket.isConnected) {
          throw new Error('传输过程中连接中断');
        }

        const start = i * CHUNK_SIZE;
        const end = Math.min(attachment.size, start + CHUNK_SIZE);
        const sliceBlob = fileBlob.slice(start, end);
        const chunkArrayBuffer = await sliceBlob.arrayBuffer();

        const chunkMeta = {
          msgId: msgId,
          senderAlias: this.myAlias,
          timestamp: timestamp,
          isBurn: isBurn,
          burnConfig: burnConfig,
          text: (i === 0) ? (text || '') : '',
          chunkIndex: i,
          totalChunks: totalChunks,
          isLast: (i === totalChunks - 1),
          mediaMeta: {
            name: attachment.name,
            size: attachment.size,
            type: attachment.type,
            mimeType: attachment.mimeType
          }
        };

        const chunkPacket = await PCrypto.packChunkFrame(chunkMeta, chunkArrayBuffer, this.currentKey);
        PSocket.sendBinary(chunkPacket);

        const currentPct = Math.round(((i + 1) / totalChunks) * 100);
        this.updateBubbleProgress(msgId, currentPct, `正在分块加密传输 (${i + 1}/${totalChunks} 块)...`);

        if (totalChunks > 4 && i % 2 === 0) {
          await new Promise(r => setTimeout(r, 8));
        }
      }

      this.updateBubbleProgress(msgId, 100, '传输完成！');
      this.markBubbleSuccess(msgId);
      this.pendingRetries.delete(msgId);
    } catch (err) {
      console.error('[PChat] Send pipeline failed:', err);
      this.markBubbleFailed(msgId, err.message || '网络中断');
    }
  }

  async dispatchIncomingBinaryFrame(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 20) return;

    if (view.getUint8(0) === 0x50 && view.getUint8(1) === 0x43 &&
        view.getUint8(2) === 0x48 && view.getUint8(3) === 0x54) {
      await this.handleIncomingSingleFrame(arrayBuffer);
      return;
    }

    if (view.getUint8(0) === 0x50 && view.getUint8(1) === 0x43 &&
        view.getUint8(2) === 0x43 && view.getUint8(3) === 0x4B) {
      await this.handleIncomingChunkFrame(arrayBuffer);
      return;
    }
  }

  async handleIncomingSingleFrame(arrayBuffer) {
    try {
      const frame = PCrypto.unpackBinaryFrame(arrayBuffer);
      if (!frame) return;

      const { iv, meta, cipherBuffer } = frame;
      const msgId = meta.msgId;

      // Prevent duplicate rendering
      if (this.renderedMessageIds.has(msgId)) return;
      this.renderedMessageIds.add(msgId);

      const stream = document.getElementById('messageStream');
      const isOwn = meta.senderAlias.includes(this.myAlias);
      const timeStr = new Date(meta.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const bubble = document.createElement('div');
      bubble.className = `msg-bubble ${isOwn ? 'own' : 'peer'}`;
      bubble.id = msgId;

      if (meta.isBurn) {
        this.burnBinaryStore.set(msgId, { iv, cipherBuffer, meta, isChunked: false });
        const burnHint = meta.burnConfig?.type === 'views'
          ? `🔥 阅后即焚 (限 ${meta.burnConfig.maxViews} 人查看)`
          : `🔥 阅后即焚 (查看后 ${meta.burnConfig.viewDurationSec} 秒自毁)`;

        bubble.innerHTML = `
          <div class="msg-meta">
            <span>${this.escapeHtml(meta.senderAlias)}</span>
            <span>${timeStr}</span>
          </div>
          <div class="msg-content-card msg-burn-card" id="card-${msgId}" onclick="app.revealBurnMessage('${msgId}', ${isOwn})">
            <div class="burn-shield-overlay" id="burnMask-${msgId}">
              <i data-lucide="eye" style="width: 16px; height: 16px;"></i>
              <span>${burnHint} · ${isOwn ? '发件人点击预览' : '点击解密查看'}</span>
            </div>
            <div class="burn-text" id="burnText-${msgId}" style="display: none;"></div>
            <div class="burn-timer-bar" id="burnBar-${msgId}" style="width: 0%;"></div>
          </div>
        `;
      } else {
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
      console.error('[PChat] Decrypt single frame failed:', err);
    }
  }

  async handleIncomingChunkFrame(arrayBuffer) {
    try {
      const frame = PCrypto.unpackChunkFrame(arrayBuffer);
      if (!frame) return;

      const { iv, meta, cipherBuffer } = frame;
      const msgId = meta.msgId;
      const isOwn = meta.senderAlias.includes(this.myAlias);
      const stream = document.getElementById('messageStream');
      const timeStr = new Date(meta.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      if (meta.isBurn) {
        let burnRecord = this.burnBinaryStore.get(msgId);
        if (!burnRecord) {
          burnRecord = {
            meta: meta,
            isChunked: true,
            totalChunks: meta.totalChunks,
            chunks: new Array(meta.totalChunks)
          };
          this.burnBinaryStore.set(msgId, burnRecord);

          const burnBubble = document.createElement('div');
          burnBubble.className = `msg-bubble ${isOwn ? 'own' : 'peer'}`;
          burnBubble.id = msgId;

          const burnHint = meta.burnConfig?.type === 'views'
            ? `🔥 阅后即焚 (限 ${meta.burnConfig.maxViews} 人查看)`
            : `🔥 阅后即焚 (查看后 ${meta.burnConfig.viewDurationSec} 秒自毁)`;

          burnBubble.innerHTML = `
            <div class="msg-meta">
              <span>${this.escapeHtml(meta.senderAlias)}</span>
              <span>${timeStr}</span>
            </div>
            <div class="msg-content-card msg-burn-card" id="card-${msgId}" onclick="app.revealBurnMessage('${msgId}', ${isOwn})">
              <div class="burn-shield-overlay" id="burnMask-${msgId}">
                <i data-lucide="eye" style="width: 16px; height: 16px;"></i>
                <span>${burnHint} · ${isOwn ? '发件人点击预览' : '点击解密查看'}</span>
              </div>
              <div class="burn-text" id="burnText-${msgId}" style="display: none;"></div>
              <div class="burn-timer-bar" id="burnBar-${msgId}" style="width: 0%;"></div>
            </div>
          `;
          stream.appendChild(burnBubble);
          stream.scrollTop = stream.scrollHeight;
          this.initIcons();
        }

        burnRecord.chunks[meta.chunkIndex] = { iv, cipherBuffer };
        return;
      }

      let session = this.incomingChunkStore.get(msgId);
      if (!session) {
        session = {
          meta: meta,
          totalChunks: meta.totalChunks,
          receivedCount: 0,
          plainChunks: new Array(meta.totalChunks)
        };
        this.incomingChunkStore.set(msgId, session);

        const bubble = document.createElement('div');
        bubble.className = `msg-bubble ${isOwn ? 'own' : 'peer'}`;
        bubble.id = msgId;

        bubble.innerHTML = `
          <div class="msg-meta">
            <span>${this.escapeHtml(meta.senderAlias)}</span>
            <span>${timeStr}</span>
          </div>
          <div class="msg-content-card" id="card-${msgId}">
            <div id="chunkStreamBody-${msgId}">
              <div style="font-weight: 600; margin-bottom: 4px;">📥 正在接收加密附件: ${this.escapeHtml(meta.mediaMeta?.name || '媒体文件')}</div>
              <div style="font-size: 0.72rem; color: var(--text-muted);">${this.formatFileSize(meta.mediaMeta?.size || 0)} · 256KB 微分块流</div>
            </div>
            <div class="msg-inline-status" id="chunkProgress-${msgId}">
              <div style="display: flex; justify-content: space-between; font-size: 0.7rem;">
                <span id="chunkProgTxt-${msgId}">正在解密数据块...</span>
                <span id="chunkProgPct-${msgId}">0%</span>
              </div>
              <div class="msg-progress-track">
                <div class="msg-progress-fill" id="chunkProgFill-${msgId}" style="width: 0%;"></div>
              </div>
            </div>
          </div>
        `;
        stream.appendChild(bubble);
        stream.scrollTop = stream.scrollHeight;
        this.initIcons();
      }

      const decryptedChunk = await PCrypto.decryptBinary(iv, cipherBuffer, this.currentKey);
      session.plainChunks[meta.chunkIndex] = decryptedChunk;
      session.receivedCount += 1;

      const pct = Math.round((session.receivedCount / session.totalChunks) * 100);
      const fill = document.getElementById(`chunkProgFill-${msgId}`);
      const pctText = document.getElementById(`chunkProgPct-${msgId}`);
      const txt = document.getElementById(`chunkProgTxt-${msgId}`);
      if (fill) fill.style.width = `${pct}%`;
      if (pctText) pctText.innerText = `${pct}%`;
      if (txt) txt.innerText = `正在分块解密 (${session.receivedCount}/${session.totalChunks} 块)...`;

      if (session.receivedCount === session.totalChunks) {
        let mime = meta.mediaMeta?.mimeType || 'application/octet-stream';
        if (meta.mediaMeta?.type === 'video' && (!mime || mime === 'video/quicktime' || mime.includes('quicktime'))) {
          mime = 'video/mp4';
        }
        const fullBlob = new Blob(session.plainChunks, { type: mime });
        const blobUrl = URL.createObjectURL(fullBlob);
        const card = document.getElementById(`card-${msgId}`);
        if (card) {
          let html = '';
          if (meta.mediaMeta.type === 'image') {
            html += `<img src="${blobUrl}" class="media-img-preview" alt="加密图片" onclick="app.openLightbox('${blobUrl}')" title="点击放大查看">`;
          } else if (meta.mediaMeta.type === 'video') {
            html += `<video src="${blobUrl}" class="media-video-player" controls preload="metadata" playsinline webkit-playsinline></video>`;
          } else {
            html += `
              <a href="${blobUrl}" download="${this.escapeHtml(meta.mediaMeta.name)}" class="file-attachment-card" title="点击下载">
                <div class="file-icon-box"><i data-lucide="file-down" style="width: 20px; height: 20px;"></i></div>
                <div class="file-info-text">
                  <span class="file-name-text">${this.escapeHtml(meta.mediaMeta.name)}</span>
                  <span class="file-size-text">${this.formatFileSize(meta.mediaMeta.size)} · 点击安全下载</span>
                </div>
              </a>
            `;
          }

          if (meta.text) {
            html += `<div style="white-space: pre-wrap; margin-top: 8px;">${this.escapeHtml(meta.text)}</div>`;
          }

          card.innerHTML = html;
          this.initIcons();
        }
        this.incomingChunkStore.delete(msgId);
      }
    } catch (err) {
      console.error('[PChat] Decrypt chunk frame failed:', err);
    }
  }

  renderBinaryContentHtml(meta, plainBuffer) {
    let html = '';

    if (meta.hasMedia && meta.mediaMeta) {
      let mime = meta.mediaMeta.mimeType || 'application/octet-stream';
      if (meta.mediaMeta.type === 'video' && (!mime || mime === 'video/quicktime' || mime.includes('quicktime'))) {
        mime = 'video/mp4';
      }
      const blob = new Blob([plainBuffer], { type: mime });
      const blobUrl = URL.createObjectURL(blob);

      if (meta.mediaMeta.type === 'image') {
        html += `<img src="${blobUrl}" class="media-img-preview" alt="加密图片" onclick="app.openLightbox('${blobUrl}')" title="点击放大查看">`;
      } else if (meta.mediaMeta.type === 'video') {
        html += `<video src="${blobUrl}" class="media-video-player" controls preload="metadata" playsinline webkit-playsinline></video>`;
      } else {
        html += `
          <a href="${blobUrl}" download="${this.escapeHtml(meta.mediaMeta.name)}" class="file-attachment-card" title="点击解密下载">
            <div class="file-icon-box"><i data-lucide="file-down" style="width: 20px; height: 20px;"></i></div>
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

    const record = this.burnBinaryStore.get(msgId);
    if (!record) return;

    try {
      let renderedHtml = '';
      if (record.isChunked) {
        const plainChunks = [];
        for (const c of record.chunks) {
          if (c) {
            const dec = await PCrypto.decryptBinary(c.iv, c.cipherBuffer, this.currentKey);
            plainChunks.push(dec);
          }
        }
        let mime = record.meta.mediaMeta?.mimeType || 'application/octet-stream';
        if (record.meta.mediaMeta?.type === 'video' && (!mime || mime === 'video/quicktime' || mime.includes('quicktime'))) {
          mime = 'video/mp4';
        }
        const fullBlob = new Blob(plainChunks, { type: mime });
        const blobUrl = URL.createObjectURL(fullBlob);

        if (record.meta.mediaMeta.type === 'image') {
          renderedHtml += `<img src="${blobUrl}" class="media-img-preview" alt="阅后即焚图片" onclick="app.openLightbox('${blobUrl}')">`;
        } else if (record.meta.mediaMeta.type === 'video') {
          renderedHtml += `<video src="${blobUrl}" class="media-video-player" controls autoplay playsinline webkit-playsinline></video>`;
        } else {
          renderedHtml += `
            <a href="${blobUrl}" download="${this.escapeHtml(record.meta.mediaMeta.name)}" class="file-attachment-card">
              <div class="file-icon-box"><i data-lucide="file-down" style="width: 20px; height: 20px;"></i></div>
              <div class="file-info-text">
                <span class="file-name-text">${this.escapeHtml(record.meta.mediaMeta.name)}</span>
                <span class="file-size-text">${this.formatFileSize(record.meta.mediaMeta.size)}</span>
              </div>
            </a>
          `;
        }
        if (record.meta.text) {
          renderedHtml += `<div style="white-space: pre-wrap; margin-top: 8px;">${this.escapeHtml(record.meta.text)}</div>`;
        }
      } else {
        const plainBuffer = await PCrypto.decryptBinary(record.iv, record.cipherBuffer, this.currentKey);
        renderedHtml = this.renderBinaryContentHtml(record.meta, plainBuffer);
      }

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

      PSocket.send('read_burn_message', { msgId: msgId });

      if (!isOwn) {
        let readDurationSec = record.meta?.burnConfig?.viewDurationSec || 10;
        
        // Industry Standard: If content is a video, dynamically adapt burn countdown to (video duration + 3s buffer)
        const videoElement = textElem.querySelector('video');
        const startCountdown = (durationSeconds) => {
          const readDurationMs = durationSeconds * 1000;
          const startTime = Date.now();
          if (this.activeBurnIntervals.has(msgId)) {
            clearInterval(this.activeBurnIntervals.get(msgId));
          }
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
        };

        if (videoElement) {
          videoElement.addEventListener('loadedmetadata', () => {
            const vidSec = Math.ceil(videoElement.duration || 0);
            if (vidSec > 0) {
              const adaptedSec = Math.max(readDurationSec, vidSec + 3);
              startCountdown(adaptedSec);
            }
          }, { once: true });
          startCountdown(Math.max(readDurationSec, 15)); // Default fallback
        } else {
          startCountdown(readDurationSec);
        }
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
    this.incomingChunkStore.delete(msgId);
  }

  openAdminModal() {
    if (!this.isAdmin || !this.currentRoom) return;
    document.getElementById('adminPasswordInput').value = this.currentPassword;
    document.getElementById('adminIsPublic').checked = this.currentRoom.isPublic;
    const enableHistoryToggle = document.getElementById('adminEnableHistory');
    if (enableHistoryToggle) {
      enableHistoryToggle.checked = Boolean(this.currentRoom.enableHistory);
    }
    const enableAntiPeekToggle = document.getElementById('adminEnableAntiPeek');
    if (enableAntiPeekToggle) {
      enableAntiPeekToggle.checked = this.currentRoom.enableAntiPeek !== undefined ? Boolean(this.currentRoom.enableAntiPeek) : true;
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
    const enableAntiPeek = document.getElementById('adminEnableAntiPeek').checked;
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
      enableAntiPeek: enableAntiPeek,
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
