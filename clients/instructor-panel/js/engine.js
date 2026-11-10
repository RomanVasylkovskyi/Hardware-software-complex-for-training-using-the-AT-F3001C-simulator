/**
 * Engine Indication System (EIS) & Flight Controls Panel
 * Production avionics instrument indicators
 * 
 * CRITICAL RULE: If a sensor value is null, offline, or unread,
 * render a prominent "NO DATA" error badge and blank the readout to '--'!
 * NEVER invent fake numbers or frozen needles.
 */

class EngineInstrumentsPanel {
  constructor(containerId = 'engine-panel') {
    this.container = document.getElementById(containerId) || document.getElementById('view-eis') || document.getElementById('engine-panel');
    if (!this.container) {
      console.warn(`Engine instruments container '${containerId}' not found`);
    }

    this.elements = {
      // RPM
      rpmVal: document.getElementById('eng-rpm-val'),
      rpmBar: document.getElementById('eng-rpm-bar'),
      rpmBadge: document.getElementById('eng-rpm-badge'),

      // EGT
      egtVal: document.getElementById('eng-egt-val'),
      egtBar: document.getElementById('eng-egt-bar'),
      egtBadge: document.getElementById('eng-egt-badge'),

      // Oil Pressure
      oilPressVal: document.getElementById('eng-oil-press-val'),
      oilPressBar: document.getElementById('eng-oil-press-bar'),
      oilPressBadge: document.getElementById('eng-oil-press-badge'),

      // Oil Temperature
      oilTempVal: document.getElementById('eng-oil-temp-val'),
      oilTempBar: document.getElementById('eng-oil-temp-bar'),
      oilTempBadge: document.getElementById('eng-oil-temp-badge'),

      // Fuel Flow
      fuelFlowVal: document.getElementById('eng-fuel-flow-val'),
      fuelFlowBar: document.getElementById('eng-fuel-flow-bar'),
      fuelFlowBadge: document.getElementById('eng-fuel-flow-badge'),

      // Fuel Quantity
      fuelQtyVal: document.getElementById('eng-fuel-qty-val'),
      fuelQtyBar: document.getElementById('eng-fuel-qty-bar'),
      fuelQtyBadge: document.getElementById('eng-fuel-qty-badge'),

      // Throttle & Flaps
      throttleVal: document.getElementById('ctrl-throttle-val'),
      throttleBar: document.getElementById('ctrl-throttle-bar'),
      throttleBadge: document.getElementById('ctrl-throttle-badge'),

      flapsVal: document.getElementById('ctrl-flaps-val'),
      flapsBar: document.getElementById('ctrl-flaps-bar'),
      flapsBadge: document.getElementById('ctrl-flaps-badge'),

      // Elevator Stick
      elevatorVal: document.getElementById('ctrl-elevator-val'),
      elevatorBar: document.getElementById('ctrl-elevator-bar'),
      elevatorBadge: document.getElementById('ctrl-elevator-badge'),
    };
  }

  update(telemetry, isOnline) {
    if (!isOnline || !telemetry) {
      this.setAllNoData();
      return;
    }

    // 1. RPM (0 - 3000 RPM)
    const rpm = telemetry.rpm ?? telemetry.engine_rpm ?? telemetry.engine?.rpm;
    this.updateInstrument('rpm', rpm, 0, 3000, 'RPM');

    // 2. EGT (0 - 1100 °C)
    const egt = telemetry.egt_c ?? telemetry.exhaust_gas_temp_c ?? telemetry.egt_degc ?? telemetry.engine?.egt_degc;
    this.updateInstrument('egt', egt, 0, 1100, '°C');

    // 3. Oil Pressure (0 - 100 PSI)
    const oilPress = telemetry.oil_press_psi ?? telemetry.oil_pressure_psi ?? telemetry.engine?.oil_pressure_psi;
    this.updateInstrument('oilPress', oilPress, 0, 100, 'PSI');

    // 4. Oil Temperature (0 - 180 °C)
    const oilTemp = telemetry.oil_temp_c ?? telemetry.oil_temperature_c ?? telemetry.oil_temp_degc ?? telemetry.engine?.oil_temp_degc;
    this.updateInstrument('oilTemp', oilTemp, 0, 180, '°C');

    // 5. Fuel Flow (0 - 20 GPH)
    const fuelFlow = telemetry.fuel_flow_gph ?? telemetry.engine?.fuel_flow_gph;
    this.updateInstrument('fuelFlow', fuelFlow, 0, 20, 'GPH');

    // 6. Fuel Quantity (0 - 56 GAL total)
    const fuelQty = telemetry.fuel_qty_gal ?? telemetry.fuel_quantity_gal ?? telemetry.engine?.fuel_quantity_gal;
    this.updateInstrument('fuelQty', fuelQty, 0, 56, 'GAL');

    // 7. Throttle Lever (0.0 to 1.0)
    const throttle = telemetry.throttle_ratio ?? telemetry.engine?.throttle_ratio;
    if (throttle !== null && throttle !== undefined) {
      const pct = Math.max(0, Math.min(100, Math.round(throttle * 100)));
      if (this.elements.throttleVal) this.elements.throttleVal.innerText = `${pct}%`;
      if (this.elements.throttleBar) this.elements.throttleBar.style.width = `${pct}%`;
      if (this.elements.throttleBadge) this.elements.throttleBadge.classList.add('hidden');
    } else {
      this.setFieldNoData('throttle');
    }

    // 8. Wing Flaps (0.0 to 1.0)
    const flap = telemetry.flap_ratio ?? telemetry.controls?.flap_ratio;
    if (flap !== null && flap !== undefined) {
      let flapLabel = 'UP (0°)';
      if (flap > 0.75) flapLabel = 'FULL (30°)';
      else if (flap > 0.45) flapLabel = '20°';
      else if (flap > 0.15) flapLabel = '10°';
      const pct = Math.max(0, Math.min(100, Math.round(flap * 100)));
      if (this.elements.flapsVal) this.elements.flapsVal.innerText = flapLabel;
      if (this.elements.flapsBar) this.elements.flapsBar.style.width = `${pct}%`;
      if (this.elements.flapsBadge) this.elements.flapsBadge.classList.add('hidden');
    } else {
      this.setFieldNoData('flaps');
    }

    // 9. Elevator Stick (-1.0 to +1.0, Bipolar center-zero control)
    const elevator = telemetry.elevator_stick ?? telemetry.elevator ?? telemetry.controls?.elevator;
    if (elevator !== null && elevator !== undefined) {
      let elevLabel = 'CTR (0%)';
      const absElev = Math.abs(elevator);
      const pct = Math.min(100, Math.round(absElev * 100));

      if (absElev < 0.03) {
        elevLabel = 'CTR (0%)';
        if (this.elements.elevatorBar) {
          this.elements.elevatorBar.style.left = '50%';
          this.elements.elevatorBar.style.width = '0%';
        }
      } else if (elevator < 0) {
        // Pitch DOWN / PUSH: Fill leftward from 50%
        elevLabel = `DN ${pct}%`;
        if (this.elements.elevatorBar) {
          const barWidth = pct / 2;
          this.elements.elevatorBar.style.left = `${50 - barWidth}%`;
          this.elements.elevatorBar.style.width = `${barWidth}%`;
        }
      } else {
        // Pitch UP / PULL: Fill rightward from 50%
        elevLabel = `UP ${pct}%`;
        if (this.elements.elevatorBar) {
          this.elements.elevatorBar.style.left = '50%';
          this.elements.elevatorBar.style.width = `${pct / 2}%`;
        }
      }

      if (this.elements.elevatorVal) this.elements.elevatorVal.innerText = elevLabel;
      if (this.elements.elevatorBadge) this.elements.elevatorBadge.classList.add('hidden');
    } else {
      this.setFieldNoData('elevator');
    }
  }

  updateInstrument(fieldKey, value, minVal, maxVal, unit) {
    const valElem = this.elements[`${fieldKey}Val`];
    const barElem = this.elements[`${fieldKey}Bar`];
    const badgeElem = this.elements[`${fieldKey}Badge`];

    if (value === null || value === undefined) {
      // SENSOR UNREAD / NO DATA STATE
      if (valElem) valElem.innerText = '--';
      if (barElem) barElem.style.width = '0%';
      if (badgeElem) badgeElem.classList.remove('hidden');
    } else {
      // VALID SENSOR DATA
      const pct = Math.max(0, Math.min(100, ((value - minVal) / (maxVal - minVal)) * 100));
      if (valElem) valElem.innerText = `${Math.round(value)} ${unit}`;
      if (barElem) barElem.style.width = `${pct}%`;
      if (badgeElem) badgeElem.classList.add('hidden');
    }
  }

  setFieldNoData(fieldKey) {
    const valElem = this.elements[`${fieldKey}Val`];
    const barElem = this.elements[`${fieldKey}Bar`];
    const badgeElem = this.elements[`${fieldKey}Badge`];

    if (valElem) valElem.innerText = '--';
    if (barElem) {
      barElem.style.width = '0%';
      if (fieldKey === 'elevator') {
        barElem.style.left = '50%';
      }
    }
    if (badgeElem) badgeElem.classList.remove('hidden');
  }

  setAllNoData() {
    const fields = ['rpm', 'egt', 'oilPress', 'oilTemp', 'fuelFlow', 'fuelQty', 'throttle', 'flaps', 'elevator'];
    fields.forEach(f => this.setFieldNoData(f));
  }
}

window.EngineInstrumentsPanel = EngineInstrumentsPanel;
