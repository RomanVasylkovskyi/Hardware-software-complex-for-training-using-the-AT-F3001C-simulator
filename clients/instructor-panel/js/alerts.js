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

  dismissToast(warn) {
    this.dismissedWarnings.add(warn);
    const toast = this.toasts.get(warn);
    if (toast) {
      toast.classList.add('toast-exiting');
      setTimeout(() => {
        toast.remove();
        this.toasts.delete(warn);
      }, 350);
    }
  }

  update(analytics, telemetry, isOnline) {
    if (!isOnline) {
      this.showOfflineState();
      if (this.approachBadge) {
        this.approachBadge.className = 'status-pill status-offline';
        this.approachBadge.innerText = 'APPROACH: NO DATA';
      }
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
    if (!warningsList || warningsList.length === 0) {
      // Smoothly dismiss all active toasts to the right
      for (const [warn, toast] of this.toasts.entries()) {
        toast.classList.add('toast-exiting');
        setTimeout(() => toast.remove(), 350);
      }
      this.toasts.clear();
      this.activeWarnings.clear();
      this.dismissedWarnings.clear();

      if (this.banner) {
        this.banner.innerHTML = '<span class="annunciator-normal">SYSTEMS NORMAL</span>';
        this.banner.className = 'annunciator-container normal';
        this.banner.title = 'Всі системи в нормі. Клацніть для перегляду статусу';
      }
      return;
    }

    // Determine Master Warning
    const isMasterWarning = warningsList.some(warn => 
      ['PULL UP', 'STALL', 'OVERSPEED', 'TERRAIN', 'UNSTABILIZED', 'FAIL', 'ERROR', 'CRASH', 'OFFLINE']
      .some(w => String(warn).toUpperCase().includes(w))
    );

    // 1. Update Compact Header Annunciator (Aviation Master Warning / Master Caution)
    if (this.banner) {
      const typeLabel = isMasterWarning ? 'УВАГА' : 'ПОПЕРЕДЖЕННЯ';
      const count = warningsList.length;
      const countLabel = `${typeLabel}: ${count}`;
      this.banner.innerHTML = `<span class="header-warn-summary">${countLabel}</span>`;
      this.banner.className = `annunciator-container ${isMasterWarning ? 'master-warning' : 'master-caution'}`;
      this.banner.title = `Активно ${count} попереджень. Клацніть, щоб перемкнути відображення`;
    }

    // 2. Remove obsolete toasts with light slide-out animation to the right
    for (const [warn, toast] of this.toasts.entries()) {
      if (!warningsList.includes(warn)) {
        toast.classList.add('toast-exiting');
        setTimeout(() => toast.remove(), 350);
        this.toasts.delete(warn);
        this.dismissedWarnings.delete(warn);
      }
    }

    // 3. Add or update toast rows in the column stack
    warningsList.forEach(warn => {
      // If warning has re-triggered as a new state, allow it to reappear
      if (!this.activeWarnings.has(warn)) {
        this.dismissedWarnings.delete(warn);
      }

      if (this.dismissedWarnings.has(warn)) return;

      if (!this.toasts.has(warn)) {
        const upper = String(warn).toUpperCase();
        const isRed = ['PULL UP', 'STALL', 'OVERSPEED', 'TERRAIN', 'UNSTABILIZED', 'FAIL', 'ERROR', 'CRASH', 'OFFLINE'].some(w => upper.includes(w));
        const cssClass = isRed ? 'warn-badge-red' : 'warn-badge-amber';
        const cardType = isRed ? 'master-warning' : 'master-caution';

        const toast = document.createElement('div');
        toast.className = `hud-alert-toast ${cardType} toast-entering`;
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
          <span class="warn-badge ${cssClass}">${warn}</span>
          <button class="hud-alert-close" title="Сховати">&times;</button>
        `;

        const closeBtn = toast.querySelector('.hud-alert-close');
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.dismissToast(warn);
        });

        this.toastContainer.appendChild(toast);
        this.toasts.set(warn, toast);

        // Light animation: enter from right
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            toast.classList.remove('toast-entering');
          });
        });

        // Play audio chime if new warning
        if (!this.activeWarnings.has(warn)) {
          if (window.cockpitAudio) {
            window.cockpitAudio.playAlert(isRed ? 'warning' : 'caution');
          }
        }
      }
    });

    this.activeWarnings = new Set(warningsList);
  }

  showOfflineState() {
    for (const [warn, toast] of this.toasts.entries()) {
      toast.classList.add('toast-exiting');
      setTimeout(() => toast.remove(), 350);
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
    } else {
      // Check AGL altitude to determine approach phase
      const agl = telemetry?.altitude_agl_ft;
      if (agl !== null && agl !== undefined && agl > 10 && agl < 1000) {
        this.approachBadge.className = 'status-pill status-caution';
        this.approachBadge.innerText = 'APPROACH: MONITORING';
      } else {
        this.approachBadge.className = 'status-pill status-neutral';
        this.approachBadge.innerText = 'APPROACH: INACTIVE';
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
