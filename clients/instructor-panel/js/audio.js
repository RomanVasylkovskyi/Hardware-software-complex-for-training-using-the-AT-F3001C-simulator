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
        btn.innerText = 'AUDIO: MUTED';
      } else {
        btn.classList.remove('muted');
        btn.innerText = 'AUDIO: ON';
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
