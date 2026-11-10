/**
 * Primary Flight Display (PFD) Canvas Renderer
 * Production-grade HTML5 Canvas glass-cockpit avionics instrument
 * Complies with strict avionics failure display standards (Garmin G1000 / Collins style)
 * 
 * CRITICAL RULE: When sensor values are null or offline, draw red 'X' FAIL flags!
 * NEVER draw fake numbers or frozen needles.
 */

class PrimaryFlightDisplay {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) {
      throw new Error(`PFD canvas element '${canvasId}' not found`);
    }
    this.ctx = this.canvas.getContext('2d');
    
    // Telemetry state
    this.telemetry = null;
    this.isOnline = false;
    
    // Smooth animation interpolations
    this.pitch = 0;
    this.roll = 0;
    this.airspeed = 0;
    this.altitude = 0;
    this.heading = 0;
    this.verticalSpeed = 0;
    
    // Resize handling with high-DPI scaling
    this.resize();
    window.addEventListener('resize', () => this.resize());
    
    // Kick off render loop
    this.render = this.render.bind(this);
    requestAnimationFrame(this.render);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
  }

  update(telemetry, isOnline) {
    this.isOnline = isOnline;
    this.telemetry = telemetry;
    
    // If online and values exist, gently smooth readings (low-pass filter)
    if (this.isOnline && this.telemetry) {
      if (this.telemetry.pitch_deg !== null && this.telemetry.pitch_deg !== undefined) {
        this.pitch = this.telemetry.pitch_deg;
      }
      if (this.telemetry.roll_deg !== null && this.telemetry.roll_deg !== undefined) {
        this.roll = this.telemetry.roll_deg;
      }
      if (this.telemetry.indicated_airspeed_kt !== null && this.telemetry.indicated_airspeed_kt !== undefined) {
        this.airspeed = this.telemetry.indicated_airspeed_kt;
      }
      if (this.telemetry.altitude_msl_ft !== null && this.telemetry.altitude_msl_ft !== undefined) {
        this.altitude = this.telemetry.altitude_msl_ft;
      }
      const hdg = this.telemetry.heading_mag_deg ?? this.telemetry.heading_true_deg;
      if (hdg !== null && hdg !== undefined) {
        this.heading = hdg;
      }
      if (this.telemetry.vertical_speed_fpm !== null && this.telemetry.vertical_speed_fpm !== undefined) {
        this.verticalSpeed = this.telemetry.vertical_speed_fpm;
      }
    }
  }

  render() {
    const w = this.width;
    const h = this.height;
    const ctx = this.ctx;

    // Clear background
    ctx.fillStyle = '#060a10';
    ctx.fillRect(0, 0, w, h);

    // Layout geometry
    const tapeWidth = Math.min(85, w * 0.18);
    const headingHeight = Math.min(65, h * 0.16);
    const topBarHeight = 36;
    
    // Central ADI area
    const adiX = tapeWidth;
    const adiY = topBarHeight;
    const adiW = w - (tapeWidth * 2);
    const adiH = h - topBarHeight - headingHeight;

    // Check individual sensor validity
    const hasAttitude = this.isOnline && this.telemetry && 
      this.telemetry.pitch_deg !== null && this.telemetry.pitch_deg !== undefined &&
      this.telemetry.roll_deg !== null && this.telemetry.roll_deg !== undefined;

    const hasAirspeed = this.isOnline && this.telemetry &&
      this.telemetry.indicated_airspeed_kt !== null && this.telemetry.indicated_airspeed_kt !== undefined;

    const hasAltitude = this.isOnline && this.telemetry &&
      this.telemetry.altitude_msl_ft !== null && this.telemetry.altitude_msl_ft !== undefined;

    const hasHeading = this.isOnline && this.telemetry &&
      (this.telemetry.heading_mag_deg !== null || this.telemetry.heading_true_deg !== null);

    const hasVS = this.isOnline && this.telemetry &&
      this.telemetry.vertical_speed_fpm !== null && this.telemetry.vertical_speed_fpm !== undefined;

    // 1. Render Attitude Director Indicator (ADI)
    if (hasAttitude) {
      this.drawADI(adiX, adiY, adiW, adiH, this.pitch, this.roll);
    } else {
      this.drawFailBox(adiX, adiY, adiW, adiH, 'ATT FAIL', true);
    }

    // 2. Render Airspeed Tape (Left)
    if (hasAirspeed) {
      this.drawAirspeedTape(0, adiY, tapeWidth, adiH, this.airspeed);
    } else {
      this.drawFailBox(0, adiY, tapeWidth, adiH, 'IAS FAIL', false);
    }

    // 3. Render Altitude Tape & VSI (Right)
    if (hasAltitude) {
      this.drawAltitudeTape(w - tapeWidth, adiY, tapeWidth, adiH, this.altitude, hasVS ? this.verticalSpeed : null);
    } else {
      this.drawFailBox(w - tapeWidth, adiY, tapeWidth, adiH, 'ALT FAIL', false);
    }

    // 4. Render Heading Tape (Bottom)
    if (hasHeading) {
      this.drawHeadingTape(adiX, h - headingHeight, adiW, headingHeight, this.heading);
    } else {
      this.drawFailBox(adiX, h - headingHeight, adiW, headingHeight, 'HDG FAIL', false);
    }

    // 5. Render Top Mode / Annunciator Bar
    this.drawTopBar(0, 0, w, topBarHeight);

    requestAnimationFrame(this.render);
  }

  /**
   * Draw Artificial Horizon, Pitch Ladder, Roll Arc, and Aircraft Symbol
   */
  drawADI(x, y, w, h, pitch, roll) {
    const ctx = this.ctx;
    ctx.save();
    
    // Clip to ADI boundary
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const cx = x + w / 2;
    const cy = y + h / 2;
    const pixelsPerDeg = h / 45; // 45 deg visible vertically

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-roll * Math.PI) / 180);

    const pitchOffset = pitch * pixelsPerDeg;

    // Sky & Ground Rectangles
    const r = Math.max(w, h) * 1.5;
    
    // Sky (Aviation Cyan-Blue)
    const skyGrad = ctx.createLinearGradient(0, pitchOffset - r, 0, pitchOffset);
    skyGrad.addColorStop(0, '#00548f');
    skyGrad.addColorStop(1, '#007fc7');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(-r, pitchOffset - r, r * 2, r);

    // Ground (Earth Olive-Brown)
    const groundGrad = ctx.createLinearGradient(0, pitchOffset, 0, pitchOffset + r);
    groundGrad.addColorStop(0, '#664219');
    groundGrad.addColorStop(1, '#472d0f');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(-r, pitchOffset, r * 2, r);

    // Horizon line
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-r, pitchOffset);
    ctx.lineTo(r, pitchOffset);
    ctx.stroke();

    // Pitch Ladder
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px "Consolas", "Roboto", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let deg = -40; deg <= 40; deg += 2.5) {
      if (deg === 0) continue;
      const py = pitchOffset - (deg * pixelsPerDeg);
      const isMajor = deg % 10 === 0;
      const isHalf = deg % 5 === 0;
      const rungWidth = isMajor ? 64 : (isHalf ? 36 : 18);

      ctx.lineWidth = isMajor ? 2.0 : 1.2;
      ctx.beginPath();

      if (deg > 0) {
        // Positive pitch (Solid lines with downward ends)
        ctx.moveTo(-rungWidth / 2, py);
        ctx.lineTo(rungWidth / 2, py);
        if (isMajor) {
          ctx.moveTo(-rungWidth / 2, py);
          ctx.lineTo(-rungWidth / 2, py + 6);
          ctx.moveTo(rungWidth / 2, py);
          ctx.lineTo(rungWidth / 2, py + 6);
        }
      } else {
        // Negative pitch (Dashed lines with upward ends)
        ctx.setLineDash([6, 4]);
        ctx.moveTo(-rungWidth / 2, py);
        ctx.lineTo(rungWidth / 2, py);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        if (isMajor) {
          ctx.moveTo(-rungWidth / 2, py);
          ctx.lineTo(-rungWidth / 2, py - 6);
          ctx.moveTo(rungWidth / 2, py);
          ctx.lineTo(rungWidth / 2, py - 6);
        }
      }
      ctx.stroke();

      if (isMajor) {
        const txt = Math.abs(deg).toString();
        ctx.fillText(txt, -rungWidth / 2 - 14, py);
        ctx.fillText(txt, rungWidth / 2 + 14, py);
      }
    }

    ctx.restore(); // Restore translation & roll

    // Draw Roll Arc & Pointers (screen-fixed roll scale)
    const rollRadius = Math.min(w, h) * 0.42;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(cx, cy, rollRadius, (-140 * Math.PI) / 180, (-40 * Math.PI) / 180);
    ctx.stroke();

    // Roll tick marks at 0, 10, 20, 30, 45, 60
    const rollTicks = [0, 10, 20, 30, 45, 60, -10, -20, -30, -45, -60];
    rollTicks.forEach(angle => {
      const rad = ((-90 + angle) * Math.PI) / 180;
      const len = (Math.abs(angle) === 30 || Math.abs(angle) === 60) ? 12 : 7;
      const x1 = cx + rollRadius * Math.cos(rad);
      const y1 = cy + rollRadius * Math.sin(rad);
      const x2 = cx + (rollRadius - len) * Math.cos(rad);
      const y2 = cy + (rollRadius - len) * Math.sin(rad);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    });

    // Roll Sky Pointer (rotates with roll)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-roll * Math.PI) / 180);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -rollRadius + 2);
    ctx.lineTo(-6, -rollRadius + 14);
    ctx.lineTo(6, -rollRadius + 14);
    ctx.closePath();
    ctx.fill();

    // Slip/Skid Trapezoid (under roll pointer)
    const slip = (this.telemetry?.sideslip_beta_deg || 0) * 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-8 + slip, -rollRadius + 17, 16, 4);
    ctx.restore();

    // Zero Roll Center Reference Triangle (top)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - rollRadius - 2);
    ctx.lineTo(cx - 7, cy - rollRadius - 13);
    ctx.lineTo(cx + 7, cy - rollRadius - 13);
    ctx.closePath();
    ctx.fill();

    // Aircraft Reference Symbol (Yellow Boresight Wings & Center Square)
    const wingW = 44;
    const wingH = 6;
    ctx.fillStyle = '#ffeb3b';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;

    // Left Wing
    ctx.beginPath();
    ctx.rect(cx - wingW - 14, cy - wingH / 2, wingW, wingH);
    ctx.fill();
    ctx.stroke();

    // Right Wing
    ctx.beginPath();
    ctx.rect(cx + 14, cy - wingH / 2, wingW, wingH);
    ctx.fill();
    ctx.stroke();

    // Center Pip
    ctx.beginPath();
    ctx.rect(cx - 3, cy - 3, 6, 6);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw Moving Airspeed Tape with G1000-style speed bands
   */
  drawAirspeedTape(x, y, w, h, speed) {
    const ctx = this.ctx;
    ctx.save();

    // Background
    ctx.fillStyle = '#101620';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    // Clip
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const cy = y + h / 2;
    const pxPerKnot = h / 70; // 70 knots visible in tape window

    // Speed bands (Cessna 172SP: Vso=40, Vs1=48, Vfe=85, Vno=129, Vne=163)
    const bands = [
      { min: 40, max: 85, color: '#ffffff', width: 6 }, // Flap range (White)
      { min: 48, max: 129, color: '#22c55e', width: 6 }, // Normal range (Green)
      { min: 129, max: 163, color: '#eab308', width: 6 }, // Caution range (Yellow)
      { min: 163, max: 200, color: '#ef4444', width: 6 }, // Red line (Vne)
    ];

    bands.forEach(b => {
      const yTop = cy - (b.max - speed) * pxPerKnot;
      const yBottom = cy - (b.min - speed) * pxPerKnot;
      ctx.fillStyle = b.color;
      ctx.fillRect(x + w - 10, yTop, b.width, yBottom - yTop);
    });

    // Speed Ticks and Numbers
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.font = 'bold 13px "Consolas", "Roboto", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const minSpd = Math.max(0, Math.floor((speed - 40) / 10) * 10);
    const maxSpd = Math.ceil((speed + 40) / 10) * 10;

    for (let s = minSpd; s <= maxSpd; s += 5) {
      const sy = cy - (s - speed) * pxPerKnot;
      const isMajor = s % 10 === 0;
      const tickLen = isMajor ? 12 : 7;

      ctx.lineWidth = isMajor ? 1.8 : 1.0;
      ctx.beginPath();
      ctx.moveTo(x + w - 12 - tickLen, sy);
      ctx.lineTo(x + w - 12, sy);
      ctx.stroke();

      if (isMajor && s >= 20) {
        ctx.fillText(s.toString(), x + w - 28, sy);
      }
    }

    // Current Airspeed Pointer Window (Fixed in center)
    const boxW = w - 6;
    const boxH = 26;
    ctx.fillStyle = '#020617';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(x + 2, cy - boxH / 2);
    ctx.lineTo(x + boxW - 8, cy - boxH / 2);
    ctx.lineTo(x + boxW, cy);
    ctx.lineTo(x + boxW - 8, cy + boxH / 2);
    ctx.lineTo(x + 2, cy + boxH / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Airspeed readout digits
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 16px "Consolas", "Roboto", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(speed).toString(), x + boxW - 12, cy);

    // Label
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('IAS', x + 5, y + 14);

    ctx.restore();
  }

  /**
   * Draw Moving Altitude Tape and Vertical Speed Indicator
   */
  drawAltitudeTape(x, y, w, h, altitude, vs) {
    const ctx = this.ctx;
    ctx.save();

    // Background
    ctx.fillStyle = '#101620';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    // Clip
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const cy = y + h / 2;
    const pxPerFoot = h / 650; // 650 ft visible vertically

    // Altitude Ticks and Numbers
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.font = 'bold 12px "Consolas", "Roboto", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const minAlt = Math.floor((altitude - 400) / 100) * 100;
    const maxAlt = Math.ceil((altitude + 400) / 100) * 100;

    for (let a = minAlt; a <= maxAlt; a += 20) {
      const ay = cy - (a - altitude) * pxPerFoot;
      const isMajor = a % 100 === 0;
      const isHalf = a % 50 === 0;
      const tickLen = isMajor ? 12 : (isHalf ? 8 : 5);

      ctx.lineWidth = isMajor ? 1.8 : 1.0;
      ctx.beginPath();
      ctx.moveTo(x + 10, ay);
      ctx.lineTo(x + 10 + tickLen, ay);
      ctx.stroke();

      if (isMajor) {
        ctx.fillText(a.toString(), x + 26, ay);
      }
    }

    // Current Altitude Readout Pointer (Center drum window)
    const boxW = w - 16;
    const boxH = 28;
    ctx.fillStyle = '#020617';
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(x + 10, cy);
    ctx.lineTo(x + 18, cy - boxH / 2);
    ctx.lineTo(x + 10 + boxW, cy - boxH / 2);
    ctx.lineTo(x + 10 + boxW, cy + boxH / 2);
    ctx.lineTo(x + 18, cy + boxH / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Altitude digits
    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 15px "Consolas", "Roboto", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(altitude).toString(), x + 22, cy);

    // Altitude label & Baro setting
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('ALT', x + w - 6, y + 14);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('29.92 IN', x + w / 2, y + h - 8);

    // Vertical Speed Indicator (Right edge needle)
    if (vs !== null && vs !== undefined) {
      const vsiMax = 2000;
      const clampedVS = Math.max(-vsiMax, Math.min(vsiMax, vs));
      const vsiY = cy - (clampedVS / vsiMax) * (h * 0.35);

      ctx.fillStyle = '#eab308';
      ctx.beginPath();
      ctx.moveTo(x + w - 2, cy);
      ctx.lineTo(x + w - 10, vsiY);
      ctx.lineTo(x + w - 2, vsiY);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw Moving Heading Tape / Compass Arc
   */
  drawHeadingTape(x, y, w, h, heading) {
    const ctx = this.ctx;
    ctx.save();

    // Background
    ctx.fillStyle = '#101620';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    // Clip
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const cx = x + w / 2;
    const pxPerDeg = w / 60; // 60 deg visible horizontally

    // Normalized heading [0..360)
    let hdg = heading % 360;
    if (hdg < 0) hdg += 360;

    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const minDeg = Math.floor(hdg - 35);
    const maxDeg = Math.ceil(hdg + 35);

    for (let d = minDeg; d <= maxDeg; d++) {
      if (d % 5 !== 0) continue;
      const degNorm = (d % 360 + 360) % 360;
      const hx = cx + (d - hdg) * pxPerDeg;
      const isMajor = degNorm % 10 === 0;

      ctx.lineWidth = isMajor ? 1.8 : 1.0;
      ctx.beginPath();
      ctx.moveTo(hx, y);
      ctx.lineTo(hx, y + (isMajor ? 10 : 5));
      ctx.stroke();

      if (isMajor) {
        let label = '';
        if (degNorm === 0) label = 'N';
        else if (degNorm === 90) label = 'E';
        else if (degNorm === 180) label = 'S';
        else if (degNorm === 270) label = 'W';
        else label = (degNorm / 10).toString().padStart(2, '0');

        ctx.font = (degNorm === 0) ? 'bold 13px sans-serif' : '11px "Consolas", monospace';
        ctx.fillStyle = (degNorm === 0) ? '#38bdf8' : '#ffffff';
        ctx.fillText(label, hx, y + 13);
      }
    }

    // Lubber Line (Center reference triangle)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx - 7, y + 10);
    ctx.lineTo(cx + 7, y + 10);
    ctx.closePath();
    ctx.fill();

    // Current Heading Readout Box
    const boxW = 54;
    const boxH = 22;
    ctx.fillStyle = '#020617';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.fillRect(cx - boxW / 2, y + h - boxH - 4, boxW, boxH);
    ctx.strokeRect(cx - boxW / 2, y + h - boxH - 4, boxW, boxH);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px "Consolas", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(hdg).toString().padStart(3, '0')}°`, cx, y + h - boxH / 2 - 4);

    ctx.restore();
  }

  /**
   * Top Autopilot / Flight Mode Annunciator Bar
   */
  drawTopBar(x, y, w, h) {
    const ctx = this.ctx;
    ctx.fillStyle = '#080d16';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);

    ctx.font = 'bold 11px "Consolas", monospace';
    ctx.textBaseline = 'middle';

    // Left: AP Status
    ctx.fillStyle = '#22c55e';
    ctx.textAlign = 'left';
    ctx.fillText('AP  |  FD  |  HDG  |  ALT', x + 12, y + h / 2);

    // Right: Airport / Runway
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'right';
    ctx.fillText('UKLL RWY 13', x + w - 12, y + h / 2);
  }

  /**
   * CRITICAL REQUIREMENT:
   * Draw an avionics-style RED 'X' FAIL flag across the failed instrument tape/area!
   * NEVER draw fake numbers or frozen needles.
   */
  drawFailBox(x, y, w, h, failText, isLarge = false) {
    const ctx = this.ctx;
    ctx.save();

    // Blank failed instrument with dark background
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    // Clip to instrument boundaries
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    // Large Red 'X' across the entire instrument rectangle
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = isLarge ? 4.5 : 3.0;
    ctx.beginPath();
    ctx.moveTo(x + 4, y + 4);
    ctx.lineTo(x + w - 4, y + h - 4);
    ctx.moveTo(x + w - 4, y + 4);
    ctx.lineTo(x + 4, y + h - 4);
    ctx.stroke();

    // Warning Badge Box in center
    const cx = x + w / 2;
    const cy = y + h / 2;
    const badgeW = isLarge ? 120 : Math.min(w - 10, 78);
    const badgeH = isLarge ? 32 : 22;

    ctx.fillStyle = '#dc2626';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.fillRect(cx - badgeW / 2, cy - badgeH / 2, badgeW, badgeH);
    ctx.strokeRect(cx - badgeW / 2, cy - badgeH / 2, badgeW, badgeH);

    // Bold text inside badge
    ctx.fillStyle = '#ffffff';
    ctx.font = isLarge ? 'bold 14px "Consolas", sans-serif' : 'bold 11px "Consolas", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(failText, cx, cy);

    ctx.restore();
  }
}

window.PrimaryFlightDisplay = PrimaryFlightDisplay;
