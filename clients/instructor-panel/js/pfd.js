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

    // Autopilot & Flight Director real-time state
    this.apEngaged = false;
    this.fdActive = false;
    this.headingMode = false;
    this.altitudeMode = false;
    this.navMode = false;
    this.approachMode = false;
    this.targetAltitude = null;
    this.targetHeading = null;
    this.targetCourse = null;
    this.targetSpeed = null;
    this.fdPitch = null;
    this.fdRoll = null;

    // Altimeter Barometric Pressure Setting (inHg)
    this.baroSetting = 29.92;
    
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
        this.airspeed = Math.max(0, this.telemetry.indicated_airspeed_kt);
      }
      // Primary altitude tape displays Indicated Altitude based on barometric setting!
      const altInd = this.telemetry.altitude_ind_ft ?? this.telemetry.position?.altitude_ind_ft;
      if (altInd !== null && altInd !== undefined && !isNaN(altInd)) {
        this.altitude = Number(altInd);
      } else if (this.telemetry.altitude_msl_ft !== null && this.telemetry.altitude_msl_ft !== undefined) {
        this.altitude = this.telemetry.altitude_msl_ft;
      }
      const hdg = this.telemetry.heading_mag_deg ?? this.telemetry.heading_true_deg;
      if (hdg !== null && hdg !== undefined) {
        this.heading = hdg;
      }
      if (this.telemetry.vertical_speed_fpm !== null && this.telemetry.vertical_speed_fpm !== undefined) {
        this.verticalSpeed = this.telemetry.vertical_speed_fpm;
      }

      // Autopilot & Flight Director telemetry mapping
      const ap = (this.telemetry.autopilot && typeof this.telemetry.autopilot === 'object') ? this.telemetry.autopilot : {};
      this.apEngaged = Boolean(this.telemetry.ap_engaged ?? ap.ap_engaged);
      this.fdActive = Boolean(this.telemetry.fd_active ?? ap.fd_active ?? this.apEngaged);
      this.headingMode = Boolean(this.telemetry.heading_mode ?? ap.heading_mode);
      this.altitudeMode = Boolean(this.telemetry.altitude_mode ?? ap.altitude_mode);
      this.navMode = Boolean(this.telemetry.nav_mode ?? ap.nav_mode);
      this.approachMode = Boolean(this.telemetry.approach_mode ?? ap.approach_mode);

      this.targetAltitude = this.telemetry.target_altitude_ft ?? ap.target_altitude_ft ?? null;
      this.targetHeading = this.telemetry.target_heading_deg ?? ap.target_heading_deg ?? null;
      this.targetCourse = this.telemetry.target_course_deg ?? ap.target_course_deg ?? null;
      this.targetSpeed = this.telemetry.target_speed_kt ?? ap.target_speed_kt ?? null;
      this.fdPitch = this.telemetry.fd_pitch_deg ?? ap.fd_pitch_deg ?? null;
      this.fdRoll = this.telemetry.fd_roll_deg ?? ap.fd_roll_deg ?? null;

      // Barometric Pressure setting (inHg, e.g. 28.70, 29.92)
      const baro = this.telemetry.barometer_setting_inhg ?? (this.telemetry.position ? this.telemetry.position.barometer_setting_inhg : null);
      if (baro !== null && baro !== undefined && !isNaN(baro)) {
        this.baroSetting = Number(baro);
      }
    } else {
      this.apEngaged = false;
      this.fdActive = false;
      this.headingMode = false;
      this.altitudeMode = false;
      this.navMode = false;
      this.approachMode = false;
      this.targetAltitude = null;
      this.targetHeading = null;
      this.targetCourse = null;
      this.targetSpeed = null;
      this.fdPitch = null;
      this.fdRoll = null;
      this.baroSetting = 29.92;
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

    // 1. Render Attitude Director Indicator (ADI) with Flight Director
    if (hasAttitude) {
      this.drawADI(adiX, adiY, adiW, adiH, this.pitch, this.roll, this.fdActive, this.fdPitch, this.fdRoll);
    } else {
      this.drawFailBox(adiX, adiY, adiW, adiH, 'ATT FAIL', true);
    }

    // 2. Render Airspeed Tape (Left)
    if (hasAirspeed) {
      this.drawAirspeedTape(0, adiY, tapeWidth, adiH, this.airspeed, this.targetSpeed);
    } else {
      this.drawFailBox(0, adiY, tapeWidth, adiH, 'IAS FAIL', false);
    }

    // 3. Render Altitude Tape & VSI (Right) with Target Altitude & Baro Setting
    if (hasAltitude) {
      this.drawAltitudeTape(w - tapeWidth, adiY, tapeWidth, adiH, this.altitude, hasVS ? this.verticalSpeed : null, this.targetAltitude, this.baroSetting);
    } else {
      this.drawFailBox(w - tapeWidth, adiY, tapeWidth, adiH, 'ALT FAIL', false);
    }

    // 4. Render Heading Tape (Bottom) with Desired Heading & Course Bug
    if (hasHeading) {
      this.drawHeadingTape(adiX, h - headingHeight, adiW, headingHeight, this.heading, this.targetHeading, this.targetCourse);
    } else {
      this.drawFailBox(adiX, h - headingHeight, adiW, headingHeight, 'HDG FAIL', false);
    }

    // 5. Render Top Mode / Annunciator Bar (Dynamic AP/FD/HDG/ALT status)
    this.drawTopBar(0, 0, w, topBarHeight);

    requestAnimationFrame(this.render);
  }

  /**
   * Draw Artificial Horizon, Pitch Ladder, Roll Arc, Aircraft Symbol, and Flight Director
   */
  drawADI(x, y, w, h, pitch, roll, fdActive = false, fdPitch = null, fdRoll = null) {
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

    // Flight Director Command Bars (Garmin G1000 Single-Cue Magenta V-Bar)
    if (fdActive) {
      ctx.save();
      const cmdPitch = (fdPitch !== null && fdPitch !== undefined) ? fdPitch : pitch;
      const cmdRoll = (fdRoll !== null && fdRoll !== undefined) ? fdRoll : 0;
      
      const fdY = cy - ((cmdPitch - pitch) * pixelsPerDeg);
      
      ctx.translate(cx, fdY);
      ctx.rotate((-cmdRoll * Math.PI) / 180);

      // Magenta Flight Director V-bar (Delta chevron cue)
      ctx.fillStyle = '#d946ef'; // Authentic avionics magenta / violet
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;

      // Left Wing of V-bar
      ctx.beginPath();
      ctx.moveTo(-wingW - 14, 2);
      ctx.lineTo(-14, -7);
      ctx.lineTo(-14, -1);
      ctx.lineTo(-wingW - 14, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Right Wing of V-bar
      ctx.beginPath();
      ctx.moveTo(wingW + 14, 2);
      ctx.lineTo(14, -7);
      ctx.lineTo(14, -1);
      ctx.lineTo(wingW + 14, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Center Peak of V-bar
      ctx.beginPath();
      ctx.moveTo(-14, -7);
      ctx.lineTo(0, -15);
      ctx.lineTo(14, -7);
      ctx.lineTo(14, -1);
      ctx.lineTo(0, -9);
      ctx.lineTo(-14, -1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }

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
  drawAirspeedTape(x, y, w, h, speed, targetSpeed = null) {
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

    // Garmin G1000 authentic behavior: moving tape parks at 20 kt minimum!
    const isTapeAlive = speed >= 20;
    const tapeSpeed = Math.max(20, speed);

    // Speed bands (Cessna 172SP: Vso=40, Vs1=48, Vfe=85, Vno=129, Vne=163)
    const bands = [
      { min: 40, max: 85, color: '#ffffff', width: 6 }, // Flap range (White)
      { min: 48, max: 129, color: '#22c55e', width: 6 }, // Normal range (Green)
      { min: 129, max: 163, color: '#eab308', width: 6 }, // Caution range (Yellow)
      { min: 163, max: 200, color: '#ef4444', width: 6 }, // Red line (Vne)
    ];

    bands.forEach(b => {
      const yTop = cy - (b.max - tapeSpeed) * pxPerKnot;
      const yBottom = cy - (b.min - tapeSpeed) * pxPerKnot;
      ctx.fillStyle = b.color;
      ctx.fillRect(x + w - 10, yTop, b.width, yBottom - yTop);
    });

    // Speed Ticks and Numbers
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.font = 'bold 13px "Consolas", "Roboto", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const minSpd = Math.max(20, Math.floor((tapeSpeed - 40) / 10) * 10);
    const maxSpd = Math.ceil((tapeSpeed + 40) / 10) * 10;

    for (let s = minSpd; s <= maxSpd; s += 5) {
      if (s < 20) continue;
      const sy = cy - (s - tapeSpeed) * pxPerKnot;
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
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;

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
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px "Consolas", "Roboto", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    if (!isTapeAlive) {
      // Authentic G1000: dashes when below minimum measurable speed (20 kt)
      ctx.fillText('- - -', x + boxW - 12, cy);
    } else {
      ctx.fillText(Math.round(speed).toString(), x + boxW - 12, cy);
    }

    // Label
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('IAS', x + 5, y + 14);

    // Selected Target Airspeed Bug & Readout
    if (targetSpeed !== null && targetSpeed !== undefined && targetSpeed > 0) {
      const tgtY = cy - (targetSpeed - tapeSpeed) * pxPerKnot;
      if (tgtY >= y + 10 && tgtY <= y + h - 10) {
        ctx.fillStyle = '#38bdf8';
        ctx.strokeStyle = '#020617';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + w - 2, tgtY);
        ctx.lineTo(x + w - 10, tgtY - 5);
        ctx.lineTo(x + w - 10, tgtY + 5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Draw Moving Altitude Tape, Vertical Speed Indicator, Target Altitude Bug, and Baro Box
   */
  drawAltitudeTape(x, y, w, h, altitude, vs, targetAltitude = null, baroSetting = 29.92) {
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
      // Do not draw ticks into the top or bottom annunciator window areas
      if (ay > y + h - 28 || ay < y + 26) continue;

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

    // Selected Target Altitude Bug & Label (Authentic Garmin G1000 cyan bracket bug on tape)
    if (targetAltitude !== null && targetAltitude !== undefined) {
      const tgtY = cy - (targetAltitude - altitude) * pxPerFoot;
      if (tgtY >= y + 26 && tgtY <= y + h - 28) {
        ctx.fillStyle = '#06b6d4'; // Cyan
        ctx.strokeStyle = '#0891b2';
        ctx.lineWidth = 1.2;

        // Draw G1000 style cyan bracket tab on the left edge of the tape
        const bugW = 12;
        const bugH = 20;
        ctx.beginPath();
        ctx.moveTo(x + 2, tgtY - bugH / 2);
        ctx.lineTo(x + 2 + bugW, tgtY - bugH / 2);
        ctx.lineTo(x + 2 + bugW, tgtY - 4);
        ctx.lineTo(x + 2 + bugW + 5, tgtY); // triangular notch pointing right at tick
        ctx.lineTo(x + 2 + bugW, tgtY + 4);
        ctx.lineTo(x + 2 + bugW, tgtY + bugH / 2);
        ctx.lineTo(x + 2, tgtY + bugH / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Numerical label right next to bug if not overlapping the center drum
        if (Math.abs(tgtY - cy) > 22) {
          ctx.fillStyle = '#06b6d4';
          ctx.font = 'bold 11px "Consolas", monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(Math.round(targetAltitude).toString(), x + bugW + 9, tgtY);
        }
      }
    }

    // Current Altitude Readout Pointer (Center drum window)
    const boxW = w - 16;
    const boxH = 28;
    ctx.fillStyle = '#000000';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;

    ctx.beginPath();
    ctx.moveTo(x + 8, cy);
    ctx.lineTo(x + 16, cy - boxH / 2);
    ctx.lineTo(x + 8 + boxW, cy - boxH / 2);
    ctx.lineTo(x + 8 + boxW, cy + boxH / 2);
    ctx.lineTo(x + 16, cy + boxH / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Altitude digits (Garmin G1000 white digits on black background)
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px "Consolas", "Roboto", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(altitude).toString(), x + 20, cy);

    // Top Selected Altitude Window (G1000 cyan readout box)
    if (targetAltitude !== null && targetAltitude !== undefined) {
      const selBoxW = w - 14;
      const selBoxH = 20;
      ctx.fillStyle = '#000000';
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x + 7, y + 4, selBoxW, selBoxH);
      ctx.strokeRect(x + 7, y + 4, selBoxW, selBoxH);

      ctx.fillStyle = '#06b6d4';
      ctx.font = 'bold 12px "Consolas", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(targetAltitude)}`, x + 7 + selBoxW / 2, y + 4 + selBoxH / 2);
    } else {
      // Altitude label
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('ALT', x + w - 6, y + 14);
    }

    // Bottom Barometric Pressure Setting Window (Garmin G1000 authentic cyan box)
    const baroH = 22;
    const baroW = w - 4;
    const baroX = x + 2;
    const baroY = y + h - baroH - 2;

    // Solid black background to completely mask ticks & tape
    ctx.fillStyle = '#000000';
    ctx.fillRect(baroX, baroY, baroW, baroH);

    // Crisp light grey / white border (matches G1000 screenshot exactly)
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(baroX, baroY, baroW, baroH);

    // Formatted baro setting (e.g. 29.06 IN)
    const baroNum = (typeof baroSetting === 'number' && !isNaN(baroSetting) && baroSetting > 0) ? baroSetting : 29.92;
    const baroText = `${baroNum.toFixed(2)} IN`;

    ctx.fillStyle = '#00f0ff'; // Bright Garmin cyan
    ctx.font = 'bold 12px "Consolas", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(baroText, baroX + baroW / 2, baroY + baroH / 2);

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
   * Draw Moving Heading Tape / Compass Arc with Desired Heading & Course Bug
   */
  drawHeadingTape(x, y, w, h, heading, targetHeading = null, targetCourse = null) {
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

    // ----------------- Desired Heading Bug (Garmin G1000 Cyan Bracket Bug) -----------------
    let bugOnScreen = false;
    let bugDiff = 0;
    if (targetHeading !== null && targetHeading !== undefined) {
      let diff = (targetHeading - hdg) % 360;
      if (diff < -180) diff += 360;
      if (diff > 180) diff -= 360;
      bugDiff = diff;
      const bugX = cx + diff * pxPerDeg;

      if (bugX >= x + 10 && bugX <= x + w - 10) {
        bugOnScreen = true;
        const bw = 18;
        const bh = 14;
        ctx.fillStyle = 'rgba(56, 189, 248, 0.45)';
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.0;

        ctx.beginPath();
        ctx.moveTo(bugX - bw / 2, y + bh);
        ctx.lineTo(bugX - bw / 2, y + 1);
        ctx.lineTo(bugX + bw / 2, y + 1);
        ctx.lineTo(bugX + bw / 2, y + bh);
        ctx.stroke();
        ctx.fillRect(bugX - bw / 2, y + 1, bw, bh - 1);

        // Vertical cyan dashed guide tick down the tape
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
        ctx.lineWidth = 1.0;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(bugX, y + bh);
        ctx.lineTo(bugX, y + h - 28);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ----------------- Desired Course Needle (Magenta Pointer) -----------------
    if (targetCourse !== null && targetCourse !== undefined) {
      let crsDiff = (targetCourse - hdg) % 360;
      if (crsDiff < -180) crsDiff += 360;
      if (crsDiff > 180) crsDiff -= 360;
      const crsX = cx + crsDiff * pxPerDeg;

      if (crsX >= x + 10 && crsX <= x + w - 10) {
        ctx.fillStyle = '#e056fd';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(crsX, y + 2);
        ctx.lineTo(crsX - 6, y + 12);
        ctx.lineTo(crsX - 2, y + 12);
        ctx.lineTo(crsX - 2, y + 24);
        ctx.lineTo(crsX + 2, y + 24);
        ctx.lineTo(crsX + 2, y + 12);
        ctx.lineTo(crsX + 6, y + 12);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // Lubber Line (Center reference triangle - Actual Aircraft Heading)
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx - 7, y + 11);
    ctx.lineTo(cx + 7, y + 11);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Actual Heading Readout Box (Center)
    const boxW = 56;
    const boxH = 22;
    ctx.fillStyle = '#020617';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8;
    ctx.fillRect(cx - boxW / 2, y + h - boxH - 4, boxW, boxH);
    ctx.strokeRect(cx - boxW / 2, y + h - boxH - 4, boxW, boxH);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px "Consolas", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(hdg).toString().padStart(3, '0')}°`, cx, y + h - boxH / 2 - 4);

    // Left Overlay Badge: Selected Desired Heading (G1000 Cyan Box: HDG 127°)
    if (targetHeading !== null && targetHeading !== undefined) {
      const hdgBoxW = 82;
      const hdgBoxH = 21;
      const hdgBoxX = x + 6;
      const hdgBoxY = y + h - hdgBoxH - 5;

      ctx.fillStyle = 'rgba(2, 6, 23, 0.88)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.fillRect(hdgBoxX, hdgBoxY, hdgBoxW, hdgBoxH);
      ctx.strokeRect(hdgBoxX, hdgBoxY, hdgBoxW, hdgBoxH);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 11px "Consolas", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const arrowIndicator = !bugOnScreen ? (bugDiff < 0 ? '◄ ' : ' ►') : '';
      ctx.fillText(`HDG ${Math.round(targetHeading).toString().padStart(3, '0')}°${arrowIndicator}`, hdgBoxX + hdgBoxW / 2, hdgBoxY + hdgBoxH / 2);
    }

    // Right Overlay Badge: Desired Course (G1000 Magenta Box: CRS 354°)
    if (targetCourse !== null && targetCourse !== undefined) {
      const crsBoxW = 76;
      const crsBoxH = 21;
      const crsBoxX = x + w - crsBoxW - 6;
      const crsBoxY = y + h - crsBoxH - 5;

      ctx.fillStyle = 'rgba(2, 6, 23, 0.88)';
      ctx.strokeStyle = '#d946ef';
      ctx.lineWidth = 1.5;
      ctx.fillRect(crsBoxX, crsBoxY, crsBoxW, crsBoxH);
      ctx.strokeRect(crsBoxX, crsBoxY, crsBoxW, crsBoxH);

      ctx.fillStyle = '#f0abfc';
      ctx.font = 'bold 11px "Consolas", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`CRS ${Math.round(targetCourse).toString().padStart(3, '0')}°`, crsBoxX + crsBoxW / 2, crsBoxY + crsBoxH / 2);
    }

    ctx.restore();
  }

  /**
   * Top Autopilot / Flight Mode Annunciator Bar (Dynamic AP / FD / HDG / ALT Status)
   */
  drawTopBar(x, y, w, h) {
    const ctx = this.ctx;
    ctx.fillStyle = '#080d16';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);

    ctx.textBaseline = 'middle';
    const pillY = y + 7;
    const pillH = h - 14;
    let curX = x + 10;

    // Helper to draw discrete AFCS annunciator pill badges
    const drawModePill = (label, active, activeColor = '#4ade80', subVal = null, subColor = '#38bdf8') => {
      ctx.font = 'bold 11px "Consolas", monospace';
      const mainW = ctx.measureText(label).width + 14;
      const subW = (subVal && active) ? (ctx.measureText(subVal).width + 8) : 0;
      const totalW = mainW + subW;

      if (active) {
        ctx.fillStyle = 'rgba(34, 197, 94, 0.2)';
        ctx.strokeStyle = activeColor;
        ctx.lineWidth = 1.2;
      } else {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.5)';
        ctx.strokeStyle = 'rgba(71, 85, 105, 0.35)';
        ctx.lineWidth = 1.0;
      }

      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(curX, pillY, totalW, pillH, 3);
      } else {
        ctx.rect(curX, pillY, totalW, pillH);
      }
      ctx.fill();
      ctx.stroke();

      // Main label
      ctx.textAlign = 'left';
      ctx.fillStyle = active ? activeColor : '#64748b';
      ctx.fillText(label, curX + 7, pillY + pillH / 2);

      // Sub value if active (e.g. 127° or 2000 FT)
      if (active && subVal) {
        ctx.fillStyle = subColor;
        ctx.fillText(subVal, curX + mainW - 4, pillY + pillH / 2);
      }

      curX += totalW + 8;
    };

    // 1. AP (Autopilot Master Servo)
    drawModePill(this.apEngaged ? '● AP' : 'AP OFF', this.apEngaged, '#4ade80');

    // 2. FD (Flight Director Command Bars)
    drawModePill(this.fdActive ? '● FD' : 'FD OFF', this.fdActive, '#f0abfc');

    // 3. Lateral Mode (HDG / NAV)
    if (this.headingMode) {
      const hdgText = this.targetHeading !== null ? `${Math.round(this.targetHeading)}°` : '';
      drawModePill('● HDG', true, '#4ade80', hdgText, '#38bdf8');
    } else if (this.navMode) {
      drawModePill('● NAV', true, '#4ade80');
    } else {
      drawModePill('HDG OFF', false);
    }

    // 4. Vertical Mode (ALT / VS)
    if (this.altitudeMode) {
      const altText = this.targetAltitude !== null ? `${Math.round(this.targetAltitude)} FT` : '';
      drawModePill('● ALT', true, '#4ade80', altText, '#e056fd');
    } else {
      drawModePill('ALT OFF', false);
    }

    // Right: Airport / Runway
    ctx.font = 'bold 11px "Consolas", monospace';
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
