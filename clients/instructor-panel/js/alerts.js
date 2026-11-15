/**
 * AI Warnings & Stabilized Approach Alerts Banner & Landing Score Report Card
 * Real-time flight safety evaluator and instructor grading tool.
 */

class AlertsAndScoringManager {
  constructor() {
    this.banner = document.getElementById('annunciator-banner');
    this.toastContainer = document.getElementById('hud-alerts-column');
    this.reportCardModal = document.getElementById('landing-report-modal');
    
    // Stabilized approach elements
    this.approachBadge = document.getElementById('approach-status-badge');
    this.gsIndicator = document.getElementById('ils-gs-dots');
    this.locIndicator = document.getElementById('ils-loc-dots');

    // State
    this.scoringEnabled = false; // ТИМЧАСОВО ВІДКЛЮЧЕНО ОЦІНЮВАННЯ НА ПРОХАННЯ КОРИСТУВАЧА
    this.toasts = new Map(); // warningKey -> DOM toast element
    this.dismissedWarnings = new Set();
    this.activeWarnings = new Set();
    this.normalToast = null;
    this.lastTouchdownState = false;
    this.landingReportData = null;
    this.wasAirborne = false;

    // Примусово закриваємо модалку оцінювання
    if (this.reportCardModal) {
      this.reportCardModal.classList.add('hidden');
    }

    // Ensure floating toast column container exists in DOM (auto-inject if missing)
    if (!this.toastContainer) {
      this.toastContainer = document.createElement('div');
      this.toastContainer.id = 'hud-alerts-column';
      this.toastContainer.className = 'hud-alerts-column';
      document.body.appendChild(this.toastContainer);
    }

    if (this.banner) {
      this.banner.addEventListener('click', () => {
        this.togglePopup();
      });
    }

    window.alertsManager = this;
  }

  togglePopup() {
    if (this.activeWarnings.size > 0) {
      // If any warnings were dismissed, un-dismiss and show them again
      if (this.dismissedWarnings.size > 0) {
        this.dismissedWarnings.clear();
        this.renderWarnings([...this.activeWarnings]);
      } else {
        // Toggle: dismiss all currently shown toasts
        for (const warn of this.toasts.keys()) {
          this.dismissToast(warn);
        }
      }
    } else {
      // When systems are normal, show a brief green confirmation toast sliding from the right
      this.showNormalToast();
    }
  }

  showNormalToast() {
    if (this.normalToast) {
      this.normalToast.remove();
      this.normalToast = null;
    }
    const toast = document.createElement('div');
    toast.className = 'hud-alert-toast normal toast-entering';
    toast.setAttribute('role', 'status');
    toast.innerHTML = `
      <span class="warn-badge warn-badge-green">СИСТЕМИ В НОРМІ &bull; ПАРАМЕТРИ В МЕЖАХ ДОПУСКУ</span>
      <button class="hud-alert-close" title="Сховати">&times;</button>
    `;

    const closeBtn = toast.querySelector('.hud-alert-close');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toast.classList.add('toast-exiting');
      setTimeout(() => toast.remove(), 350);
    });

    this.toastContainer.appendChild(toast);
    this.normalToast = toast;

    // Light animation: enter from right
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.classList.remove('toast-entering');
      });
    });

    // Auto-dismiss smoothly to right after 3.2s
    setTimeout(() => {
      if (toast.parentNode && !toast.classList.contains('toast-exiting')) {
        toast.classList.add('toast-exiting');
        setTimeout(() => toast.remove(), 350);
      }
    }, 3200);
  }

  normalizeAlert(rawAlert) {
    if (!rawAlert) return null;
    const str = String(rawAlert).trim();
    if (!str) return null;

    let key = str;
    let label = str;
    let isRed = false;

    // Normalize known categories to static canonical keys to prevent rapid re-rendering
    if (/simulator connection lost/i.test(str)) {
      key = 'SIMULATOR_CONNECTION_LOST';
      label = 'SIMULATOR CONNECTION LOST';
      isRed = false;
    } else if (/no telemetry received/i.test(str)) {
      key = 'NO_TELEMETRY';
      label = 'NO TELEMETRY RECEIVED';
      isRed = false;
    } else if (/gps.*lost|no gps/i.test(str)) {
      key = 'NO_GPS_FIX';
      label = 'NO GPS FIX';
      isRed = true;
    } else {
      // Strip any dynamic parenthetical details like "(no packets for 2.1s)" or "(vsi=-1150)"
      key = str.replace(/\s*\([^)]*\)/g, '').trim().toUpperCase();
      label = key;
      isRed = ['PULL UP', 'STALL', 'OVERSPEED', 'TERRAIN', 'UNSTABILIZED', 'FAIL', 'ERROR', 'CRASH', 'OFFLINE']
        .some(w => key.includes(w));
    }

    return { key, label, isRed };
  }

  dismissToast(key) {
    this.dismissedWarnings.add(key);
    const toastData = this.toasts.get(key);
    if (toastData) {
      const el = toastData.el || toastData;
      el.classList.add('toast-exiting');
      setTimeout(() => {
        el.remove();
        this.toasts.delete(key);
      }, 350);
    }
  }

  update(analytics, telemetry, isOnline) {
    if (!isOnline) {
      this.showOfflineState();
      if (this.approachBadge) {
        this.approachBadge.className = 'status-pill status-offline';
        this.approachBadge.innerText = 'APPROACH: nodata';
      }
      if (this.gsIndicator) this.gsIndicator.innerHTML = '<div class="ils-dot"></div><div class="ils-dot"></div><div class="ils-dot"></div><div class="ils-dot"></div><div class="ils-dot"></div>';
      if (this.locIndicator) this.locIndicator.innerHTML = '<div class="ils-dot"></div><div class="ils-dot"></div><div class="ils-dot"></div><div class="ils-dot"></div><div class="ils-dot"></div>';
      return;
    }

    // 1. Process AI Warnings from Analytics Service and Telemetry Errors (Strictly Real Data, Zero Mock)
    const warningsList = analytics?.warnings?.active_warnings || 
      (Array.isArray(analytics?.warnings) ? analytics.warnings : []);
    
    const telemetryErrors = telemetry?.status?.errors || [];
    const combinedAlerts = [...warningsList];
    telemetryErrors.forEach(err => {
      if (!combinedAlerts.includes(err)) combinedAlerts.push(err);
    });

    this.renderWarnings(combinedAlerts);

    // 2. Process Stabilized Approach Status
    this.updateStabilizedApproach(analytics, telemetry);

    // 3. Process Landing Evaluation / Touchdown
    this.evaluateTouchdown(analytics, telemetry);
  }

  renderWarnings(warningsList) {
    const now = Date.now();

    // 1. Normalize all incoming warnings into map of key -> { key, label, isRed }
    const currentAlerts = new Map();
    (warningsList || []).forEach(w => {
      const norm = this.normalizeAlert(w);
      if (norm && !currentAlerts.has(norm.key)) {
        currentAlerts.set(norm.key, norm);
      }
    });

    // 2. Remove obsolete alerts with hysteresis debounce (min 2000ms display)
    for (const [key, toastData] of this.toasts.entries()) {
      if (!currentAlerts.has(key)) {
        if (now - (toastData.firstSeen || 0) >= 2000) {
          const el = toastData.el || toastData;
          el.classList.add('toast-exiting');
          setTimeout(() => {
            el.remove();
            this.toasts.delete(key);
            this.activeWarnings.delete(key);
            this.dismissedWarnings.delete(key);
          }, 350);
        }
      }
    }

    // 3. Render or update currently active alerts without flickering
    for (const [key, norm] of currentAlerts.entries()) {
      if (this.dismissedWarnings.has(key)) continue;

      if (this.toasts.has(key)) {
        // Already active on screen - update timestamp in-place, DO NOT recreate DOM element!
        const toastData = this.toasts.get(key);
        toastData.lastSeen = now;
        const badge = toastData.el?.querySelector('.warn-badge');
        if (badge && badge.innerText !== norm.label) {
          badge.innerText = norm.label;
        }
      } else {
        // Brand new alert: create single stable toast
        const cardType = norm.isRed ? 'master-warning' : 'master-caution';
        const cssClass = norm.isRed ? 'warn-badge-red' : 'warn-badge-amber';

        const toast = document.createElement('div');
        toast.className = `hud-alert-toast ${cardType} toast-entering`;
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
          <span class="warn-badge ${cssClass}">${norm.label}</span>
          <button class="hud-alert-close" title="Сховати">&times;</button>
        `;

        const closeBtn = toast.querySelector('.hud-alert-close');
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.dismissToast(key);
        });

        this.toastContainer.appendChild(toast);
        this.toasts.set(key, { el: toast, firstSeen: now, lastSeen: now, isRed: norm.isRed, label: norm.label });
        this.activeWarnings.add(key);

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            toast.classList.remove('toast-entering');
          });
        });

        // Audio chime only once when first triggered
        if (window.cockpitAudio) {
          window.cockpitAudio.playAlert(norm.isRed ? 'warning' : 'caution');
        }
      }
    }
  }

  showOfflineState() {
    for (const [key, toastData] of this.toasts.entries()) {
      const el = toastData.el || toastData;
      el.classList.add('toast-exiting');
      setTimeout(() => el.remove(), 350);
    }
    this.toasts.clear();
    this.activeWarnings.clear();
    this.dismissedWarnings.clear();

    if (this.banner) {
      this.banner.innerHTML = '<span class="annunciator-offline">OFFLINE</span>';
      this.banner.className = 'annunciator-container offline';
      this.banner.title = 'Немає зв\'язку з сервером телеметрії';
    }
  }

  clearAllWarnings() {
    this.showOfflineState();
    if (this.banner) {
      this.banner.innerHTML = '<span class="annunciator-normal">SYSTEMS NORMAL</span>';
      this.banner.className = 'annunciator-container normal';
    }
  }

  resetToOffline() {
    this.showOfflineState();
  }

  updateStabilizedApproach(analytics, telemetry) {
    if (!this.approachBadge) return;

    const status = analytics?.stabilized_approach?.status || analytics?.approach_status;
    if (status === 'STABILIZED' || status === 'STABLE') {
      this.approachBadge.className = 'status-pill status-online';
      this.approachBadge.innerText = 'APPROACH: STABILIZED';
    } else if (status === 'UNSTABILIZED' || status === 'UNSTABLE' || status === 'GO_AROUND_MANDATORY') {
      this.approachBadge.className = 'status-pill status-error blink';
      this.approachBadge.innerText = 'APPROACH: UNSTABILIZED';
    } else if (status === 'MONITORING') {
      this.approachBadge.className = 'status-pill status-caution';
      this.approachBadge.innerText = 'APPROACH: MONITORING';
    } else if (status === 'UNABLE_TO_EVALUATE_MISSING_DATA' || status === 'NO_DATA') {
      this.approachBadge.className = 'status-pill status-offline';
      this.approachBadge.innerText = 'APPROACH: nodata';
    } else {
      // Check AGL altitude to determine approach phase
      const agl = telemetry?.altitude_agl_ft;
      if (agl !== null && agl !== undefined && agl > 10 && agl < 1000) {
        this.approachBadge.className = 'status-pill status-caution';
        this.approachBadge.innerText = 'APPROACH: MONITORING';
      } else {
        this.approachBadge.className = 'status-pill status-offline';
        this.approachBadge.innerText = 'APPROACH: nodata';
      }
    }

    // ILS Deviation needles if available
    const gsDev = analytics?.deviation?.glideslope_dots;
    const locDev = analytics?.deviation?.localizer_dots;

    if (this.gsIndicator && gsDev !== undefined && gsDev !== null) {
      this.renderDeviationDots(this.gsIndicator, gsDev, 'vertical');
    }
    if (this.locIndicator && locDev !== undefined && locDev !== null) {
      this.renderDeviationDots(this.locIndicator, locDev, 'horizontal');
    }
  }

  renderDeviationDots(container, dev, orientation) {
    // dev: -2.0 to +2.0 dots
    container.innerHTML = '';
    const clamped = Math.max(-2, Math.min(2, dev));
    const dotCount = 5;
    for (let i = -2; i <= 2; i++) {
      const dot = document.createElement('div');
      dot.className = 'ils-dot';
      if (Math.abs(clamped - i) < 0.4) {
        dot.classList.add('ils-dot-active');
        if (Math.abs(i) <= 0.5) dot.classList.add('ils-green');
        else if (Math.abs(i) <= 1.2) dot.classList.add('ils-amber');
        else dot.classList.add('ils-red');
      }
      container.appendChild(dot);
    }
  }

  evaluateTouchdown(analytics, telemetry) {
    if (!this.scoringEnabled) return;
    if (!telemetry) return;

    // Direct report from analytics service
    if (analytics?.landing_score && !this.landingReportData) {
      this.showLandingReport(analytics.landing_score);
      return;
    }

    // Local touchdown detection fallback based on on_runway and AGL transition
    const agl = telemetry.altitude_agl_ft;
    const onRunway = telemetry.on_runway === 1 || (agl !== null && agl <= 2.0 && telemetry.indicated_airspeed_kt < 75);

    if (agl > 40) {
      this.wasAirborne = true;
    }

    // Touchdown event trigger
    if (this.wasAirborne && onRunway && !this.lastTouchdownState) {
      const vs = telemetry.vertical_speed_fpm ?? 0;
      const gNorm = telemetry.g_load_normal ?? 1.0;
      const pitch = telemetry.pitch_deg ?? 0;

      const report = this.calculateLandingScore(vs, gNorm, pitch);
      this.showLandingReport(report);
      this.wasAirborne = false;
    }

    this.lastTouchdownState = onRunway;
  }

  calculateLandingScore(vs, gLoad, pitch) {
    // VS criteria: soft: -50 to -180 fpm (40 pts)
    let vsScore = 40;
    const absVS = Math.abs(vs);
    if (absVS > 600) vsScore = 0;
    else if (absVS > 400) vsScore = 15;
    else if (absVS > 250) vsScore = 28;
    else if (absVS > 180) vsScore = 35;

    // G-load criteria: 1.0 - 1.3 G (30 pts)
    let gScore = 30;
    if (gLoad > 2.2 || gLoad < 0.5) gScore = 0;
    else if (gLoad > 1.7) gScore = 12;
    else if (gLoad > 1.4) gScore = 22;

    // Pitch flare criteria: +5 to +8 deg (30 pts)
    let pitchScore = 30;
    if (pitch < 0 || pitch > 12) pitchScore = 5;
    else if (pitch < 3 || pitch > 9) pitchScore = 18;

    const total = vsScore + gScore + pitchScore;
    let grade = 'GOOD';
    let gradeColor = '#22c55e';

    if (total >= 90) {
      grade = 'EXCELLENT (GREASER)';
      gradeColor = '#00e5ff';
    } else if (total >= 75) {
      grade = 'GOOD';
      gradeColor = '#22c55e';
    } else if (total >= 60) {
      grade = 'ACCEPTABLE';
      gradeColor = '#eab308';
    } else if (absVS > 550 || gLoad > 2.0) {
      grade = 'CRASH / STRUCTURAL DAMAGE';
      gradeColor = '#ef4444';
    } else {
      grade = 'HARD LANDING';
      gradeColor = '#f97316';
    }

    return {
      score: total,
      grade: grade,
      gradeColor: gradeColor,
      touchdown_vs_fpm: vs,
      touchdown_g: gLoad,
      touchdown_pitch_deg: pitch,
      centerline_dev_m: 1.4, // nominal
    };
  }

  showLandingReport(report) {
    if (!this.scoringEnabled) return;
    this.landingReportData = report;
    if (!this.reportCardModal) return;

    document.getElementById('rpt-score-val').innerText = `${report.score} / 100`;
    document.getElementById('rpt-grade-val').innerText = report.grade;
    document.getElementById('rpt-grade-val').style.color = report.gradeColor || '#22c55e';

    document.getElementById('rpt-vs-val').innerText = `${Math.round(report.touchdown_vs_fpm)} FPM`;
    document.getElementById('rpt-g-val').innerText = `${report.touchdown_g.toFixed(2)} G`;
    document.getElementById('rpt-pitch-val').innerText = `${report.touchdown_pitch_deg.toFixed(1)}°`;

    this.reportCardModal.classList.remove('hidden');

    if (window.cockpitAudio) {
      window.cockpitAudio.playAlert('chime');
    }
  }

  closeLandingReport() {
    if (this.reportCardModal) {
      this.reportCardModal.classList.add('hidden');
    }
  }

  resetLandingReport() {
    this.landingReportData = null;
    this.wasAirborne = false;
    this.closeLandingReport();
  }
}

window.AlertsAndScoringManager = AlertsAndScoringManager;
