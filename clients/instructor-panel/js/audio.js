/**
 * Synthesized Cockpit Audio Alert System
 * Uses HTML5 Web Audio API to generate realistic avionics alerts and advisory chimes.
 */

class CockpitAudio {
  constructor() {
    this.audioCtx = null;
    this.isMuted = false;
  }

  init() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioCtx = new AudioContext();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    const btn = document.getElementById('btn-audio-mute');
    if (btn) {
      if (this.isMuted) {
        btn.classList.add('muted');
        btn.title = 'Звукові сповіщення вимкнено (натисніть щоб увімкнути)';
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.73 4.73H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
          </svg>
          <span>AUDIO: MUTED</span>
        `;
      } else {
        btn.classList.remove('muted');
        btn.title = 'Звукові сповіщення увімкнено (натисніть щоб вимкнути)';
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
          </svg>
          <span>AUDIO: ON</span>
        `;
      }
    }
    return this.isMuted;
  }

  playAlert(type = 'caution') {
    if (this.isMuted) return;
    this.init();
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    if (type === 'warning') {
      // Alternating 800 Hz / 1000 Hz whoop (3 pulses)
      for (let i = 0; i < 3; i++) {
        const t = now + i * 0.25;
        this.playTone(850, t, 0.1, 0.15);
        this.playTone(1050, t + 0.1, 0.1, 0.2);
      }
    } else if (type === 'caution') {
      // 550 Hz double beep
      this.playTone(550, now, 0.12, 0.15);
      this.playTone(550, now + 0.18, 0.12, 0.15);
    } else if (type === 'chime') {
      // High-low avionics chime
      this.playTone(660, now, 0.2, 0.12);
      this.playTone(880, now + 0.18, 0.35, 0.15);
    }
  }

  playTone(freq, startTime, duration, gainLevel = 0.1) {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.exponentialRampToValueAtTime(gainLevel, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }
}

window.cockpitAudio = new CockpitAudio();
