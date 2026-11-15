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

    // Tabs
    this.tabBtns = document.querySelectorAll('.settings-tab-btn');
    this.panels = {
      live: document.getElementById('settings-panel-live'),
      'server-file': document.getElementById('settings-panel-server-file'),
      'local-file': document.getElementById('settings-panel-local-file'),
    };

    // State
    this.currentMode = 'live'; // 'live' or 'replay'
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
    // Tab Navigation
    this.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.modeTab;
        if (tabId) this.switchTab(tabId);
      });
    });

    // --- TAB 1: Live Controls ---
    const btnActivateLive = document.getElementById('btn-activate-live');
    if (btnActivateLive) {
      btnActivateLive.addEventListener('click', () => this.activateLiveMode());
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

    // Speed selector for server file
    document.querySelectorAll('#server-speed-group .btn-speed').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#server-speed-group .btn-speed').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.serverSpeed = parseFloat(btn.dataset.speed) || 1.0;
      });
    });

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

    // Speed selector for local file
    document.querySelectorAll('#local-speed-group .btn-speed').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#local-speed-group .btn-speed').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.localSpeed = parseFloat(btn.dataset.speed) || 1.0;
      });
    });

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

  switchTab(tabId) {
    this.tabBtns.forEach(btn => {
      if (btn.dataset.modeTab === tabId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    Object.keys(this.panels).forEach(key => {
      const panel = this.panels[key];
      if (panel) {
        if (key === tabId) {
          panel.classList.remove('hidden');
          panel.classList.add('active');
        } else {
          panel.classList.add('hidden');
          panel.classList.remove('active');
        }
      }
    });
  }

  async fetchInitialStatus() {
    try {
      const res = await fetch('/api/replay/status');
      if (res.ok) {
        const data = await res.json();
        this.updateStatusUI(data);
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

    this.currentMode = data.mode || (data.is_running ? 'replay' : 'live');
    this.isReplayRunning = Boolean(data.is_running);

    // Update Header Pill
    if (this.headerBadge) {
      if (this.currentMode === 'replay' && this.isReplayRunning) {
        this.headerBadge.className = 'source-mode-tag replay';
        const name = data.file_name || 'REPLAY';
        this.headerBadge.innerText = `REPLAY: ${name}`;
      } else {
        this.headerBadge.className = 'source-mode-tag live';
        this.headerBadge.innerText = 'LIVE UDP';
      }
    }

    // Update Footer Mode Badge in Modal
    const footerMode = document.getElementById('settings-active-mode-badge');
    if (footerMode) {
      if (this.currentMode === 'replay' && this.isReplayRunning) {
        footerMode.className = 'mode-badge-replay';
        footerMode.innerText = `РЕПЛЕЙ (${data.file_name || 'ФАЙЛ'})`;
      } else {
        footerMode.className = 'mode-badge-live';
        footerMode.innerText = 'ОНЛАЙН (UDP СИМУЛЯТОР)';
      }
    }

    // Update Live Tab Info
    const liveStatus = document.getElementById('live-sim-status');
    const liveHz = document.getElementById('live-sim-hz');
    const livePkts = document.getElementById('live-sim-packets');

    if (liveStatus) {
      if (this.currentMode === 'live') {
        const isConnected = data.connection === 'CONNECTED';
        liveStatus.className = isConnected ? 'info-val badge-connected' : 'info-val badge-offline';
        liveStatus.innerText = isConnected ? 'АКТИВНИЙ ПОТІК (ПІДКЛЮЧЕНО)' : 'ОЧІКУВАННЯ ДАНИХ СИМУЛЯТОРА';
      } else {
        liveStatus.className = 'info-val badge-idle';
        liveStatus.innerText = 'РЕЖИМ РЕПЛЕЮ (ОНЛАЙН ПРИЗУПИНЕНО)';
      }
    }

    if (liveHz) {
      liveHz.innerText = `${data.packet_rate_hz || 0} Hz`;
    }
    if (livePkts) {
      livePkts.innerText = `${data.packets_received || 0}`;
    }

    // Update Server Replay Tab Progress
    const serverPct = document.getElementById('server-replay-pct');
    const serverFill = document.getElementById('server-replay-fill');
    const serverRecords = document.getElementById('server-replay-records');
    const serverState = document.getElementById('server-replay-state');

    const pct = typeof data.progress_pct === 'number' ? data.progress_pct : 0.0;
    if (serverPct) serverPct.innerText = `${pct.toFixed(1)}%`;
    if (serverFill) serverFill.style.width = `${pct}%`;
    if (serverRecords) {
      serverRecords.innerText = `Записів: ${data.current_index || 0} / ${data.total_records || 0}`;
    }
    if (serverState) {
      if (this.isReplayRunning) {
        serverState.innerText = `СТАТУС: ВІДТВОРЕННЯ (${data.speed || 1}x, ${data.loop ? 'LOOP' : 'ONCE'})`;
        serverState.style.color = 'var(--avionics-cyan)';
      } else {
        serverState.innerText = 'СТАТУС: ЗУПИНЕНО';
        serverState.style.color = '#94a3b8';
      }
    }

    // Update Local Replay Tab Progress (if active)
    const localCard = document.getElementById('local-replay-status-card');
    const localPct = document.getElementById('local-replay-pct');
    const localFill = document.getElementById('local-replay-fill');
    const localRecords = document.getElementById('local-replay-records');
    const localState = document.getElementById('local-replay-state');

    if (this.isReplayRunning && localCard) {
      localCard.classList.remove('hidden');
      if (localPct) localPct.innerText = `${pct.toFixed(1)}%`;
      if (localFill) localFill.style.width = `${pct}%`;
      if (localRecords) {
        localRecords.innerText = `Записів: ${data.current_index || 0} / ${data.total_records || 0}`;
      }
      if (localState) {
        localState.innerText = `СТАТУС: АКТИВНО (${data.speed || 1}x)`;
      }
    }
  }

  // Real-time update from incoming WebSocket telemetry snapshot
  updateFromTelemetry(telemetry) {
    if (!telemetry || !telemetry.status) return;
    const st = telemetry.status;

    if (st.replay_mode) {
      this.currentMode = 'replay';
      this.isReplayRunning = true;
    }

    // Header badge synchronization
    if (this.headerBadge) {
      if (st.replay_mode) {
        this.headerBadge.className = 'source-mode-tag replay';
        if (typeof st.replay_progress_pct === 'number') {
          this.headerBadge.innerText = `REPLAY (${st.replay_progress_pct.toFixed(0)}%)`;
        } else {
          this.headerBadge.innerText = 'REPLAY';
        }
      } else {
        this.headerBadge.className = 'source-mode-tag live';
        this.headerBadge.innerText = 'LIVE UDP';
      }
    }

    // Smoothly update progress bars if elements exist
    const pct = typeof st.replay_progress_pct === 'number' ? st.replay_progress_pct : 0.0;
    const serverPct = document.getElementById('server-replay-pct');
    const serverFill = document.getElementById('server-replay-fill');
    const localPct = document.getElementById('local-replay-pct');
    const localFill = document.getElementById('local-replay-fill');

    if (serverPct) serverPct.innerText = `${pct.toFixed(1)}%`;
    if (serverFill) serverFill.style.width = `${pct}%`;
    if (localPct) localPct.innerText = `${pct.toFixed(1)}%`;
    if (localFill) localFill.style.width = `${pct}%`;
  }

  async activateLiveMode() {
    const btn = document.getElementById('btn-activate-live');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/api/mode/live', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.showToast('Увімкнено онлайн режим прийому з X-Plane 11 UDP (0.0.0.0:49005/49000)', 'success');
      this.fetchReplayStatus();
    } catch (e) {
      console.error('[Settings] Error switching to live mode:', e);
      this.showToast('Помилка перемикання в онлайн режим', 'error');
    } finally {
      if (btn) btn.disabled = false;
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

      this.showToast(`Реплей файлу ${selectedFile} успішно запущено (${data.total_records || ''} рядків)`, 'success');
      this.fetchReplayStatus();
    } catch (e) {
      console.error('[Settings] Error starting server replay:', e);
      this.showToast('Не вдалося запустити реплей з сервера', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async stopReplay() {
    try {
      const res = await fetch('/api/replay/stop', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.showToast('Відтворення зупинено', 'info');
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

      this.showToast(`Файл успішно завантажено! Реплей розпочато (${data.total_records || 0} записів)`, 'success');
      this.fetchReplayStatus();
      this.fetchServerFiles(); // Refresh file list to show newly uploaded file
    } catch (e) {
      console.error('[Settings] Error uploading local file:', e);
      this.showToast('Помилка завантаження файлу на сервер', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '&#11014; ЗАВАНТАЖИТИ ТА ЗАПУСТИТИ РЕПЛЕЙ';
      }
    }
  }

  showToast(message, type = 'info') {
    // If global alerts manager has toast support, display toast
    if (window.app && window.app.alerts && typeof window.app.alerts.showToast === 'function') {
      window.app.alerts.showToast(message, type);
      return;
    }

    // Fallback toast alert
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
