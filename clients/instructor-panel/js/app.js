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
            this.standby.airspeedGauge.resize();
            this.standby.attitudeGauge.resize();
            this.standby.altimeterGauge.resize();
          }, 30);
        }
      });
    }

    // Handle view mode query param (?view=pfd or ?view=nd)
    const urlParams = new URLSearchParams(window.location.search);
    const viewMode = urlParams.get('view');
    if (viewMode) {
      document.body.classList.add(`mode-${viewMode}`);
    }
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

    // Update Service Statuses
    if (payload.service_status) {
      this.serviceStatus = payload.service_status;
      this.updateServicePills();
    }

    const isTelemetryOnline = this.serviceStatus.telemetry === 'ONLINE';
    const isVisionOnline = this.serviceStatus.vision === 'ONLINE';
    const isAnalyticsOnline = this.serviceStatus.analytics === 'ONLINE';

    // 1. Dispatch Telemetry to PFD
    this.pfd.update(payload.telemetry, isTelemetryOnline);

    // 2. Dispatch Telemetry to ND Map
    this.nd.update(payload.telemetry, isTelemetryOnline);

    // 3. Dispatch Telemetry to Engine Indication System
    this.engine.update(payload.telemetry, isTelemetryOnline);

    // 3b. Dispatch Telemetry to Standby Backup Cluster
    if (this.standby) {
      this.standby.update(payload.telemetry, isTelemetryOnline);
    }

    // 4. Dispatch to AI Warnings & Landing Evaluator
    this.alerts.update(payload.analytics, payload.telemetry, isAnalyticsOnline);

    // 5. Update Vision HUD Panel
    this.updateVisionHUD(payload.vision, isVisionOnline);
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
