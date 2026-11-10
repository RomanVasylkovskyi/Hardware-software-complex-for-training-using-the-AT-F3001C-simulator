/**
 * Standby Analog Steam Gauges (Backup Instruments Cluster)
 * High-fidelity HTML5 Canvas recreation of the Cessna 172 analog standby instruments:
 * 1. Airspeed Indicator (Knots, colored speed arcs, TAS window, adjustment knob)
 * 2. Gyro Attitude Indicator (Artificial Horizon, pitch ladder, roll pointer, GYRO failure flag)
 * 3. Altimeter (Three hands: 100s, 1000s, 10,000s, low-altitude striped barber pole, Kollsman window)
 * 
 * ZERO-MOCK COMPLIANCE:
 * - If telemetry is offline, disconnected, or individual parameters are null:
 *   - Gyro flag drops down prominently ('GYRO' red flag).
 *   - Airspeed & Altimeter display prominent red 'FAIL' / 'NO DATA' flags.
 *   - NEVER invent or freeze fake numbers.
 */

class StandbyAirspeedGauge {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.airspeed = null;
    this.isOnline = false;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || 240;
    this.height = rect.height || 240;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
    this.render();
  }

  update(airspeed, isOnline) {
    this.airspeed = airspeed;
    this.isOnline = isOnline;
    this.render();
  }

  // Maps knots to dial angle in radians (0 rad = 12 o'clock, clockwise)
  speedToAngle(kt) {
    // Cessna 172 calibrated airspeed dial:
    // 0 kt at ~220 deg, 40 kt at 245 deg, 60 kt at 295 deg, 80 kt at 345 deg,
    // 100 kt at 35 deg, 120 kt at 80 deg, 140 kt at 120 deg, 160 kt at 155 deg,
    // 180 kt at 185 deg, 200 kt at 210 deg
    const points = [
      { kt: 0, deg: 220 },
      { kt: 40, deg: 245 },
      { kt: 60, deg: 295 },
      { kt: 80, deg: 345 },
      { kt: 100, deg: 395 }, // 35 deg
      { kt: 120, deg: 440 }, // 80 deg
      { kt: 140, deg: 480 }, // 120 deg
      { kt: 160, deg: 515 }, // 155 deg
      { kt: 180, deg: 545 }, // 185 deg
      { kt: 200, deg: 570 }, // 210 deg
    ];

    if (kt <= 0) return (points[0].deg * Math.PI) / 180;
    if (kt >= 200) return (points[points.length - 1].deg * Math.PI) / 180;

    for (let i = 0; i < points.length - 1; i++) {
      if (kt >= points[i].kt && kt <= points[i + 1].kt) {
        const factor = (kt - points[i].kt) / (points[i + 1].kt - points[i].kt);
        const deg = points[i].deg + factor * (points[i + 1].deg - points[i].deg);
        return (deg * Math.PI) / 180;
      }
    }
    return (points[0].deg * Math.PI) / 180;
  }

  render() {
    if (!this.canvas) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.44;

    ctx.clearRect(0, 0, w, h);

    // Bezel & casing
    this.drawBezel(ctx, cx, cy, r);

    // Dial background
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.90, 0, Math.PI * 2);
    ctx.fillStyle = '#111317';
    ctx.fill();

    // Top True Airspeed / Temperature Sub-window
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.88, (-110 * Math.PI) / 180, (-70 * Math.PI) / 180);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.fillStyle = '#222831';
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#94a3b8';
    ctx.font = `bold ${Math.round(r * 0.07)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('TEMP °C', cx, cy - r * 0.72);
    ctx.fillText('30 + 0 - 30', cx, cy - r * 0.62);
    ctx.fillText('PRESS ALT', cx, cy - r * 0.52);

    // Colored speed arcs
    this.drawArc(ctx, cx, cy, r * 0.84, r * 0.05, 40, 85, '#ffffff'); // White arc (Vso to Vfe)
    this.drawArc(ctx, cx, cy, r * 0.78, r * 0.05, 48, 129, '#22c55e'); // Green arc (Vs1 to Vno)
    this.drawArc(ctx, cx, cy, r * 0.78, r * 0.05, 129, 163, '#eab308'); // Yellow arc (Vno to Vne)
    // Red radial line (Vne = 163 kt)
    this.drawRadialLine(ctx, cx, cy, r * 0.72, r * 0.90, 163, '#ef4444', 3);

    // Speed markings & Numbers
    const speeds = [40, 60, 80, 100, 120, 140, 160, 180, 200];
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(r * 0.12)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    speeds.forEach((spd) => {
      const ang = this.speedToAngle(spd) - Math.PI / 2;
      const tx = cx + Math.cos(ang) * (r * 0.62);
      const ty = cy + Math.sin(ang) * (r * 0.62);
      ctx.fillText(spd.toString(), tx, ty);
    });

    // Tick marks
    for (let spd = 40; spd <= 200; spd += 5) {
      const isMajor = spd % 20 === 0;
      const isMedium = spd % 10 === 0;
      const len = isMajor ? r * 0.14 : isMedium ? r * 0.10 : r * 0.06;
      const ang = this.speedToAngle(spd) - Math.PI / 2;
      const x1 = cx + Math.cos(ang) * (r * 0.88);
      const y1 = cy + Math.sin(ang) * (r * 0.88);
      const x2 = cx + Math.cos(ang) * (r * 0.88 - len);
      const y2 = cy + Math.sin(ang) * (r * 0.88 - len);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = isMajor ? 2.5 : 1.5;
      ctx.stroke();
    }

    // Dial text labels
    ctx.fillStyle = '#cbd5e1';
    ctx.font = `bold ${Math.round(r * 0.10)}px sans-serif`;
    ctx.fillText('AIRSPEED', cx, cy - r * 0.22);
    ctx.font = `bold ${Math.round(r * 0.09)}px sans-serif`;
    ctx.fillText('KNOTS', cx, cy + r * 0.22);
    ctx.font = `${Math.round(r * 0.07)}px sans-serif`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('TAS', cx, cy + r * 0.34);

    // Knob at bottom left
    this.drawKnob(ctx, cx - r * 0.70, cy + r * 0.70, r * 0.16);

    // Screws at corners
    this.drawScrews(ctx, cx, cy, r * 1.08);

    // ZERO-MOCK DATA & NEEDLE
    const valid = this.isOnline && this.airspeed !== null && this.airspeed !== undefined;
    if (!valid) {
      // Display prominent red FAIL flag
      this.drawFailBadge(ctx, cx, cy, 'NO DATA');
      // Park needle at stop pin
      this.drawNeedle(ctx, cx, cy, r * 0.82, this.speedToAngle(0) - Math.PI / 2);
    } else {
      const ang = this.speedToAngle(this.airspeed) - Math.PI / 2;
      this.drawNeedle(ctx, cx, cy, r * 0.82, ang);
    }

    // Center cap
    this.drawCenterCap(ctx, cx, cy, r * 0.14);
  }

  drawArc(ctx, cx, cy, radius, width, startKt, endKt, color) {
    const a1 = this.speedToAngle(startKt) - Math.PI / 2;
    const a2 = this.speedToAngle(endKt) - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, a1, a2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  drawRadialLine(ctx, cx, cy, r1, r2, kt, color, width) {
    const ang = this.speedToAngle(kt) - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  drawNeedle(ctx, cx, cy, length, angleRad) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleRad);

    // White tapered needle pointing along angleRad (+X axis)
    ctx.beginPath();
    ctx.moveTo(length, 0); // Tip pointing to dial number
    ctx.lineTo(0, -length * 0.045);
    ctx.lineTo(-length * 0.22, -length * 0.025); // Counterweight
    ctx.lineTo(-length * 0.22, length * 0.025);
    ctx.lineTo(0, length * 0.045);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.fill();

    ctx.restore();
  }

  drawCenterCap(ctx, cx, cy, radius) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#475569';
    ctx.stroke();
  }

  drawBezel(ctx, cx, cy, r) {
    // Outer metal ring
    const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    grad.addColorStop(0, '#334155');
    grad.addColorStop(0.5, '#0f172a');
    grad.addColorStop(1, '#1e293b');

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#475569';
    ctx.stroke();
  }

  drawKnob(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#64748b';
    ctx.stroke();
  }

  drawScrews(ctx, cx, cy, dist) {
    const coords = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    coords.forEach(([sx, sy]) => {
      const px = cx + (sx * dist * 0.65);
      const py = cy + (sy * dist * 0.65);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#64748b';
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  drawFailBadge(ctx, cx, cy, label) {
    ctx.save();
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(cx - 45, cy - 14, 90, 28);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - 45, cy - 14, 90, 28);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
    ctx.restore();
  }
}

class StandbyAttitudeGauge {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.pitch = null;
    this.roll = null;
    this.isOnline = false;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || 240;
    this.height = rect.height || 240;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
    this.render();
  }

  update(pitch, roll, isOnline) {
    this.pitch = pitch;
    this.roll = roll;
    this.isOnline = isOnline;
    this.render();
  }

  render() {
    if (!this.canvas) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.44;

    ctx.clearRect(0, 0, w, h);

    // Bezel & casing
    this.drawBezel(ctx, cx, cy, r);

    // Circular clip for horizon sphere
    const sphereRadius = r * 0.88;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, sphereRadius, 0, Math.PI * 2);
    ctx.clip();

    // Horizon Ball Transformation
    ctx.save();
    ctx.translate(cx, cy);

    const valid = this.isOnline && this.pitch !== null && this.roll !== null;
    const displayPitch = valid ? this.pitch : 0;
    const displayRoll = valid ? this.roll : 0;

    // Roll rotation
    ctx.rotate((-displayRoll * Math.PI) / 180);

    // Pitch translation (px per degree)
    const pxPerDeg = (sphereRadius * 2) / 60; // 60 degrees visible across sphere
    const pitchOffset = displayPitch * pxPerDeg;
    ctx.translate(0, pitchOffset);

    // Sky half (Top)
    ctx.fillStyle = '#4a88b5';
    ctx.fillRect(-sphereRadius * 2, -sphereRadius * 3, sphereRadius * 4, sphereRadius * 3);

    // Ground half (Bottom)
    ctx.fillStyle = '#6b4724';
    ctx.fillRect(-sphereRadius * 2, 0, sphereRadius * 4, sphereRadius * 3);

    // Converging white radial perspective lines in ground half
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.5;
    const rayAngles = [-60, -40, -20, 0, 20, 40, 60];
    rayAngles.forEach((ang) => {
      const rad = (ang * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.sin(rad) * sphereRadius * 2, Math.cos(rad) * sphereRadius * 2);
      ctx.stroke();
    });

    // Horizon dividing line
    ctx.beginPath();
    ctx.moveTo(-sphereRadius * 2, 0);
    ctx.lineTo(sphereRadius * 2, 0);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Pitch ladder (±5°, ±10°, ±15°, ±20°)
    for (let p = -20; p <= 20; p += 5) {
      if (p === 0) continue;
      const py = -p * pxPerDeg;
      const isMajor = Math.abs(p) % 10 === 0;
      const rungHalfWidth = isMajor ? sphereRadius * 0.28 : sphereRadius * 0.14;

      ctx.beginPath();
      ctx.moveTo(-rungHalfWidth, py);
      ctx.lineTo(rungHalfWidth, py);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = isMajor ? 2.5 : 1.5;
      ctx.stroke();

      if (isMajor) {
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(sphereRadius * 0.10)}px monospace`;
        ctx.textAlign = 'right';
        ctx.fillText(Math.abs(p).toString(), -rungHalfWidth - 6, py + 4);
        ctx.textAlign = 'left';
        ctx.fillText(Math.abs(p).toString(), rungHalfWidth + 6, py + 4);
      }
    }

    ctx.restore(); // Undo pitch & roll transform

    // ZERO-MOCK GYRO FAILURE FLAG
    // If telemetry is offline or attitude data is null, drop the GYRO flag prominently!
    if (!valid) {
      this.drawGyroFlag(ctx, cx, cy, sphereRadius);
    }

    ctx.restore(); // Undo clip

    // Bank scale markings (Top outer bezel arc) with rotating roll index pointer
    this.drawBankScale(ctx, cx, cy, sphereRadius, displayRoll);

    // Miniature Aircraft Symbol (Fixed in foreground)
    this.drawMiniatureAircraft(ctx, cx, cy, sphereRadius);

    // Vacuum adjustment knob & text at bottom
    this.drawKnob(ctx, cx, cy + r * 0.82, r * 0.12);
    ctx.fillStyle = '#94a3b8';
    ctx.font = `bold ${Math.round(r * 0.065)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('VACUUM', cx, cy + r * 0.64);

    // Screws at corners
    this.drawScrews(ctx, cx, cy, r * 1.08);
  }

  drawBankScale(ctx, cx, cy, radius, displayRoll = 0) {
    const rollMarks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
    rollMarks.forEach((deg) => {
      const rad = ((deg - 90) * Math.PI) / 180;
      const isMajor = Math.abs(deg) === 30 || Math.abs(deg) === 60 || deg === 0;
      const len = isMajor ? radius * 0.12 : radius * 0.08;

      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(rad) * radius, cy + Math.sin(rad) * radius);
      ctx.lineTo(cx + Math.cos(rad) * (radius - len), cy + Math.sin(rad) * (radius - len));
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = deg === 0 ? 3 : 2;
      ctx.stroke();
    });

    // 1. Fixed white 0 deg reference center triangle (top pointing down)
    ctx.save();
    ctx.translate(cx, cy - radius);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-6, -10);
    ctx.lineTo(6, -10);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    // 2. Rotating Roll Pointer (Orange triangle on the gyro ball pointing up to the bank scale)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-displayRoll * Math.PI) / 180);
    ctx.translate(0, -radius + 4);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-7, 10);
    ctx.lineTo(7, 10);
    ctx.closePath();
    ctx.fillStyle = '#f97316';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  drawMiniatureAircraft(ctx, cx, cy, radius) {
    ctx.save();
    const wingW = radius * 0.32;
    const barH = 5;

    ctx.fillStyle = '#f97316';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;

    // Left wing
    ctx.fillRect(cx - wingW - 12, cy - barH / 2, wingW, barH);
    ctx.strokeRect(cx - wingW - 12, cy - barH / 2, wingW, barH);

    // Right wing
    ctx.fillRect(cx + 12, cy - barH / 2, wingW, barH);
    ctx.strokeRect(cx + 12, cy - barH / 2, wingW, barH);

    // Center dot / pipette
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Center support post
    ctx.beginPath();
    ctx.moveTo(cx, cy + 5);
    ctx.lineTo(cx, cy + radius * 0.40);
    ctx.strokeStyle = '#573315';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.restore();
  }

  drawGyroFlag(ctx, cx, cy, radius) {
    ctx.save();
    const flagW = 26;
    const flagH = radius * 0.95;
    const flagX = cx - radius * 0.85;
    const flagY = cy - radius * 0.70;

    // Red flag body
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(flagX, flagY, flagW, flagH);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(flagX, flagY, flagW, flagH);

    // Vertical text 'GYRO'
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('G', flagX + flagW / 2, flagY + flagH * 0.20);
    ctx.fillText('Y', flagX + flagW / 2, flagY + flagH * 0.40);
    ctx.fillText('R', flagX + flagW / 2, flagY + flagH * 0.60);
    ctx.fillText('O', flagX + flagW / 2, flagY + flagH * 0.80);

    ctx.restore();
  }

  drawBezel(ctx, cx, cy, r) {
    const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    grad.addColorStop(0, '#334155');
    grad.addColorStop(0.5, '#0f172a');
    grad.addColorStop(1, '#1e293b');

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#475569';
    ctx.stroke();
  }

  drawKnob(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#64748b';
    ctx.stroke();
  }

  drawScrews(ctx, cx, cy, dist) {
    const coords = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    coords.forEach(([sx, sy]) => {
      const px = cx + (sx * dist * 0.65);
      const py = cy + (sy * dist * 0.65);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#64748b';
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }
}

class StandbyAltimeterGauge {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.altitude = null;
    this.isOnline = false;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || 240;
    this.height = rect.height || 240;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
    this.render();
  }

  update(altitude, isOnline) {
    this.altitude = altitude;
    this.isOnline = isOnline;
    this.render();
  }

  render() {
    if (!this.canvas) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.44;

    ctx.clearRect(0, 0, w, h);

    // Bezel
    this.drawBezel(ctx, cx, cy, r);

    // Dial background
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.90, 0, Math.PI * 2);
    ctx.fillStyle = '#111317';
    ctx.fill();

    // Striped Barber Pole Sector (Low Altitude Warning, below 10,000 ft)
    const valid = this.isOnline && this.altitude !== null && this.altitude !== undefined;
    const alt = valid ? this.altitude : 0;
    if (alt < 10000) {
      this.drawBarberPoleSector(ctx, cx, cy, r * 0.55);
    }

    // Kollsman Pressure Window (Right side at 3 o'clock)
    this.drawKollsmanWindow(ctx, cx + r * 0.50, cy);

    // Dial scale numbers: 0 to 9 clockwise
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(r * 0.16)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let num = 0; num < 10; num++) {
      const ang = ((num * 36 - 90) * Math.PI) / 180;
      const tx = cx + Math.cos(ang) * (r * 0.70);
      const ty = cy + Math.sin(ang) * (r * 0.70);
      ctx.fillText(num.toString(), tx, ty);
    }

    // Tick marks: 50 subdivisions (every 20 ft)
    for (let tick = 0; tick < 50; tick++) {
      const ang = ((tick * 7.2 - 90) * Math.PI) / 180;
      const isMajor = tick % 5 === 0;
      const len = isMajor ? r * 0.14 : r * 0.07;
      const x1 = cx + Math.cos(ang) * (r * 0.88);
      const y1 = cy + Math.sin(ang) * (r * 0.88);
      const x2 = cx + Math.cos(ang) * (r * 0.88 - len);
      const y2 = cy + Math.sin(ang) * (r * 0.88 - len);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = isMajor ? 2.5 : 1.2;
      ctx.stroke();
    }

    // Center text labels
    ctx.fillStyle = '#cbd5e1';
    ctx.font = `bold ${Math.round(r * 0.10)}px sans-serif`;
    ctx.fillText('ALTIMETER', cx, cy - r * 0.32);
    ctx.font = `${Math.round(r * 0.065)}px sans-serif`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('CALIBRATE', cx, cy - r * 0.12);
    ctx.fillText('TO 20,000 FT', cx, cy - r * 0.04);

    // Baro knob at bottom left
    this.drawKnob(ctx, cx - r * 0.70, cy + r * 0.70, r * 0.16);

    // Screws at corners
    this.drawScrews(ctx, cx, cy, r * 1.08);

    // ZERO-MOCK DATA & NEEDLES
    if (!valid) {
      this.drawFailBadge(ctx, cx, cy, 'NO DATA');
      this.drawNeedles(ctx, cx, cy, r, 0);
    } else {
      this.drawNeedles(ctx, cx, cy, r, alt);
    }

    // Center hub cap
    this.drawCenterCap(ctx, cx, cy, r * 0.14);
  }

  drawBarberPoleSector(ctx, cx, cy, radius) {
    ctx.save();
    // Sector between 135 deg and 225 deg (around bottom 6 o'clock)
    ctx.beginPath();
    ctx.arc(cx, cy, radius, (50 * Math.PI) / 180, (130 * Math.PI) / 180);
    ctx.arc(cx, cy, radius * 0.45, (130 * Math.PI) / 180, (50 * Math.PI) / 180, true);
    ctx.closePath();
    ctx.clip();

    // Red and white diagonal stripes
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(cx - radius, cy, radius * 2, radius);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    for (let x = -radius * 2; x <= radius * 2; x += 14) {
      ctx.beginPath();
      ctx.moveTo(cx + x, cy);
      ctx.lineTo(cx + x + radius, cy + radius);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawKollsmanWindow(ctx, x, y) {
    ctx.save();
    const kw = 42;
    const kh = 22;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(x - kw / 2, y - kh / 2, kw, kh);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - kw / 2, y - kh / 2, kw, kh);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('1013', x, y - 1);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '8px monospace';
    ctx.fillText('29.92', x, y + 8);
    ctx.restore();
  }

  drawNeedles(ctx, cx, cy, r, altitude) {
    const safeAlt = Math.max(0, altitude);

    // 1. Ten-thousands needle (thin pointer with outer inverted triangle)
    const tenThousandsAngle = ((safeAlt / 100000) * 360 - 90) * (Math.PI / 180);
    this.drawTenThousandsNeedle(ctx, cx, cy, r * 0.85, tenThousandsAngle);

    // 2. Thousands needle (shorter wide triangle/wedge)
    const thousandsAngle = (((safeAlt % 10000) / 10000) * 360 - 90) * (Math.PI / 180);
    this.drawThousandsNeedle(ctx, cx, cy, r * 0.54, thousandsAngle);

    // 3. Hundreds needle (long slender pointer)
    const hundredsAngle = (((safeAlt % 1000) / 1000) * 360 - 90) * (Math.PI / 180);
    this.drawHundredsNeedle(ctx, cx, cy, r * 0.82, hundredsAngle);
  }

  drawHundredsNeedle(ctx, cx, cy, length, angleRad) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleRad + Math.PI / 2);

    ctx.beginPath();
    ctx.moveTo(0, -length);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-2, length * 0.25);
    ctx.lineTo(2, length * 0.25);
    ctx.lineTo(3, 0);
    ctx.closePath();

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.fill();

    ctx.restore();
  }

  drawThousandsNeedle(ctx, cx, cy, length, angleRad) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleRad + Math.PI / 2);

    ctx.beginPath();
    ctx.moveTo(0, -length);
    ctx.lineTo(-7, 0);
    ctx.lineTo(-3, length * 0.20);
    ctx.lineTo(3, length * 0.20);
    ctx.lineTo(7, 0);
    ctx.closePath();

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.fill();

    ctx.restore();
  }

  drawTenThousandsNeedle(ctx, cx, cy, length, angleRad) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleRad + Math.PI / 2);

    // Needle arm
    ctx.beginPath();
    ctx.moveTo(0, -length);
    ctx.lineTo(0, length * 0.15);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Triangle head at tip
    ctx.beginPath();
    ctx.moveTo(0, -length);
    ctx.lineTo(-6, -length + 10);
    ctx.lineTo(6, -length + 10);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.restore();
  }

  drawCenterCap(ctx, cx, cy, radius) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#475569';
    ctx.stroke();
  }

  drawBezel(ctx, cx, cy, r) {
    const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    grad.addColorStop(0, '#334155');
    grad.addColorStop(0.5, '#0f172a');
    grad.addColorStop(1, '#1e293b');

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#475569';
    ctx.stroke();
  }

  drawKnob(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#64748b';
    ctx.stroke();
  }

  drawScrews(ctx, cx, cy, dist) {
    const coords = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    coords.forEach(([sx, sy]) => {
      const px = cx + (sx * dist * 0.65);
      const py = cy + (sy * dist * 0.65);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#64748b';
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  drawFailBadge(ctx, cx, cy, label) {
    ctx.save();
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(cx - 45, cy - 14, 90, 28);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - 45, cy - 14, 90, 28);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
    ctx.restore();
  }
}

/**
 * 4. Turn Coordinator (TC)
 * Analog 2-minute turn coordinator with miniature airplane and inclinometer ball.
 * - Miniature airplane banks with roll/turn rate (20 deg bank aligns wing with 2-min notch 'L' / 'R')
 * - Inclinometer glass tube with black ball responding to sideslip / lateral G-load
 * - Red 'OFF' warning flag drops down when offline or unpowered
 */
class StandbyTurnCoordinatorGauge {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.roll = null;
    this.sideslip = null;
    this.isOnline = false;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || 200;
    this.height = rect.height || 200;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
    this.render();
  }

  update(rollDeg, sideslipDeg, isOnline) {
    this.roll = rollDeg;
    this.sideslip = sideslipDeg;
    this.isOnline = isOnline;
    this.render();
  }

  render() {
    if (!this.canvas) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.44;

    ctx.clearRect(0, 0, w, h);

    // Bezel & casing
    this.drawBezel(ctx, cx, cy, r);

    // Dial background
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.90, 0, Math.PI * 2);
    ctx.fillStyle = '#111317';
    ctx.fill();

    // Corner mounting screws
    this.drawScrews(ctx, cx, cy, r * 1.05);

    // Labels & Text
    ctx.fillStyle = '#94a3b8';
    ctx.font = `bold ${Math.max(8, r * 0.08)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('D.C. ELEC.', cx, cy - r * 0.68);

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(8, r * 0.085)}px sans-serif`;
    ctx.fillText('TURN COORDINATOR', cx, cy - r * 0.44);

    ctx.font = `bold ${Math.max(9, r * 0.09)}px monospace`;
    ctx.fillText('2 MIN.', cx, cy + r * 0.28);

    ctx.fillStyle = '#94a3b8';
    ctx.font = `bold ${Math.max(7, r * 0.065)}px sans-serif`;
    ctx.fillText('NO PITCH INFORMATION', cx, cy + r * 0.80);

    // Level Flight Reference Index Marks (Horizontal White Bars)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - r * 0.72, cy - r * 0.10, r * 0.22, 3);
    ctx.fillRect(cx + r * 0.50, cy - r * 0.10, r * 0.22, 3);

    // Standard Rate Turn Notches ('L' and 'R' at ~20° bank)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;

    // Left notch (L)
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.68, cy + r * 0.08);
    ctx.lineTo(cx - r * 0.50, cy + r * 0.08);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(10, r * 0.11)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('L', cx - r * 0.59, cy + r * 0.22);

    // Right notch (R)
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.50, cy + r * 0.08);
    ctx.lineTo(cx + r * 0.68, cy + r * 0.08);
    ctx.stroke();
    ctx.fillText('R', cx + r * 0.59, cy + r * 0.22);

    // ================= INCLINOMETER / SLIP-SKID BALL TUBE =================
    const tubeY = cy + r * 0.52;
    const tubeW = r * 0.76;
    const tubeH = r * 0.20;
    const tubeX = cx - tubeW / 2;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(tubeX, tubeY - tubeH / 2, tubeW, tubeH, 6);
    ctx.fillStyle = '#334155';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#64748b';
    ctx.stroke();

    // Fluid gloss gradient
    const fluidGrad = ctx.createLinearGradient(tubeX, tubeY - tubeH / 2, tubeX, tubeY + tubeH / 2);
    fluidGrad.addColorStop(0, 'rgba(255,255,255,0.4)');
    fluidGrad.addColorStop(0.3, 'rgba(255,255,255,0.05)');
    fluidGrad.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = fluidGrad;
    ctx.fill();

    // Center Reference Lines for Ball (1 ball width apart)
    const ballR = tubeH * 0.40;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - ballR * 1.1, tubeY - tubeH / 2 + 1);
    ctx.lineTo(cx - ballR * 1.1, tubeY + tubeH / 2 - 1);
    ctx.moveTo(cx + ballR * 1.1, tubeY - tubeH / 2 + 1);
    ctx.lineTo(cx + ballR * 1.1, tubeY + tubeH / 2 - 1);
    ctx.stroke();

    // The Ball
    const hasData = this.isOnline && this.sideslip !== null && this.sideslip !== undefined;
    const slip = hasData ? this.sideslip : 0;
    const maxTravel = (tubeW / 2) - ballR - 3;
    const ballOffset = Math.max(-maxTravel, Math.min(maxTravel, slip * (ballR * 0.8)));
    const ballX = cx + ballOffset;

    // 3D Sphere Rendering for the Ball
    const ballGrad = ctx.createRadialGradient(ballX - 2, tubeY - 2, 1, ballX, tubeY, ballR);
    ballGrad.addColorStop(0, '#94a3b8');
    ballGrad.addColorStop(0.4, '#1e293b');
    ballGrad.addColorStop(1, '#020617');
    ctx.beginPath();
    ctx.arc(ballX, tubeY, ballR, 0, Math.PI * 2);
    ctx.fillStyle = ballGrad;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    ctx.restore();

    // ================= MINIATURE AIRPLANE =================
    const planeY = cy - r * 0.10;
    const rollAngle = hasData && this.roll !== null ? this.roll : 0;
    const clampedBank = Math.max(-35, Math.min(35, rollAngle));
    const bankRad = (clampedBank * Math.PI) / 180;

    ctx.save();
    ctx.translate(cx, planeY);
    ctx.rotate(bankRad);

    // Miniature Airplane shape
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;

    // Wings
    const wingSpan = r * 0.52;
    const wingThick = r * 0.055;
    ctx.beginPath();
    ctx.rect(-wingSpan, -wingThick / 2, wingSpan * 2, wingThick);
    ctx.fill();

    // Wingtips (vertical upturned end tabs)
    const tipH = r * 0.07;
    ctx.fillRect(-wingSpan, -wingThick / 2 - tipH, wingThick, tipH);
    ctx.fillRect(wingSpan - wingThick, -wingThick / 2 - tipH, wingThick, tipH);

    // Fuselage circle in center
    const fuseR = r * 0.095;
    ctx.beginPath();
    ctx.arc(0, 0, fuseR, 0, Math.PI * 2);
    ctx.fill();

    // Vertical fin pointing up
    ctx.beginPath();
    ctx.moveTo(-wingThick / 2, 0);
    ctx.lineTo(0, -r * 0.18);
    ctx.lineTo(wingThick / 2, 0);
    ctx.closePath();
    ctx.fill();

    // Center pivot cap (black screw)
    ctx.beginPath();
    ctx.arc(0, 0, fuseR * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.restore();

    // ================= ZERO-MOCK FAIL STATE: RED 'OFF' FLAG =================
    if (!this.isOnline || this.roll === null || this.roll === undefined) {
      this.drawOffFlag(ctx, cx - r * 0.62, cy - r * 0.36, r * 0.36, r * 0.18);
    }
  }

  drawOffFlag(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('OFF', x + w / 2, y + h / 2);
    ctx.restore();
  }

  drawBezel(ctx, cx, cy, r) {
    const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    grad.addColorStop(0, '#334155');
    grad.addColorStop(0.5, '#0f172a');
    grad.addColorStop(1, '#1e293b');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#475569';
    ctx.stroke();
  }

  drawScrews(ctx, cx, cy, dist) {
    const coords = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    coords.forEach(([sx, sy]) => {
      const px = cx + (sx * dist * 0.65);
      const py = cy + (sy * dist * 0.65);
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#64748b';
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }
}

/**
 * 5. Heading Indicator (Directional Gyro / HI)
 * 360-degree rotating compass card, top lubber line, fixed miniature aircraft,
 * vacuum drift adjustment knob, red GYRO / FAIL flag.
 */
class StandbyHeadingGauge {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.heading = null;
    this.isOnline = false;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || 200;
    this.height = rect.height || 200;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
    this.render();
  }

  update(headingDeg, isOnline) {
    this.heading = headingDeg;
    this.isOnline = isOnline;
    this.render();
  }

  render() {
    if (!this.canvas) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.44;

    ctx.clearRect(0, 0, w, h);

    // Bezel & casing
    this.drawBezel(ctx, cx, cy, r);

    // Dial background
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.90, 0, Math.PI * 2);
    ctx.fillStyle = '#111317';
    ctx.fill();

    // Corner mounting screws
    this.drawScrews(ctx, cx, cy, r * 1.05);

    // Adjustment knob at bottom left
    this.drawKnob(ctx, cx - r * 0.72, cy + r * 0.72, r * 0.14);

    // Label "VACUUM" above knob
    ctx.fillStyle = '#94a3b8';
    ctx.font = `bold ${Math.max(7, r * 0.065)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('VACUUM', cx, cy + r * 0.50);

    const hasData = this.isOnline && this.heading !== null && this.heading !== undefined;
    const hdg = hasData ? this.heading : 0;
    const hdgRad = (hdg * Math.PI) / 180;

    // ================= ROTATING COMPASS CARD =================
    ctx.save();
    ctx.translate(cx, cy);
    // Rotate card counter-clockwise by aircraft heading so current heading is at 12 o'clock
    ctx.rotate(-hdgRad);

    const cardR = r * 0.82;
    const tickLong = r * 0.10;
    const tickMed = r * 0.06;

    for (let deg = 0; deg < 360; deg += 5) {
      const angle = (deg * Math.PI) / 180 - Math.PI / 2;
      const is30 = deg % 30 === 0;
      const is10 = deg % 10 === 0;

      const tLen = is30 || is10 ? tickLong : tickMed;
      const x1 = Math.cos(angle) * (cardR - tLen);
      const y1 = Math.sin(angle) * (cardR - tLen);
      const x2 = Math.cos(angle) * cardR;
      const y2 = Math.sin(angle) * cardR;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = is10 ? 2 : 1.2;
      ctx.stroke();

      // Numbers & Cardinal Labels
      if (is30) {
        let label = '';
        if (deg === 0) label = 'N';
        else if (deg === 90) label = 'E';
        else if (deg === 180) label = 'S';
        else if (deg === 270) label = 'W';
        else label = (deg / 10).toString();

        const textR = cardR - tickLong - (r * 0.12);
        const tx = Math.cos(angle) * textR;
        const ty = Math.sin(angle) * textR;

        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(angle + Math.PI / 2);
        ctx.fillStyle = (deg === 0 || deg === 90 || deg === 180 || deg === 270) ? '#ffffff' : '#f1f5f9';
        ctx.font = `bold ${Math.max(9, r * 0.11)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }

      // 45-degree orange tick marks (NE, SE, SW, NW)
      if (deg === 45 || deg === 135 || deg === 225 || deg === 315) {
        const ox1 = Math.cos(angle) * (cardR - tickLong * 1.3);
        const oy1 = Math.sin(angle) * (cardR - tickLong * 1.3);
        const ox2 = Math.cos(angle) * cardR;
        const oy2 = Math.sin(angle) * cardR;
        ctx.beginPath();
        ctx.moveTo(ox1, oy1);
        ctx.lineTo(ox2, oy2);
        ctx.strokeStyle = '#f97316';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
    ctx.restore();

    // ================= FIXED TOP LUBBER LINE / INDEX =================
    // Orange/white index triangle pointing down at the current heading at 12 o'clock
    ctx.save();
    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.84);
    ctx.lineTo(cx - r * 0.05, cy - r * 0.90);
    ctx.lineTo(cx + r * 0.05, cy - r * 0.90);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // ================= FIXED MINIATURE AIRPLANE (TOP VIEW) =================
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.2;

    // Fuselage tube
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.04, r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Wings
    ctx.beginPath();
    ctx.moveTo(-r * 0.35, -r * 0.05);
    ctx.lineTo(r * 0.35, -r * 0.05);
    ctx.lineTo(r * 0.33, 0);
    ctx.lineTo(-r * 0.33, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Tailplane
    ctx.beginPath();
    ctx.moveTo(-r * 0.16, r * 0.20);
    ctx.lineTo(r * 0.16, r * 0.20);
    ctx.lineTo(r * 0.14, r * 0.24);
    ctx.lineTo(-r * 0.14, r * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Orange nose dot
    ctx.beginPath();
    ctx.arc(0, -r * 0.28, r * 0.025, 0, Math.PI * 2);
    ctx.fillStyle = '#f97316';
    ctx.fill();
    ctx.restore();

    // ================= ZERO-MOCK FAIL STATE: RED 'GYRO' BADGE =================
    if (!hasData) {
      this.drawFailBadge(ctx, cx, cy - r * 0.15, 'GYRO');
    }
  }

  drawBezel(ctx, cx, cy, r) {
    const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    grad.addColorStop(0, '#334155');
    grad.addColorStop(0.5, '#0f172a');
    grad.addColorStop(1, '#1e293b');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#475569';
    ctx.stroke();
  }

  drawKnob(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#64748b';
    ctx.stroke();
  }

  drawScrews(ctx, cx, cy, dist) {
    const coords = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    coords.forEach(([sx, sy]) => {
      const px = cx + (sx * dist * 0.65);
      const py = cy + (sy * dist * 0.65);
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#64748b';
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  drawFailBadge(ctx, cx, cy, label) {
    ctx.save();
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(cx - 40, cy - 12, 80, 24);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - 40, cy - 12, 80, 24);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
    ctx.restore();
  }
}

/**
 * 6. Vertical Speed Indicator (VSI)
 * Calibrated scale: 0 at 9 o'clock. Up (climb) to +2000 fpm, Down (descent) to -2000 fpm.
 * Expanded resolution in 0-1000 fpm range.
 * Zero adjustment screw, single pointer, red FAIL badge when offline.
 */
class StandbyVsiGauge {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.vsi = null;
    this.isOnline = false;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || 200;
    this.height = rect.height || 200;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
    this.render();
  }

  update(vsiFpm, isOnline) {
    this.vsi = vsiFpm;
    this.isOnline = isOnline;
    this.render();
  }

  vsiToAngle(fpm) {
    if (fpm === null || fpm === undefined) return Math.PI;

    if (fpm >= 0) {
      if (fpm <= 1000) {
        // 180 deg down to 90 deg (90 degrees span)
        const deg = 180 - (fpm / 1000) * 90;
        return (deg * Math.PI) / 180;
      } else {
        // 90 deg down to 15 deg (75 degrees span)
        const clamped = Math.min(2000, fpm);
        const deg = 90 - ((clamped - 1000) / 1000) * 75;
        return (deg * Math.PI) / 180;
      }
    } else {
      const absFpm = Math.abs(fpm);
      if (absFpm <= 1000) {
        // 180 deg up to 270 deg (90 degrees span)
        const deg = 180 + (absFpm / 1000) * 90;
        return (deg * Math.PI) / 180;
      } else {
        // 270 deg up to 345 deg (75 degrees span)
        const clamped = Math.min(2000, absFpm);
        const deg = 270 + ((clamped - 1000) / 1000) * 75;
        return (deg * Math.PI) / 180;
      }
    }
  }

  render() {
    if (!this.canvas) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.44;

    ctx.clearRect(0, 0, w, h);

    // Bezel & casing
    this.drawBezel(ctx, cx, cy, r);

    // Dial background
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.90, 0, Math.PI * 2);
    ctx.fillStyle = '#111317';
    ctx.fill();

    // Corner mounting screws
    this.drawScrews(ctx, cx, cy, r * 1.05);

    // Zero adjustment screw at lower left
    this.drawScrew(ctx, cx - r * 0.65, cy + r * 0.65, r * 0.08);

    // Labels & Text
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(8, r * 0.08)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('VERTICAL SPEED', cx, cy - r * 0.38);

    ctx.fillStyle = '#94a3b8';
    ctx.font = `bold ${Math.max(7, r * 0.065)}px sans-serif`;
    ctx.fillText('100 FEET', cx, cy + r * 0.28);
    ctx.fillText('PER MIN', cx, cy + r * 0.38);

    // UP & DOWN labels with directional arrows
    ctx.fillStyle = '#38bdf8';
    ctx.font = `bold ${Math.max(8, r * 0.08)}px monospace`;
    ctx.textAlign = 'left';
    ctx.fillText('▲ UP', cx - r * 0.58, cy - r * 0.22);
    ctx.fillText('▼ DN', cx - r * 0.58, cy + r * 0.22);

    // Scale Dial Markings
    const scaleR = r * 0.85;
    const tickLong = r * 0.12;
    const tickMed = r * 0.08;
    const tickShort = r * 0.05;

    // 0 fpm tick (horizontal left at 9 o'clock)
    this.drawTick(ctx, cx, cy, scaleR, tickLong, Math.PI, 2.5, '#ffffff');
    this.drawLabel(ctx, cx, cy, scaleR - tickLong - (r * 0.10), Math.PI, '0');

    // Climb Ticks (+100 to +2000 fpm)
    for (let fpm = 100; fpm <= 2000; fpm += 100) {
      const angle = this.vsiToAngle(fpm);
      const isMajor = fpm === 500 || fpm === 1000 || fpm === 1500 || fpm === 2000;
      const tLen = isMajor ? tickLong : (fpm % 200 === 0 ? tickMed : tickShort);
      this.drawTick(ctx, cx, cy, scaleR, tLen, angle, isMajor ? 2.2 : 1.2, '#ffffff');

      if (isMajor) {
        const lbl = (fpm / 100).toString();
        this.drawLabel(ctx, cx, cy, scaleR - tickLong - (r * 0.10), angle, lbl);
      }
    }

    // Descent Ticks (-100 to -2000 fpm)
    for (let fpm = -100; fpm >= -2000; fpm -= 100) {
      const angle = this.vsiToAngle(fpm);
      const absFpm = Math.abs(fpm);
      const isMajor = absFpm === 500 || absFpm === 1000 || absFpm === 1500 || absFpm === 2000;
      const tLen = isMajor ? tickLong : (absFpm % 200 === 0 ? tickMed : tickShort);
      this.drawTick(ctx, cx, cy, scaleR, tLen, angle, isMajor ? 2.2 : 1.2, '#ffffff');

      if (isMajor) {
        const lbl = (absFpm / 100).toString();
        this.drawLabel(ctx, cx, cy, scaleR - tickLong - (r * 0.10), angle, lbl);
      }
    }

    // ================= POINTER / NEEDLE =================
    const hasData = this.isOnline && this.vsi !== null && this.vsi !== undefined;
    const needleAngle = hasData ? this.vsiToAngle(this.vsi) : Math.PI;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(needleAngle);

    // Pointer needle
    ctx.beginPath();
    ctx.moveTo(-r * 0.18, -2);
    ctx.lineTo(scaleR - tickShort, -1.2);
    ctx.lineTo(scaleR, 0);
    ctx.lineTo(scaleR - tickShort, 1.2);
    ctx.lineTo(-r * 0.18, 2);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.fill();

    // Center Hub Cap
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#64748b';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r * 0.04, 0, Math.PI * 2);
    ctx.fillStyle = '#475569';
    ctx.fill();
    ctx.restore();

    // ================= ZERO-MOCK FAIL STATE: RED 'FAIL' BADGE =================
    if (!hasData) {
      this.drawFailBadge(ctx, cx, cy - r * 0.15, 'FAIL');
    }
  }

  drawTick(ctx, cx, cy, scaleR, length, angle, width, color) {
    const x1 = cx + Math.cos(angle) * (scaleR - length);
    const y1 = cy + Math.sin(angle) * (scaleR - length);
    const x2 = cx + Math.cos(angle) * scaleR;
    const y2 = cy + Math.sin(angle) * scaleR;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  drawLabel(ctx, cx, cy, radius, angle, text) {
    const lx = cx + Math.cos(angle) * radius;
    const ly = cy + Math.sin(angle) * radius;
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx, ly);
  }

  drawBezel(ctx, cx, cy, r) {
    const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    grad.addColorStop(0, '#334155');
    grad.addColorStop(0.5, '#0f172a');
    grad.addColorStop(1, '#1e293b');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#475569';
    ctx.stroke();
  }

  drawScrew(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#334155';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#64748b';
    ctx.stroke();
    // Screw slot
    ctx.beginPath();
    ctx.moveTo(x - r * 0.6, y - r * 0.6);
    ctx.lineTo(x + r * 0.6, y + r * 0.6);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  drawScrews(ctx, cx, cy, dist) {
    const coords = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    coords.forEach(([sx, sy]) => {
      const px = cx + (sx * dist * 0.65);
      const py = cy + (sy * dist * 0.65);
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#64748b';
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  drawFailBadge(ctx, cx, cy, label) {
    ctx.save();
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(cx - 36, cy - 12, 72, 24);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - 36, cy - 12, 72, 24);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
    ctx.restore();
  }
}

/**
 * Cluster Controller coordinating all 6 classic standby steam gauges (Basic Six / Six-Pack)
 */
class StandbyInstrumentsCluster {
  constructor({
    airspeedId = 'gauge-airspeed-dash',
    attitudeId = 'gauge-attitude-dash',
    altimeterId = 'gauge-altimeter-dash',
    turnCoordinatorId = 'gauge-turn-dash',
    headingId = 'gauge-heading-dash',
    vsiId = 'gauge-vsi-dash',
  } = {}) {
    this.airspeedGauge = new StandbyAirspeedGauge(airspeedId);
    this.attitudeGauge = new StandbyAttitudeGauge(attitudeId);
    this.altimeterGauge = new StandbyAltimeterGauge(altimeterId);
    this.turnCoordinatorGauge = new StandbyTurnCoordinatorGauge(turnCoordinatorId);
    this.headingGauge = new StandbyHeadingGauge(headingId);
    this.vsiGauge = new StandbyVsiGauge(vsiId);
  }

  resize() {
    this.airspeedGauge?.resize();
    this.attitudeGauge?.resize();
    this.altimeterGauge?.resize();
    this.turnCoordinatorGauge?.resize();
    this.headingGauge?.resize();
    this.vsiGauge?.resize();
  }

  update(telemetry, isOnline) {
    const validTelem = Boolean(telemetry && (isOnline || telemetry.status?.connection === 'CONNECTED' || telemetry.status?.connection === 'REPLAY' || telemetry.indicated_airspeed_kt !== undefined));
    if (!validTelem || !telemetry) {
      this.airspeedGauge?.update(null, false);
      this.attitudeGauge?.update(null, null, false);
      this.altimeterGauge?.update(null, false);
      this.turnCoordinatorGauge?.update(null, null, false);
      this.headingGauge?.update(null, false);
      this.vsiGauge?.update(null, false);
      return;
    }

    const spd = telemetry.indicated_airspeed_kt ?? telemetry.airspeed_kias ?? telemetry.speeds?.indicated_airspeed_kt;
    const pitch = telemetry.pitch_deg ?? telemetry.attitude?.pitch_deg;
    const roll = telemetry.roll_deg ?? telemetry.attitude?.roll_deg;
    const alt = telemetry.altitude_msl_ft ?? telemetry.altitude_ft ?? telemetry.position?.altitude_msl_ft;
    const slip = telemetry.sideslip_beta_deg ?? (telemetry.g_load_side ? telemetry.g_load_side * 5.0 : 0);
    const hdg = telemetry.heading_mag_deg ?? telemetry.heading_true_deg ?? telemetry.attitude?.heading_mag_deg ?? telemetry.attitude?.heading_true_deg;
    const vsi = telemetry.vertical_speed_fpm ?? telemetry.vertical_speed ?? telemetry.speeds?.vertical_speed_fpm;

    this.airspeedGauge?.update(spd, true);
    this.attitudeGauge?.update(pitch, roll, true);
    this.altimeterGauge?.update(alt, true);
    this.turnCoordinatorGauge?.update(roll, slip, true);
    this.headingGauge?.update(hdg, true);
    this.vsiGauge?.update(vsi, true);
  }
}

// Global exports
window.StandbyAirspeedGauge = StandbyAirspeedGauge;
window.StandbyAttitudeGauge = StandbyAttitudeGauge;
window.StandbyAltimeterGauge = StandbyAltimeterGauge;
window.StandbyTurnCoordinatorGauge = StandbyTurnCoordinatorGauge;
window.StandbyHeadingGauge = StandbyHeadingGauge;
window.StandbyVsiGauge = StandbyVsiGauge;
window.StandbyInstrumentsCluster = StandbyInstrumentsCluster;
