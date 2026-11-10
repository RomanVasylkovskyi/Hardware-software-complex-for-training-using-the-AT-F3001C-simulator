/**
 * Main Instructor Operating Station (IOS) Application Coordinator
 * Unites PFD, ND, Engine Instruments, AI Alerts, and WebSocket Telemetry Stream.
 */

class InstructorPanelApp {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.reconnectTimer = null;

    // Latency & packet rate tracking
    this.lastPingSent = 0;
    this.latencyMs = 0;
    this.packetCount = 0;
    this.currentHz = 0;
    this.lastHzTime = performance.now();

    // Microservice statuses
    this.serviceStatus = {
      telemetry: 'OFFLINE',
      vision: 'OFFLINE',
      analytics: 'OFFLINE',
    };

    // Instantiate sub-components
    this.pfd = new PrimaryFlightDisplay('pfd-canvas');
    this.nd = new NavigationDisplay('nd-map', 'nd-no-gps-alert');
    const engContainerId = document.getElementById('view-eis') ? 'view-eis' : 'engine-panel';
    this.engine = new EngineInstrumentsPanel(engContainerId);
    this.alerts = new AlertsAndScoringManager();

    // Standby Analog Gauges (if mounted on dashboard)
    if (document.getElementById('gauge-airspeed-dash')) {
      this.standby = new StandbyInstrumentsCluster({
        airspeedId: 'gauge-airspeed-dash',
        attitudeId: 'gauge-attitude-dash',
        altimeterId: 'gauge-altimeter-dash',
        turnCoordinatorId: 'gauge-turn-dash',
        headingId: 'gauge-heading-dash',
        vsiId: 'gauge-vsi-dash',
      });
    } else {
      this.standby = null;
    }

    // DOM Header Elements
    this.connBadge = document.getElementById('conn-status-badge');
    this.latencyVal = document.getElementById('stat-latency-val');
    this.hzVal = document.getElementById('stat-hz-val');
    this.telemetryPill = document.getElementById('pill-telemetry');
    this.visionPill = document.getElementById('pill-vision');
    this.analyticsPill = document.getElementById('pill-analytics');
    this.zuluClock = document.getElementById('header-zulu-clock');
    this.sessionTimer = document.getElementById('header-session-time');

    // Session start time
    this.sessionStartTime = Date.now();
    this.activeView = 'all'; // Default view: all 4 panels
    this.lastPayload = null; // Cached last telemetry payload for instant view transitions
    window.app = this;

    // Bind event listeners
    this.bindEvents();

    // Start clock timer
    setInterval(() => this.updateClocks(), 500);

    // Connect to WebSocket Gateway
    this.connect();
  }

  bindEvents() {
    // ND Controls
    const layerSelect = document.getElementById('nd-layer-select');
    if (layerSelect) {
      layerSelect.addEventListener('change', (e) => this.nd.setLayer(e.target.value));
    }

    const btnFollow = document.getElementById('btn-nd-follow');
    if (btnFollow) btnFollow.addEventListener('click', () => this.nd.toggleAutoFollow());

    const btnFit = document.getElementById('btn-nd-fit');
    if (btnFit) btnFit.addEventListener('click', () => this.nd.fitTrack());

    const btnReset = document.getElementById('btn-nd-reset');
    if (btnReset) btnReset.addEventListener('click', () => this.nd.resetTrack());

    // Audio Mute Toggle
    const btnAudio = document.getElementById('btn-audio-mute');
    if (btnAudio) btnAudio.addEventListener('click', () => window.cockpitAudio.toggleMute());

    // Close Landing Report Modal
    const btnCloseRpt = document.getElementById('btn-close-report');
    if (btnCloseRpt) btnCloseRpt.addEventListener('click', () => this.alerts.closeLandingReport());

    const btnResetRpt = document.getElementById('btn-reset-report');
    if (btnResetRpt) btnResetRpt.addEventListener('click', () => this.alerts.resetLandingReport());

    // Fullscreen buttons
    document.querySelectorAll('.btn-fullscreen').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = btn.dataset.target;
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          if (!document.fullscreenElement) {
            targetEl.requestFullscreen().catch(err => console.warn(err));
          } else {
            document.exitFullscreen().catch(err => console.warn(err));
          }
        }
      });
    });

    // Tab Switcher between Engine (EIS) and Standby Instruments
    const btnTabEis = document.getElementById('tab-btn-eis');
    const btnTabStandby = document.getElementById('tab-btn-standby');
    const viewEis = document.getElementById('view-eis');
    const viewStandby = document.getElementById('view-standby');
    const popoutEis = document.getElementById('popout-eis');
    const popoutStandby = document.getElementById('popout-standby');

    if (btnTabEis && btnTabStandby && viewEis && viewStandby) {
      btnTabEis.addEventListener('click', () => {
        btnTabEis.classList.add('active');
        btnTabStandby.classList.remove('active');
        viewEis.classList.remove('hidden');
        viewStandby.classList.add('hidden');
        if (popoutEis) popoutEis.classList.remove('hidden');
        if (popoutStandby) popoutStandby.classList.add('hidden');
      });

      btnTabStandby.addEventListener('click', () => {
        btnTabStandby.classList.add('active');
        btnTabEis.classList.remove('active');
        viewStandby.classList.remove('hidden');
        viewEis.classList.add('hidden');
        if (popoutStandby) popoutStandby.classList.remove('hidden');
        if (popoutEis) popoutEis.classList.add('hidden');
        if (this.standby) {
          setTimeout(() => {
            this.standby.resize();
          }, 30);
        }
      });
    }

    // Global SPA Navigation Tabs & Section Switchers
    document.querySelectorAll('.nav-tab-btn, .btn-switch-view').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const view = btn.dataset.view;
        if (view) this.setView(view);
      });
    });

    // Header Fullscreen Button
    const btnHdrFs = document.getElementById('btn-header-fullscreen');
    if (btnHdrFs) {
      btnHdrFs.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(err => console.warn(err));
        } else {
          document.exitFullscreen().catch(err => console.warn(err));
        }
      });
    }

    // Listen to hashchange for seamless browser history support without page refresh
    window.addEventListener('hashchange', () => {
      const hashView = (location.hash || '#all').replace('#', '');
      if (hashView && hashView !== this.activeView) {
        this.setView(hashView);
      }
    });

    // Responsive window resize & mobile/tablet orientation change handlers
    this._resizeDebounceTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeDebounceTimer);
      this._resizeDebounceTimer = setTimeout(() => this.handleResize(), 80);
    });

    window.addEventListener('orientationchange', () => {
      setTimeout(() => this.handleResize(), 150);
    });

    // Initialize active view from hash or query param (default 'all')
    const urlParams = new URLSearchParams(window.location.search);
    const viewParam = urlParams.get('view');
    const hashParam = (location.hash || '').replace('#', '');
    const initialView = viewParam || hashParam || 'all';
    this.setView(initialView);
  }

  handleResize() {
    requestAnimationFrame(() => {
      if (this.activeView === 'pfd' || this.activeView === 'all') {
        if (this.pfd) this.pfd.resize();
      }
      if (this.activeView === 'nd' || this.activeView === 'all') {
        if (this.nd && this.nd.map) {
          this.nd.map.invalidateSize();
        }
      }
      if (this.activeView === 'standby' || this.activeView === 'all') {
        if (this.standby) {
          this.standby.resize();
        }
      }
    });
  }

  setView(viewName) {
    const validViews = ['all', 'pfd', 'nd', 'standby', 'engine', 'safety'];
    if (!validViews.includes(viewName)) viewName = 'all';

    this.activeView = viewName;

    // 1. Highlight active navigation tab in fixed header
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // 2. Set body mode class for full-screen view layout
    validViews.forEach(v => document.body.classList.remove(`mode-${v}`));
    document.body.classList.add(`mode-${viewName}`);

    // 3. For engine / standby sub-views inside card-engine
    const viewEis = document.getElementById('view-eis');
    const viewStandby = document.getElementById('view-standby');
    const tabBtnEis = document.getElementById('tab-btn-eis');
    const tabBtnStandby = document.getElementById('tab-btn-standby');

    if (viewName === 'standby') {
      if (viewEis) viewEis.classList.add('hidden');
      if (viewStandby) viewStandby.classList.remove('hidden');
      if (tabBtnEis) tabBtnEis.classList.remove('active');
      if (tabBtnStandby) tabBtnStandby.classList.add('active');
    } else if (viewName === 'engine') {
      if (viewEis) viewEis.classList.remove('hidden');
      if (viewStandby) viewStandby.classList.add('hidden');
      if (tabBtnEis) tabBtnEis.classList.add('active');
      if (tabBtnStandby) tabBtnStandby.classList.remove('active');
    }

    // 4. Force resize on active canvas or Leaflet map so it fills available screen immediately
    this.handleResize();

    // 5. Instantly render latest telemetry onto the newly visible section
    if (this.lastPayload) {
      const isTelemetryOnline = this.serviceStatus.telemetry === 'ONLINE';
      const isVisionOnline = this.serviceStatus.vision === 'ONLINE';
      if (viewName === 'pfd' || viewName === 'all') {
        this.pfd.update(this.lastPayload.telemetry, isTelemetryOnline);
      }
      if (viewName === 'nd' || viewName === 'all') {
        this.nd.update(this.lastPayload.telemetry, isTelemetryOnline);
      }
      if (viewName === 'standby' || viewName === 'all') {
        if (this.standby) this.standby.update(this.lastPayload.telemetry, isTelemetryOnline);
      }
      if (viewName === 'engine' || viewName === 'all') {
        this.engine.update(this.lastPayload.telemetry, isTelemetryOnline);
      }
      if (viewName === 'safety' || viewName === 'all') {
        this.updateVisionHUD(this.lastPayload.vision, isVisionOnline);
      }
    }

    // 6. Update URL hash without reloading page
    try {
      if (location.hash.replace('#', '') !== viewName) {
        history.replaceState(null, '', `#${viewName}`);
      }
    } catch (e) {}
  }

  connect() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:8000';
    const wsUrl = `${protocol}//${host}/ws/telemetry`;

    console.log(`[IOS Gateway] Connecting to: ${wsUrl}`);
    this.updateConnectionUI('CONNECTING', '#eab308');

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[IOS Gateway] WebSocket instantiation failed:', e);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[IOS Gateway] Connected.');
      this.isConnected = true;
      this.updateConnectionUI('CONNECTED', '#22c55e');

      // Start ping loop for latency measurement
      this.startPingLoop();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = () => {
      console.warn('[IOS Gateway] Disconnected.');
      this.isConnected = false;
      this.updateConnectionUI('DISCONNECTED', '#ef4444');
      this.markAllOffline();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[IOS Gateway] Socket error:', err);
      this.ws.close();
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      console.log('[IOS Gateway] Attempting reconnect...');
      this.connect();
    }, 1500);
  }

  startPingLoop() {
    setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.lastPingSent = performance.now();
        this.ws.send(JSON.stringify({ type: 'ping', t: this.lastPingSent }));
      }
    }, 1000);
  }

  handleMessage(dataStr) {
    let payload;
    try {
      payload = JSON.parse(dataStr);
    } catch (e) {
      console.warn('[IOS Gateway] Failed to parse message JSON:', e);
      return;
    }

    // Check for pong
    if (payload.type === 'pong') {
      const rtt = performance.now() - (payload.client_t || this.lastPingSent);
      this.latencyMs = Math.round(rtt / 2);
      if (this.latencyVal) {
        this.latencyVal.innerText = `${this.latencyMs} ms`;
        this.latencyVal.style.color = this.latencyMs < 50 ? '#22c55e' : (this.latencyMs < 100 ? '#eab308' : '#ef4444');
      }
      return;
    }

    // Packet rate counting
    this.packetCount++;
    const now = performance.now();
    const dt = now - this.lastHzTime;
    if (dt >= 1000) {
      this.currentHz = Math.round((this.packetCount / dt) * 1000);
      this.packetCount = 0;
      this.lastHzTime = now;
      if (this.hzVal) {
        this.hzVal.innerText = `${this.currentHz} Hz`;
      }
    }

    // Cache latest payload for fast transitions
    this.lastPayload = payload;

    // Update Service Statuses
    if (payload.service_status) {
      this.serviceStatus = payload.service_status;
      this.updateServicePills();
    }

    const isTelemetryOnline = this.serviceStatus.telemetry === 'ONLINE';
    const isVisionOnline = this.serviceStatus.vision === 'ONLINE';
    const isAnalyticsOnline = this.serviceStatus.analytics === 'ONLINE';

    // Master Warning / Caution & Annunciator Bar always updates
    this.alerts.update(payload.analytics, payload.telemetry, isAnalyticsOnline);

    // RESOURCE OPTIMIZATION (Економія ресурсів):
    // Only execute heavy DOM, Canvas, and Leaflet redraws for the ACTIVE section!
    const active = this.activeView;

    if (active === 'all') {
      this.pfd.update(payload.telemetry, isTelemetryOnline);
      this.nd.update(payload.telemetry, isTelemetryOnline);

      const viewStandby = document.getElementById('view-standby');
      const isStandbyActive = viewStandby && !viewStandby.classList.contains('hidden');
      if (isStandbyActive) {
        if (this.standby) this.standby.update(payload.telemetry, isTelemetryOnline);
      } else {
        this.engine.update(payload.telemetry, isTelemetryOnline);
      }

      this.updateVisionHUD(payload.vision, isVisionOnline);
    } else if (active === 'pfd') {
      this.pfd.update(payload.telemetry, isTelemetryOnline);
    } else if (active === 'nd') {
      this.nd.update(payload.telemetry, isTelemetryOnline);
    } else if (active === 'standby') {
      if (this.standby) this.standby.update(payload.telemetry, isTelemetryOnline);
    } else if (active === 'engine') {
      this.engine.update(payload.telemetry, isTelemetryOnline);
    } else if (active === 'safety') {
      this.updateVisionHUD(payload.vision, isVisionOnline);
    }
  }

  updateServicePills() {
    this.setPill(this.telemetryPill, 'TELEMETRY', this.serviceStatus.telemetry);
    this.setPill(this.visionPill, 'VISION', this.serviceStatus.vision);
    this.setPill(this.analyticsPill, 'ANALYTICS', this.serviceStatus.analytics);
  }

  setPill(element, label, status) {
    if (!element) return;
    const isOnline = status === 'ONLINE';
    element.className = `service-pill ${isOnline ? 'online' : 'offline'}`;
    element.innerText = `${label}: ${status}`;
  }

  updateConnectionUI(statusText, color) {
    if (this.connBadge) {
      this.connBadge.innerText = statusText;
      this.connBadge.style.backgroundColor = color;
    }
  }

  markAllOffline() {
    this.serviceStatus.telemetry = 'OFFLINE';
    this.serviceStatus.vision = 'OFFLINE';
    this.serviceStatus.analytics = 'OFFLINE';
    this.updateServicePills();

    // Propagate offline status to all displays
    this.pfd.update(null, false);
    this.nd.update(null, false);
    this.engine.update(null, false);
    if (this.standby) {
      this.standby.update(null, false);
    }
    this.alerts.update(null, null, false);
    this.updateVisionHUD(null, false);
  }

  updateVisionHUD(vision, isOnline) {
    const pilotElem = document.getElementById('hud-pilot-detected');
    const gazeElem = document.getElementById('hud-gaze-direction');
    const postureElem = document.getElementById('hud-posture-alert');

    if (!isOnline || !vision) {
      if (pilotElem) {
        pilotElem.innerText = 'OFFLINE';
        pilotElem.className = 'hud-val text-muted';
      }
      if (gazeElem) {
        gazeElem.innerText = '--';
        gazeElem.className = 'hud-val text-muted';
      }
      if (postureElem) {
        postureElem.innerText = '--';
        postureElem.className = 'hud-val text-muted';
      }
      return;
    }

    if (pilotElem) {
      pilotElem.innerText = vision.pilot_detected ? 'DETECTED' : 'NOT DETECTED';
      pilotElem.className = vision.pilot_detected ? 'hud-val text-ok' : 'hud-val text-warn';
    }
    if (gazeElem) {
      gazeElem.innerText = vision.gaze_direction || 'FORWARD (OUTSIDE)';
      gazeElem.className = 'hud-val text-cyan';
    }
    if (postureElem) {
      postureElem.innerText = vision.posture_alert || 'NORMAL';
      postureElem.className = vision.posture_alert ? 'hud-val text-warn' : 'hud-val text-ok';
    }
  }

  updateClocks() {
    const now = new Date();
    // Zulu Clock
    const zHours = String(now.getUTCHours()).padStart(2, '0');
    const zMinutes = String(now.getUTCMinutes()).padStart(2, '0');
    const zSeconds = String(now.getUTCSeconds()).padStart(2, '0');
    if (this.zuluClock) {
      this.zuluClock.innerText = `${zHours}:${zMinutes}:${zSeconds} Z`;
    }

    // Session Timer
    const elapsedSec = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    const sMin = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const sSec = String(elapsedSec % 60).padStart(2, '0');
    if (this.sessionTimer) {
      this.sessionTimer.innerText = `${sMin}:${sSec}`;
    }
  }
}

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new InstructorPanelApp();
});
