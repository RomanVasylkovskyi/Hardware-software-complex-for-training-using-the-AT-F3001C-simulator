/**
 * Telemetry Source & Flight Replay Settings Manager
 * Handles switching between:
 * 1. Live X-Plane 11 UDP Broadcast
 * 2. Remote Server Flight Replay (telemetry_essential.csv, Data.txt)
 * 3. Local Flight File Upload from Instructor's PC (.csv / .txt)
 */

class TelemetrySettingsManager {
  constructor() {
    this.cardEl = document.getElementById('card-settings');
    this.headerBadge = document.getElementById('hdr-source-indicator');
    this.modeSelect = document.getElementById('settings-mode-select');

    // Mode Views
    this.views = {
      live: document.getElementById('view-mode-live'),
      'server-file': document.getElementById('view-mode-server'),
      'local-file': document.getElementById('view-mode-local'),
    };

    // State
    this.currentMode = 'live'; // 'live' or 'replay'
    this.selectedMode = 'live';
    this.currentReplaySource = null; // 'server' | 'local' | null
    this.isReplayRunning = false;
    this.serverSpeed = 1.0;
    this.serverLoop = true;
    this.localSpeed = 1.0;
    this.localLoop = true;
    this.selectedLocalFile = null;
    this.availableServerFiles = [];
    this.statusPollInterval = null;

    this.bindEvents();
    this.fetchInitialStatus();
    this.fetchServerFiles();
  }

  bindEvents() {
    // Mode Dropdown Switcher
    if (this.modeSelect) {
      this.modeSelect.addEventListener('change', (e) => {
        this.switchMode(e.target.value, true);
      });
    }

    // --- TAB 2: Server File Controls ---
    const selectServerFile = document.getElementById('select-server-file');
    if (selectServerFile) {
      selectServerFile.addEventListener('change', (e) => this.onServerFileSelected(e.target.value));
    }

    const btnRefreshFiles = document.getElementById('btn-refresh-files');
    if (btnRefreshFiles) {
      btnRefreshFiles.addEventListener('click', () => this.fetchServerFiles());
    }

    const serverLoopChk = document.getElementById('server-loop-chk');
    if (serverLoopChk) {
      serverLoopChk.addEventListener('change', (e) => {
        this.serverLoop = e.target.checked;
      });
    }

    const btnStartServerReplay = document.getElementById('btn-start-server-replay');
    if (btnStartServerReplay) {
      btnStartServerReplay.addEventListener('click', () => this.startServerReplay());
    }

    const btnStopServerReplay = document.getElementById('btn-stop-server-replay');
    if (btnStopServerReplay) {
      btnStopServerReplay.addEventListener('click', () => this.stopReplay());
    }

    // --- TAB 3: Local File Controls ---
    const dropZone = document.getElementById('file-drop-zone');
    const fileInput = document.getElementById('local-file-input');

    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());

      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-active');
      });

      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-active');
      });

      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-active');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          this.handleLocalFile(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.handleLocalFile(e.target.files[0]);
        }
      });
    }

    const btnRemoveSelected = document.getElementById('btn-remove-selected-file');
    if (btnRemoveSelected) {
      btnRemoveSelected.addEventListener('click', (e) => {
        e.stopPropagation();
        this.clearSelectedLocalFile();
      });
    }

    const localLoopChk = document.getElementById('local-loop-chk');
    if (localLoopChk) {
      localLoopChk.addEventListener('change', (e) => {
        this.localLoop = e.target.checked;
      });
    }

    const btnUploadAndPlay = document.getElementById('btn-upload-and-play');
    if (btnUploadAndPlay) {
      btnUploadAndPlay.addEventListener('click', () => this.uploadAndPlayLocalFile());
    }

    const btnStopLocalReplay = document.getElementById('btn-stop-local-replay');
    if (btnStopLocalReplay) {
      btnStopLocalReplay.addEventListener('click', () => this.stopReplay());
    }
  }

  onViewActivated() {
    this.fetchServerFiles();
    this.fetchReplayStatus();
  }

  open() {
    if (window.app && typeof window.app.setView === 'function') {
      window.app.setView('settings');
    }
  }

  close() {
    if (window.app && typeof window.app.setView === 'function') {
      window.app.setView('all');
    }
  }

  switchMode(modeId, fromUser = false) {
    if (!modeId) return;
    this.selectedMode = modeId;

    if (!this.modeSelect) {
      this.modeSelect = document.getElementById('settings-mode-select');
    }
    if (this.modeSelect && this.modeSelect.value !== modeId) {
      this.modeSelect.value = modeId;
    }

    if (!this.views || !this.views.live) {
      this.views = {
        live: document.getElementById('view-mode-live'),
        'server-file': document.getElementById('view-mode-server'),
        'local-file': document.getElementById('view-mode-local'),
      };
    }

    Object.keys(this.views).forEach(key => {
      const view = this.views[key];
      if (view) {
        if (key === modeId) {
          view.classList.remove('hidden');
          view.classList.add('active');
        } else {
          view.classList.add('hidden');
          view.classList.remove('active');
        }
      }
    });

    if (fromUser) {
      if (modeId === 'live') {
        // Explicitly switch to Live UDP mode: stop any active replay immediately
        this.activateLiveMode();
      } else if (modeId === 'server-file') {
        // If local file replay was running, stop it when user intentionally switches to server file mode
        if (this.isReplayRunning && this.currentReplaySource === 'local') {
          this.stopReplay();
        }
      } else if (modeId === 'local-file') {
        // If server file replay was running, stop it when user intentionally switches to local file mode
        if (this.isReplayRunning && this.currentReplaySource === 'server') {
          this.stopReplay();
        }
      }
    }
    this.updateControlsState();
  }

  updateHeaderSourceBadge(opts = {}) {
    if (!this.headerBadge) {
      this.headerBadge = document.getElementById('hdr-source-indicator');
    }
    if (!this.headerBadge) return;

    const { isReplay = false, isLive = false, fileName = '', progressPct = null, source = null } = opts;

    if (isReplay) {
      this.headerBadge.className = 'source-mode-tag replay';
      const effectiveSource = source || this.currentReplaySource;
      const srcLabel = effectiveSource === 'local' ? 'ПК' : 'СЕРВЕР';
      const fileLabel = fileName ? `: ${fileName}` : '';
      const pctLabel = (typeof progressPct === 'number' && progressPct > 0)
        ? ` [${progressPct.toFixed(0)}%]`
        : '';
      this.headerBadge.innerText = `РЕПЛЕЙ (${srcLabel}${fileLabel})${pctLabel}`;
    } else if (isLive) {
      this.headerBadge.className = 'source-mode-tag live';
      this.headerBadge.innerText = 'ОНЛАЙН (UDP)';
    } else {
      this.headerBadge.className = 'source-mode-tag nodata';
      this.headerBadge.innerText = 'nodata';
    }
  }

  updateHeaderBadge(text, isLive = false) {
    if (!this.headerBadge) {
      this.headerBadge = document.getElementById('hdr-source-indicator');
    }
    if (!this.headerBadge) return;
    this.headerBadge.className = isLive ? 'source-mode-tag live' : 'source-mode-tag replay';
    this.headerBadge.innerText = text;
  }

  updateBadgeDisplay(text, badgeClass) {
    const badge = document.getElementById('settings-active-mode-badge');
    if (badge) {
      badge.className = badgeClass;
      badge.innerText = text;
    }
  }

  async fetchInitialStatus() {
    try {
      const res = await fetch('/api/replay/status');
      if (res.ok) {
        const data = await res.json();
        this.updateStatusUI(data);
        if (data.is_running) {
          const isLocal = Boolean(data.is_local || (data.file_name && data.file_name.startsWith('upload_')));
          this.switchMode(isLocal ? 'local-file' : 'server-file', false);
        } else {
          this.switchMode('live', false);
        }
      }
    } catch (e) {
      console.warn('[Settings] Failed to fetch initial status:', e);
    }
  }

  async fetchServerFiles() {
    const select = document.getElementById('select-server-file');
    if (!select) return;

    try {
      select.innerHTML = '<option value="">Оновлення списку файлів...</option>';
      const res = await fetch('/api/replay/files');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.availableServerFiles = data.files || [];
      select.innerHTML = '';

      if (this.availableServerFiles.length === 0) {
        select.innerHTML = '<option value="">Немає доступних файлів на сервері</option>';
        return;
      }

      this.availableServerFiles.forEach(file => {
        const opt = document.createElement('option');
        opt.value = file.filename;
        opt.innerText = `${file.filename} (${file.size_formatted})`;
        if (file.filename === 'telemetry_essential.csv') {
          opt.selected = true;
        }
        select.appendChild(opt);
      });

      this.onServerFileSelected(select.value);
    } catch (e) {
      console.error('[Settings] Error listing files:', e);
      select.innerHTML = '<option value="">Помилка завантаження файлів</option>';
    }
  }

  onServerFileSelected(filename) {
    const detailsEl = document.getElementById('server-file-details');
    if (!detailsEl) return;

    const file = this.availableServerFiles.find(f => f.filename === filename);
    if (file) {
      detailsEl.innerHTML = `
        <div class="meta-item"><strong>Опис:</strong> ${file.description || file.filename}</div>
        <div class="meta-item"><strong>Розмір:</strong> ${file.size_formatted} | <strong>Тип:</strong> ${file.type.toUpperCase()}</div>
      `;
    } else {
      detailsEl.innerHTML = '';
    }
  }

  async fetchReplayStatus() {
    try {
      const res = await fetch('/api/replay/status');
      if (res.ok) {
        const data = await res.json();
        this.updateStatusUI(data);
      }
    } catch (e) {
      console.debug('[Settings] Replay status poll error:', e);
    }
  }

  updateStatusUI(data) {
    if (!data) return;

    this.isReplayRunning = Boolean(data.is_running);
    this.currentMode = this.isReplayRunning ? 'replay' : 'live';

    const isLocal = Boolean(
      data.is_local ||
      (data.file_name && (data.file_name.startsWith('upload_') || data.file_name.includes('upload'))) ||
      (this.selectedLocalFile && data.file_name === this.selectedLocalFile.name) ||
      (this.isReplayRunning && this.currentReplaySource === 'local')
    );

    if (this.isReplayRunning) {
      this.currentReplaySource = isLocal ? 'local' : 'server';
    } else {
      this.currentReplaySource = null;
    }

    const isLiveActive = !this.isReplayRunning &&
      (data.connection === 'CONNECTED' || data.connection === 'ONLINE') &&
      ((data.packet_rate_hz || 0) > 0 || (data.packets_received || 0) > 0) &&
      (data.time_since_last_packet_sec === undefined || data.time_since_last_packet_sec < 4.0);

    // Update Header Source Status
    this.updateHeaderSourceBadge({
      isReplay: this.isReplayRunning,
      isLive: isLiveActive,
      fileName: data.file_name,
      source: this.currentReplaySource,
    });

    // Update Mode Badge in Settings Header
    const footerMode = document.getElementById('settings-active-mode-badge');
    if (footerMode) {
      if (this.isReplayRunning) {
        footerMode.className = 'mode-badge-replay';
        footerMode.innerText = this.currentReplaySource === 'local'
          ? `РЕПЛЕЙ (ЛОКАЛЬНИЙ: ${data.file_name || 'ФАЙЛ'})`
          : `РЕПЛЕЙ (СЕРВЕР: ${data.file_name || 'ФАЙЛ'})`;
      } else if (isLiveActive) {
        footerMode.className = 'mode-badge-live';
        footerMode.innerText = 'ОНЛАЙН (UDP СИМУЛЯТОР)';
      } else {
        footerMode.className = 'mode-badge-nodata';
        footerMode.innerText = 'nodata';
      }
    }

    // Update Live Tab Info
    const liveStatus = document.getElementById('live-sim-status');
    const liveHz = document.getElementById('live-sim-hz');
    const livePkts = document.getElementById('live-sim-packets');

    if (liveStatus) {
      if (this.isReplayRunning) {
        liveStatus.className = 'flat-val badge-idle';
        liveStatus.innerText = this.currentReplaySource === 'local'
          ? 'НЕАКТИВНИЙ (ПРАЦЮЄ ЛОКАЛЬНИЙ РЕПЛЕЙ)'
          : 'НЕАКТИВНИЙ (ПРАЦЮЄ РЕПЛЕЙ З СЕРВЕРА)';
      } else if (isLiveActive) {
        liveStatus.className = 'flat-val badge-connected';
        liveStatus.innerText = 'АКТИВНИЙ ПОТІК (ПІДКЛЮЧЕНО)';
      } else {
        liveStatus.className = 'flat-val badge-nodata';
        liveStatus.innerText = 'nodata';
      }
    }

    if (liveHz) {
      liveHz.innerText = isLiveActive ? `${data.packet_rate_hz || 0} Hz` : 'nodata';
    }
    if (livePkts) {
      livePkts.innerText = isLiveActive ? `${data.packets_received || 0}` : 'nodata';
    }

    // Update Server Replay Tab Progress
    const serverPct = document.getElementById('server-replay-pct');
    const serverFill = document.getElementById('server-replay-fill');
    const serverRecords = document.getElementById('server-replay-records');
    const serverState = document.getElementById('server-replay-state');

    const pct = typeof data.progress_pct === 'number' ? data.progress_pct : 0.0;

    if (serverPct) {
      serverPct.innerText = (this.isReplayRunning && !isLocal) ? `${pct.toFixed(1)}%` : 'nodata';
    }
    if (serverFill) {
      serverFill.style.width = (this.isReplayRunning && !isLocal) ? `${pct}%` : '0%';
    }
    if (serverRecords) {
      serverRecords.innerText = (this.isReplayRunning && !isLocal) ? `Записів: ${data.current_index || 0} / ${data.total_records || 0}` : 'nodata';
    }
    if (serverState) {
      if (this.isReplayRunning && !isLocal) {
        serverState.innerText = `СТАТУС: ВІДТВОРЕННЯ (${data.loop ? 'LOOP' : 'ONCE'})`;
        serverState.style.color = 'var(--avionics-cyan)';
      } else if (this.isReplayRunning && isLocal) {
        serverState.innerText = 'НЕАКТИВНИЙ (ПРАЦЮЄ ЛОКАЛЬНИЙ РЕПЛЕЙ)';
        serverState.style.color = '#94a3b8';
      } else {
        serverState.innerText = 'nodata';
        serverState.style.color = '#94a3b8';
      }
    }

    // Update Local Replay Progress
    const localPct = document.getElementById('local-replay-pct');
    const localFill = document.getElementById('local-replay-fill');
    const localRecords = document.getElementById('local-replay-records');
    const localState = document.getElementById('local-replay-state');

    if (localPct) {
      localPct.innerText = (this.isReplayRunning && isLocal) ? `${pct.toFixed(1)}%` : 'nodata';
    }
    if (localFill) {
      localFill.style.width = (this.isReplayRunning && isLocal) ? `${pct}%` : '0%';
    }
    if (localRecords) {
      localRecords.innerText = (this.isReplayRunning && isLocal) ? `Записів: ${data.current_index || 0} / ${data.total_records || 0}` : 'nodata';
    }
    if (localState) {
      if (this.isReplayRunning && isLocal) {
        localState.innerText = `СТАТУС: ВІДТВОРЕННЯ (${data.loop ? 'LOOP' : 'ONCE'})`;
        localState.style.color = 'var(--avionics-cyan)';
      } else if (this.isReplayRunning && !isLocal) {
        localState.innerText = 'НЕАКТИВНИЙ (ПРАЦЮЄ РЕПЛЕЙ З СЕРВЕРА)';
        localState.style.color = '#94a3b8';
      } else {
        localState.innerText = 'nodata';
        localState.style.color = '#94a3b8';
      }
    }

    this.updateControlsState();
  }

  // Real-time update from incoming WebSocket telemetry snapshot
  updateFromTelemetry(telemetry) {
    if (!telemetry || !telemetry.status) return;
    const st = telemetry.status;

    const isReplay = Boolean(st.replay_mode);
    this.isReplayRunning = isReplay;
    this.currentMode = isReplay ? 'replay' : 'live';
    if (!isReplay) {
      this.currentReplaySource = null;
    }

    const isLive = !isReplay && (st.connection === 'CONNECTED' || st.connection === 'ONLINE') &&
      ((st.packet_rate_hz || 0) > 0 || (st.packets_received || 0) > 0) &&
      (st.time_since_last_packet_sec === undefined || st.time_since_last_packet_sec < 4.0);

    // Header badge synchronization
    this.updateHeaderSourceBadge({
      isReplay: isReplay,
      isLive: isLive,
      fileName: st.replay_file,
      progressPct: st.replay_progress_pct,
      source: this.currentReplaySource,
    });

    // Active mode badge in settings header
    const footerMode = document.getElementById('settings-active-mode-badge');
    if (footerMode) {
      if (isReplay) {
        footerMode.className = 'mode-badge-replay';
        footerMode.innerText = this.currentReplaySource === 'local'
          ? `РЕПЛЕЙ (ЛОКАЛЬНИЙ: ${st.replay_file || 'ФАЙЛ'})`
          : `РЕПЛЕЙ (СЕРВЕР: ${st.replay_file || 'ФАЙЛ'})`;
      } else if (isLive) {
        footerMode.className = 'mode-badge-live';
        footerMode.innerText = 'ОНЛАЙН (UDP СИМУЛЯТОР)';
      } else {
        footerMode.className = 'mode-badge-nodata';
        footerMode.innerText = 'nodata';
      }
    }

    // Update live indicators in real-time
    const liveStatus = document.getElementById('live-sim-status');
    const liveHz = document.getElementById('live-sim-hz');
    const livePkts = document.getElementById('live-sim-packets');
    if (liveStatus) {
      if (isReplay) {
        liveStatus.className = 'flat-val badge-idle';
        liveStatus.innerText = this.currentReplaySource === 'local'
          ? 'НЕАКТИВНИЙ (ПРАЦЮЄ ЛОКАЛЬНИЙ РЕПЛЕЙ)'
          : 'НЕАКТИВНИЙ (ПРАЦЮЄ РЕПЛЕЙ З СЕРВЕРА)';
      } else if (isLive) {
        liveStatus.className = 'flat-val badge-connected';
        liveStatus.innerText = 'АКТИВНИЙ ПОТІК (ПІДКЛЮЧЕНО)';
      } else {
        liveStatus.className = 'flat-val badge-nodata';
        liveStatus.innerText = 'nodata';
      }
    }
    if (liveHz) {
      liveHz.innerText = isLive ? `${(st.packet_rate_hz || 0).toFixed(0)} Hz` : 'nodata';
    }
    if (livePkts) {
      livePkts.innerText = isLive ? `${st.packets_received || 0}` : 'nodata';
    }

    // Progress bar for active replay
    const pct = typeof st.replay_progress_pct === 'number' ? st.replay_progress_pct : 0.0;
    const serverPct = document.getElementById('server-replay-pct');
    const serverFill = document.getElementById('server-replay-fill');
    const localPct = document.getElementById('local-replay-pct');
    const localFill = document.getElementById('local-replay-fill');

    if (isReplay) {
      if (this.currentReplaySource !== 'local') {
        if (serverPct) serverPct.innerText = `${pct.toFixed(1)}%`;
        if (serverFill) serverFill.style.width = `${pct}%`;
      } else {
        if (localPct) localPct.innerText = `${pct.toFixed(1)}%`;
        if (localFill) localFill.style.width = `${pct}%`;
      }
    }

    this.updateControlsState();
  }

  updateControlsState() {
    const btnStartServer = document.getElementById('btn-start-server-replay');
    const btnStopServer = document.getElementById('btn-stop-server-replay');
    const btnUpload = document.getElementById('btn-upload-and-play');
    const btnStopLocal = document.getElementById('btn-stop-local-replay');

    if (!this.isReplayRunning) {
      // Live UDP is active: all replay start buttons ready, stop buttons disabled
      if (btnStartServer) {
        btnStartServer.disabled = false;
        btnStartServer.innerHTML = '&#9654; ЗАПУСТИТИ РЕПЛЕЙ З СЕРВЕРА';
      }
      if (btnStopServer) {
        btnStopServer.disabled = true;
      }
      if (btnUpload) {
        btnUpload.disabled = !this.selectedLocalFile;
      }
      if (btnStopLocal) {
        btnStopLocal.disabled = true;
      }
    } else if (this.currentReplaySource === 'server') {
      // Server Replay is active: start button disabled, stop enabled; local stop disabled
      if (btnStartServer) {
        btnStartServer.disabled = true;
        btnStartServer.innerHTML = '&#10003; ВІДТВОРЕННЯ АКТИВНЕ';
      }
      if (btnStopServer) {
        btnStopServer.disabled = false;
      }
      if (btnUpload) {
        btnUpload.disabled = !this.selectedLocalFile;
      }
      if (btnStopLocal) {
        btnStopLocal.disabled = true;
      }
    } else if (this.currentReplaySource === 'local') {
      // Local Replay is active: local stop enabled; server stop disabled, server start available to switch
      if (btnStartServer) {
        btnStartServer.disabled = false;
        btnStartServer.innerHTML = '&#9654; ЗАПУСТИТИ РЕПЛЕЙ З СЕРВЕРА';
      }
      if (btnStopServer) {
        btnStopServer.disabled = true;
      }
      if (btnUpload) {
        btnUpload.disabled = true;
      }
      if (btnStopLocal) {
        btnStopLocal.disabled = false;
      }
    }
  }

  async activateLiveMode() {
    try {
      const res = await fetch('/api/mode/live', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.currentMode = 'live';
      this.isReplayRunning = false;
      this.currentReplaySource = null;
      this.updateControlsState();
      this.showToast('Увімкнено онлайн режим прийому з X-Plane 11 UDP', 'success');
      this.fetchReplayStatus();
    } catch (e) {
      console.error('[Settings] Error switching to live mode:', e);
      this.showToast('Помилка перемикання в онлайн режим', 'error');
    }
  }

  async startServerReplay() {
    const select = document.getElementById('select-server-file');
    const selectedFile = select ? select.value : '';

    if (!selectedFile) {
      this.showToast('Будь ласка, оберіть файл для відтворення', 'warning');
      return;
    }

    const btn = document.getElementById('btn-start-server-replay');
    if (btn) btn.disabled = true;

    try {
      this.currentReplaySource = 'server';
      const res = await fetch('/api/replay/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          file_path: selectedFile,
          speed: this.serverSpeed,
          loop: this.serverLoop,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.isReplayRunning = true;
      this.updateControlsState();
      this.showToast(`Реплей файлу ${selectedFile} запущено (всі інші джерела вимкнено)`, 'success');
      this.fetchReplayStatus();
    } catch (e) {
      console.error('[Settings] Error starting server replay:', e);
      this.showToast('Не вдалося запустити реплей з сервера', 'error');
      this.currentReplaySource = null;
      this.updateControlsState();
    }
  }

  async stopReplay() {
    try {
      const res = await fetch('/api/replay/stop', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.isReplayRunning = false;
      this.currentReplaySource = null;
      this.currentMode = 'live';
      this.updateControlsState();
      this.showToast('Відтворення зупинено. Повернення до онлайн UDP', 'info');
      this.fetchReplayStatus();
    } catch (e) {
      console.error('[Settings] Error stopping replay:', e);
      this.showToast('Помилка зупинки реплею', 'error');
    }
  }

  handleLocalFile(file) {
    if (!file) return;

    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (ext !== '.csv' && ext !== '.txt') {
      this.showToast('Підтримуються тільки файли .csv та .txt', 'error');
      return;
    }

    this.selectedLocalFile = file;

    const selectedBox = document.getElementById('local-file-selected-info');
    const nameLabel = document.getElementById('selected-file-name');
    const sizeLabel = document.getElementById('selected-file-size');
    const btnUpload = document.getElementById('btn-upload-and-play');

    if (selectedBox) selectedBox.classList.remove('hidden');
    if (nameLabel) nameLabel.innerText = file.name;
    if (sizeLabel) {
      const sizeB = file.size;
      const sizeStr = sizeB >= 1024 * 1024 ? `${(sizeB / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(sizeB / 1024)} KB`;
      sizeLabel.innerText = sizeStr;
    }
    if (btnUpload) btnUpload.disabled = false;

    this.showToast(`Вибрано файл: ${file.name}`, 'info');
  }

  clearSelectedLocalFile() {
    this.selectedLocalFile = null;
    const fileInput = document.getElementById('local-file-input');
    if (fileInput) fileInput.value = '';

    const selectedBox = document.getElementById('local-file-selected-info');
    const btnUpload = document.getElementById('btn-upload-and-play');
    if (selectedBox) selectedBox.classList.add('hidden');
    if (btnUpload) btnUpload.disabled = true;
  }

  async uploadAndPlayLocalFile() {
    if (!this.selectedLocalFile) {
      this.showToast('Будь ласка, оберіть файл для завантаження', 'warning');
      return;
    }

    const btn = document.getElementById('btn-upload-and-play');
    if (btn) {
      btn.disabled = true;
      btn.innerText = 'Завантаження на сервер...';
    }

    try {
      this.currentReplaySource = 'local';
      const formData = new FormData();
      formData.append('file', this.selectedLocalFile);
      formData.append('start_immediately', 'true');
      formData.append('speed', this.localSpeed.toString());
      formData.append('loop', this.localLoop ? 'true' : 'false');

      const res = await fetch('/api/replay/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.isReplayRunning = true;
      this.updateControlsState();
      this.showToast(`Файл завантажено! Реплей розпочато (всі інші джерела вимкнено)`, 'success');
      this.fetchReplayStatus();
      this.fetchServerFiles();
    } catch (e) {
      console.error('[Settings] Error uploading local file:', e);
      this.showToast('Помилка завантаження файлу на сервер', 'error');
      this.currentReplaySource = null;
      this.updateControlsState();
    } finally {
      if (btn) {
        btn.innerHTML = '&#11014; ЗАВАНТАЖИТИ ТА ЗАПУСТИТИ РЕПЛЕЙ';
        this.updateControlsState();
      }
    }
  }

  showToast(message, type = 'info') {
    if (window.app && window.app.alerts && typeof window.app.alerts.showToast === 'function') {
      window.app.alerts.showToast(message, type);
      return;
    }

    const toast = document.createElement('div');
    toast.className = `settings-toast ${type}`;
    toast.innerText = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 400);
    }, 3500);
  }
}

// Global initialization
window.TelemetrySettingsManager = TelemetrySettingsManager;
