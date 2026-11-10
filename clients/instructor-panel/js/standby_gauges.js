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

    // White tapered needle
    ctx.beginPath();
    ctx.moveTo(0, length);
    ctx.lineTo(-length * 0.05, 0);
    ctx.lineTo(-length * 0.03, -length * 0.22);
    ctx.lineTo(length * 0.03, -length * 0.22);
    ctx.lineTo(length * 0.05, 0);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;
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

    // Bank scale markings (Top outer bezel arc)
    this.drawBankScale(ctx, cx, cy, sphereRadius);

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

  drawBankScale(ctx, cx, cy, radius) {
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

    // Inverted orange triangle at top (0 deg roll marker)
    ctx.save();
    ctx.translate(cx, cy - radius + 4);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-7, -10);
    ctx.lineTo(7, -10);
    ctx.closePath();
    ctx.fillStyle = '#f97316';
    ctx.fill();
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
 * Cluster Controller coordinating all 3 standby steam gauges
 */
class StandbyInstrumentsCluster {
  constructor({ airspeedId, attitudeId, altimeterId }) {
    this.airspeedGauge = new StandbyAirspeedGauge(airspeedId);
    this.attitudeGauge = new StandbyAttitudeGauge(attitudeId);
    this.altimeterGauge = new StandbyAltimeterGauge(altimeterId);
  }

  update(telemetry, isOnline) {
    if (!isOnline || !telemetry) {
      this.airspeedGauge.update(null, false);
      this.attitudeGauge.update(null, null, false);
      this.altimeterGauge.update(null, false);
      return;
    }

    const spd = telemetry.indicated_airspeed_kt ?? telemetry.airspeed_kias;
    const pitch = telemetry.pitch_deg;
    const roll = telemetry.roll_deg;
    const alt = telemetry.altitude_msl_ft ?? telemetry.altitude_ft;

    this.airspeedGauge.update(spd, true);
    this.attitudeGauge.update(pitch, roll, true);
    this.altimeterGauge.update(alt, true);
  }
}

// Global exports
window.StandbyAirspeedGauge = StandbyAirspeedGauge;
window.StandbyAttitudeGauge = StandbyAttitudeGauge;
window.StandbyAltimeterGauge = StandbyAltimeterGauge;
window.StandbyInstrumentsCluster = StandbyInstrumentsCluster;
