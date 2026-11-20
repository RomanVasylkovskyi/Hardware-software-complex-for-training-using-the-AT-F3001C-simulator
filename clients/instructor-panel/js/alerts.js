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
    // Landing report is shown once per touchdown detected by analytics-service.
    this.scoringEnabled = true;
    this.toasts = new Map(); // warningKey -> DOM toast element
    this.dismissedWarnings = new Set();
    this.activeWarnings = new Set();
    this.normalToast = null;
    this.landingReportData = null;
    // Touchdown already reported (or present when the panel connected); undefined = not yet known.
    this.lastTouchdownId = undefined;

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
      if (toastData.exitTimer) {
        clearTimeout(toastData.exitTimer);
        toastData.exitTimer = null;
      }
      const el = toastData.el;
      if (el) {
        el.classList.add('toast-exiting');
        setTimeout(() => {
          if (el.parentNode) el.remove();
          this.toasts.delete(key);
          this.activeWarnings.delete(key);
        }, 300);
      } else {
        this.toasts.delete(key);
        this.activeWarnings.delete(key);
      }
    }
    // Strict DOM safeguard: remove any leftover DOM elements matching this alert key
    if (this.toastContainer) {
      const stray = this.toastContainer.querySelectorAll(`.hud-alert-toast[data-alert-key="${CSS.escape(key)}"]`);
      stray.forEach(el => el.remove());
    }
  }

  update(analytics, telemetry, isOnline) {
    if (!isOnline) {
      this.showOfflineState();
      if (this.approachBadge) {
        this.approachBadge.className = 'status-pill hdr-approach hidden';
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
    this.updateStabilizedApproach(analytics);

    // 3. Landing report for a touchdown detected by analytics-service
    this.evaluateTouchdown(analytics);
  }

  renderWarnings(warningsList) {
    const now = Date.now();

    // 1. Normalize and strictly deduplicate all incoming alerts into map of key -> norm
    const currentAlerts = new Map();
    (warningsList || []).forEach(w => {
      const norm = this.normalizeAlert(w);
      if (norm && !currentAlerts.has(norm.key)) {
        currentAlerts.set(norm.key, norm);
      }
    });

    // 2. Strict DOM Deduplication: Remove any duplicate elements for the same key in DOM
    if (this.toastContainer) {
      const domElements = this.toastContainer.querySelectorAll('.hud-alert-toast');
      const seenDomKeys = new Set();
      domElements.forEach(el => {
        const k = el.dataset.alertKey;
        if (!k) return;
        if (seenDomKeys.has(k)) {
          // Remove duplicate from DOM immediately!
          el.remove();
        } else {
          seenDomKeys.add(k);
        }
      });
    }

    // 3. Process exiting alerts (those in this.toasts that are no longer in currentAlerts)
    for (const [key, toastData] of this.toasts.entries()) {
      if (!currentAlerts.has(key)) {
        const elapsed = now - (toastData.firstSeen || 0);
        // Hysteresis debounce: keep visible for at least 2500ms before removing to prevent rapid strobing
        if (elapsed >= 2500) {
          if (!toastData.isExiting) {
            toastData.isExiting = true;
            const el = toastData.el;
            if (el) {
              el.classList.add('toast-exiting');
              toastData.exitTimer = setTimeout(() => {
                if (el.parentNode) el.remove();
                this.toasts.delete(key);
                this.activeWarnings.delete(key);
                this.dismissedWarnings.delete(key);
              }, 300);
            } else {
              this.toasts.delete(key);
              this.activeWarnings.delete(key);
              this.dismissedWarnings.delete(key);
            }
          }
        }
      }
    }

    // 4. Render or update currently active alerts (Strict Singleton Pattern)
    for (const [key, norm] of currentAlerts.entries()) {
      if (this.dismissedWarnings.has(key)) continue;

      if (this.toasts.has(key)) {
        const toastData = this.toasts.get(key);
        // If alert was exiting, cancel the exit because the alert is active again!
        if (toastData.isExiting) {
          toastData.isExiting = false;
          if (toastData.exitTimer) {
            clearTimeout(toastData.exitTimer);
            toastData.exitTimer = null;
          }
          if (toastData.el) {
            toastData.el.classList.remove('toast-exiting');
          }
        }
        toastData.lastSeen = now;
        const badge = toastData.el?.querySelector('.warn-badge');
        if (badge && badge.textContent !== norm.label) {
          badge.textContent = norm.label;
        }

        // Ensure DOM element is still attached to toastContainer
        if (toastData.el && !toastData.el.parentNode && this.toastContainer) {
          this.toastContainer.appendChild(toastData.el);
        }
      } else {
        // Double-check DOM: does an element with this key ALREADY exist in toastContainer?
        let existingEl = this.toastContainer?.querySelector(`.hud-alert-toast[data-alert-key="${CSS.escape(key)}"]`);
        
        if (existingEl) {
          // Re-link existing element into map to prevent orphan accumulation
          this.toasts.set(key, {
            el: existingEl,
            firstSeen: now,
            lastSeen: now,
            isRed: norm.isRed,
            label: norm.label,
            isExiting: false,
            exitTimer: null,
          });
          this.activeWarnings.add(key);
          existingEl.classList.remove('toast-exiting');
        } else {
          // Brand new alert: create single stable toast
          const cardType = norm.isRed ? 'master-warning' : 'master-caution';
          const cssClass = norm.isRed ? 'warn-badge-red' : 'warn-badge-amber';

          // Alert text can originate from network input (e.g. a malformed UDP packet's
          // header ends up in telemetry status.errors): build nodes, never innerHTML.
          const toast = document.createElement('div');
          toast.className = `hud-alert-toast ${cardType} toast-entering`;
          toast.setAttribute('role', 'alert');
          toast.dataset.alertKey = key;
          const badgeEl = document.createElement('span');
          badgeEl.className = `warn-badge ${cssClass}`;
          badgeEl.textContent = norm.label;
          badgeEl.title = norm.label;
          const closeBtn = document.createElement('button');
          closeBtn.className = 'hud-alert-close';
          closeBtn.title = 'Сховати';
          closeBtn.textContent = '\u00d7';
          toast.append(badgeEl, closeBtn);

          closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.dismissToast(key);
          });

          this.toastContainer.appendChild(toast);
          this.toasts.set(key, {
            el: toast,
            firstSeen: now,
            lastSeen: now,
            isRed: norm.isRed,
            label: norm.label,
            isExiting: false,
            exitTimer: null,
          });
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

    // 5. Cleanup sweep: remove any DOM toasts whose keys are neither active nor tracked in this.toasts
    if (this.toastContainer) {
      const allToasts = this.toastContainer.querySelectorAll('.hud-alert-toast[data-alert-key]');
      allToasts.forEach(el => {
        const k = el.dataset.alertKey;
        if (k && !currentAlerts.has(k) && !this.toasts.has(k)) {
          el.remove();
        }
      });
    }
  }

  showOfflineState() {
    for (const [key, toastData] of this.toasts.entries()) {
      if (toastData.exitTimer) {
        clearTimeout(toastData.exitTimer);
        toastData.exitTimer = null;
      }
      const el = toastData.el || toastData;
      if (el) {
        el.classList.add('toast-exiting');
        setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
      }
    }
    this.toasts.clear();
    this.activeWarnings.clear();
    this.dismissedWarnings.clear();

    if (this.toastContainer) {
      this.toastContainer.querySelectorAll('.hud-alert-toast').forEach(el => el.remove());
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

  updateStabilizedApproach(analytics) {
    if (!this.approachBadge) return;

    const status = analytics?.stabilized_approach?.status;
    const badge = this.approachBadge;
    const show = (text, cls) => {
      badge.className = `status-pill hdr-approach ${cls}`;
      badge.textContent = text;
    };

    if (status === 'STABILIZED') {
      show('APR: STABLE', 'status-online');
    } else if (status === 'UNSTABILIZED') {
      const failed = analytics.stabilized_approach.failed_rules || [];
      show('APR: UNSTABLE', 'status-error blink');
      badge.title = failed.length ? `Порушено: ${failed.join(', ')}` : 'Захід нестабілізований';
      return;
    } else if (status === 'MONITORING') {
      show('APR: ABOVE GATE', 'status-caution');
    } else if (status === 'UNABLE_TO_EVALUATE_MISSING_DATA') {
      show('APR: nodata', 'status-offline');
    } else {
      // NOT_ON_APPROACH, analytics offline or unknown: nothing to report
      badge.className = 'status-pill hdr-approach hidden';
    }
    badge.title = 'Стабілізований захід (ICAO Doc 8168 / FAA AC 120-108)';
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

  evaluateTouchdown(analytics) {
    if (!this.scoringEnabled) return;
    const result = analytics?.landing_score;
    if (!result || !result.status) return;

    const touchdownId = result.status === 'TOUCHDOWN_EVALUATED'
      ? (result.touchdown_id ?? result.touchdown_time_sec ?? null)
      : null;

    // First analytics frame after (re)connecting: remember what is already there so an
    // old landing is not announced as a new one.
    if (this.lastTouchdownId === undefined) {
      this.lastTouchdownId = touchdownId;
      return;
    }
    if (touchdownId === null || touchdownId === this.lastTouchdownId) return;

    this.lastTouchdownId = touchdownId;
    this.showLandingReport(result);
  }

  showLandingReport(result) {
    if (!this.scoringEnabled) return;
    this.landingReportData = result;
    if (!this.reportCardModal) return;

    const breakdown = result.breakdown || {};
    const fmt = (value, digits, unit) =>
      (typeof value === 'number' && Number.isFinite(value)) ? `${value.toFixed(digits)} ${unit}` : 'nodata';
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    const score = result.landing_score;
    const scoreColor = score >= 80 ? '#22c55e' : (score >= 65 ? '#eab308' : '#ef4444');
    setText('rpt-score-val', typeof score === 'number' ? `${score.toFixed(1)} / 100` : 'nodata');
    setText('rpt-grade-val', result.rating || '');
    const scoreEl = document.getElementById('rpt-score-val');
    if (scoreEl) scoreEl.style.color = scoreColor;

    setText('rpt-vs-val', fmt(breakdown.vertical_speed?.touchdown_vsi_fpm, 0, 'FPM'));
    setText('rpt-g-val', fmt(breakdown.vertical_g_force?.touchdown_g_load, 2, 'G'));
    setText('rpt-cl-val', fmt(breakdown.centerline_offset?.centerline_offset_m, 1, 'м'));
    setText('rpt-roll-val', fmt(breakdown.roll_angle?.roll_at_touchdown_deg, 1, '°'));
    const t = result.touchdown_time_sec;
    setText('rpt-meta-val', typeof t === 'number' ? `Торкання на t=${t.toFixed(1)} с запису` : '');

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
    this.closeLandingReport();
  }
}

window.AlertsAndScoringManager = AlertsAndScoringManager;
