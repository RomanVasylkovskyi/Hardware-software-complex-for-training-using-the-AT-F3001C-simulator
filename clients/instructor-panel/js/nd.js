/**
 * Navigation Display (ND) Tactical Moving Map with Real-time Terrain Visualization
 * Provides authentic avionics topographic terrain, shaded relief, and satellite layers.
 * 
 * ZERO-MOCK COMPLIANCE:
 * - If GPS fix is null, lost, or offline:
 *   - Displays prominent red 'NO GPS FIX • POSITION LOST' warning banner.
 *   - Removes aircraft marker and freezes track at last validated position.
 *   - NEVER extrapolates or simulates fake coordinates.
 */

class NavigationDisplay {
  constructor(containerId = 'nd-map', alertBannerId = 'nd-no-gps-alert') {
    this.container = document.getElementById(containerId);
    this.alertBanner = document.getElementById(alertBannerId);

    if (!this.container) {
      console.warn(`ND Map container '${containerId}' not found`);
      return;
    }

    // UKLL (Lviv Danylo Halytskyi Intl Airport) RWY 13/31 Coordinates
    this.ukllRwy13Threshold = [49.82026, 23.94254];
    this.ukllRwy31Threshold = [49.80556, 23.97222];
    this.rwy13Heading = 135.8;

    this.autoFollow = true;
    this.trackPoints = [];
    this.currentLat = null;
    this.currentLon = null;
    this.currentHeading = 0;
    this.isOnline = false;

    this.initMap();
  }

  initMap() {
    // Initialize Leaflet map
    this.map = L.map(this.container.id, {
      center: this.ukllRwy13Threshold,
      zoom: 14,
      zoomControl: true,
      attributionControl: true,
    });

    // ================= TERRAIN & TOPOGRAPHIC BASE LAYERS =================
    // 1. OpenTopoMap: Topographic elevation contours (ізогіпси) & hillshade relief
    const openTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      subdomains: 'abc',
      attribution: 'Терейн: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
    });

    // 2. ESRI World Topo: High-detail topographic relief with elevation shading
    const esriTopo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Терейн: &copy; Esri World Topo'
    });

    // 3. ESRI Shaded Relief: Pure 3D elevation hillshade terrain model
    const esriRelief = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 13,
      attribution: 'Рельєф: &copy; Esri Shaded Relief'
    });

    // 4. ESRI Satellite: High-res satellite imagery showing physical terrain & geography
    const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Супутник: &copy; Esri World Imagery'
    });

    // 5. OpenStreetMap: Clean standard road/vector base
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    });

    this.layers = {
      opentopo: openTopo,
      esritopo: esriTopo,
      relief: esriRelief,
      satellite: esriSat,
      osm: osm,
    };

    // Default active terrain layer: OpenTopoMap (rich elevation contours and hillshade)
    this.currentLayerKey = 'opentopo';
    this.layers.opentopo.addTo(this.map);

    // Layer switcher control (top-right)
    const baseMaps = {
      "⛰️ Терейн (OpenTopoMap)": openTopo,
      "🗺️ Терейн (ESRI Topo)": esriTopo,
      "🏔️ Рельєф 3D (Hillshade)": esriRelief,
      "🛰️ Супутник (ESRI Sat)": esriSat,
      "📍 Векторна карта (OSM)": osm,
    };
    L.control.layers(baseMaps, null, { position: 'topright', collapsed: true }).addTo(this.map);

    // Draw Runway 13/31 & Alignment lines with high-contrast outlines
    this.drawAirportEnvironment();

    // Flight track with dark halo under-stroke for crystal-clear readability over terrain
    this.flightTrackHalo = L.polyline([], {
      color: '#000000',
      weight: 5.5,
      opacity: 0.8,
      lineJoin: 'round',
    }).addTo(this.map);

    this.flightTrack = L.polyline([], {
      color: '#00e5ff',
      weight: 3.2,
      opacity: 1.0,
      lineJoin: 'round',
    }).addTo(this.map);

    // Aircraft custom SVG marker
    const airplaneIcon = L.divIcon({
      className: 'nd-aircraft-marker-container',
      html: `
        <div id="nd-aircraft-icon" class="nd-aircraft-icon">
          <svg viewBox="0 0 48 48" width="38" height="38">
            <path fill="#000000" stroke="#000000" stroke-width="4" d="M24 2 L28 16 L44 26 L44 30 L28 25 L28 38 L34 42 L34 46 L24 43 L14 46 L14 42 L20 38 L20 25 L4 30 L4 26 L20 16 Z" />
            <path fill="#ffeb3b" stroke="#ffffff" stroke-width="1.2" d="M24 2 L28 16 L44 26 L44 30 L28 25 L28 38 L34 42 L34 46 L24 43 L14 46 L14 42 L20 38 L20 25 L4 30 L4 26 L20 16 Z" />
          </svg>
        </div>
      `,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });

    this.aircraftMarker = L.marker(this.ukllRwy13Threshold, {
      icon: airplaneIcon,
      zIndexOffset: 1000,
    });

    // Create live Terrain & Altitude Clearance HUD Badge
    this.createTerrainBadge();

    // Map drag disables auto-follow temporarily
    this.map.on('dragstart', () => {
      this.autoFollow = false;
      this.updateFollowButtonState();
    });
  }

  createTerrainBadge() {
    if (!this.container) return;
    const badge = document.createElement('div');
    badge.id = 'nd-terrain-badge';
    badge.className = 'nd-terrain-badge';
    badge.innerHTML = `ТЕРЕЙН: <span>-- FT</span> | ЗАПАС (AGL): <span>-- FT</span>`;
    this.container.appendChild(badge);
    this.terrainBadge = badge;
  }

  updateTerrainBadge(terrainElevFt, aglFt, mslFt) {
    if (!this.terrainBadge) return;
    if (terrainElevFt === null || aglFt === null) {
      this.terrainBadge.innerHTML = `ТЕРЕЙН: <span>NO DATA</span>`;
      return;
    }
    const safeTerrain = Math.max(0, Math.round(terrainElevFt));
    const safeAgl = Math.round(aglFt);
    const safeMsl = Math.round(mslFt);
    this.terrainBadge.innerHTML = `ТЕРЕЙН: <span>${safeTerrain.toLocaleString()} FT</span> &bull; AGL: <span>${safeAgl.toLocaleString()} FT</span> &bull; MSL: <span>${safeMsl.toLocaleString()} FT</span>`;
  }

  setLayer(layerKey) {
    if (this.layers[layerKey] && this.currentLayerKey !== layerKey) {
      this.map.removeLayer(this.layers[this.currentLayerKey]);
      this.layers[layerKey].addTo(this.map);
      this.currentLayerKey = layerKey;
    }
  }

  drawAirportEnvironment() {
    // 1. Runway 13/31 Casing & Centerline
    // Black halo casing
    L.polyline([this.ukllRwy13Threshold, this.ukllRwy31Threshold], {
      color: '#000000',
      weight: 10,
      opacity: 0.9,
    }).addTo(this.map);

    // White asphalt line
    L.polyline([this.ukllRwy13Threshold, this.ukllRwy31Threshold], {
      color: '#ffffff',
      weight: 6,
      opacity: 0.98,
    }).addTo(this.map).bindTooltip('UKLL RWY 13/31 (3,305m)', { permanent: false });

    // 2. Extended ILS approach corridor (5 NM backwards along 315.8 deg)
    const nmInDegreesLat = 1.0 / 60.0;
    const nmInDegreesLon = nmInDegreesLat / Math.cos((49.82 * Math.PI) / 180);
    const radReciprocal = ((this.rwy13Heading + 180) % 360) * (Math.PI / 180);

    const fafDistanceNM = 5.0;
    const fafLat = this.ukllRwy13Threshold[0] + (fafDistanceNM * nmInDegreesLat * Math.cos(radReciprocal));
    const fafLon = this.ukllRwy13Threshold[1] + (fafDistanceNM * nmInDegreesLon * Math.sin(radReciprocal));

    // Dark under-stroke for dashed approach line
    L.polyline([[fafLat, fafLon], this.ukllRwy13Threshold], {
      color: '#000000',
      weight: 4.5,
      opacity: 0.7,
    }).addTo(this.map);

    // Magenta dashed line
    L.polyline([[fafLat, fafLon], this.ukllRwy13Threshold], {
      color: '#e040fb',
      weight: 2.5,
      dashArray: '8, 8',
      opacity: 0.95,
    }).addTo(this.map);

    // Distance Fix Rings along final approach (1 NM, 2 NM, 3 NM, 5 NM)
    const fixes = [1, 2, 3, 5];
    fixes.forEach((dist) => {
      const fixLat = this.ukllRwy13Threshold[0] + (dist * nmInDegreesLat * Math.cos(radReciprocal));
      const fixLon = this.ukllRwy13Threshold[1] + (dist * nmInDegreesLon * Math.sin(radReciprocal));

      L.circleMarker([fixLat, fixLon], {
        radius: 5,
        color: '#ffffff',
        fillColor: '#e040fb',
        fillOpacity: 1,
        weight: 2,
      }).addTo(this.map).bindTooltip(`${dist} NM FINAL RWY 13`, { permanent: false, direction: 'top' });
    });

    // Touchdown threshold marker
    L.circleMarker(this.ukllRwy13Threshold, {
      radius: 6,
      color: '#ffffff',
      fillColor: '#22c55e',
      fillOpacity: 0.9,
      weight: 2,
    }).addTo(this.map).bindTooltip('THR 13 UKLL', { permanent: false });
  }

  update(telemetry, isOnline) {
    this.isOnline = isOnline;

    const hasGPS = isOnline && telemetry &&
      telemetry.latitude !== null && telemetry.latitude !== undefined &&
      telemetry.longitude !== null && telemetry.longitude !== undefined;

    if (!hasGPS) {
      // ZERO-MOCK: Trigger NO GPS FIX Red Alert!
      this.showNoGpsAlert(true);
      if (this.map.hasLayer(this.aircraftMarker)) {
        this.map.removeLayer(this.aircraftMarker);
      }
      this.updateTerrainBadge(null, null, null);
      return;
    }

    // GPS is valid
    this.showNoGpsAlert(false);

    const lat = telemetry.latitude;
    const lon = telemetry.longitude;
    const hdg = telemetry.heading_true_deg ?? telemetry.heading_mag_deg ?? 0;
    const msl = telemetry.altitude_msl_ft;
    const agl = telemetry.altitude_agl_ft;

    this.currentLat = lat;
    this.currentLon = lon;
    this.currentHeading = hdg;

    // Update Terrain & Clearance HUD
    if (msl !== null && msl !== undefined && agl !== null && agl !== undefined) {
      const terrainElev = msl - agl;
      this.updateTerrainBadge(terrainElev, agl, msl);
    } else {
      this.updateTerrainBadge(null, null, null);
    }

    // Ensure marker is added
    if (!this.map.hasLayer(this.aircraftMarker)) {
      this.aircraftMarker.addTo(this.map);
    }

    // Move marker and rotate icon
    this.aircraftMarker.setLatLng([lat, lon]);
    const iconElem = document.getElementById('nd-aircraft-icon');
    if (iconElem) {
      iconElem.style.transform = `rotate(${hdg}deg)`;
    }

    // Append to flight track
    const lastPoint = this.trackPoints[this.trackPoints.length - 1];
    if (!lastPoint || Math.abs(lastPoint[0] - lat) > 0.00005 || Math.abs(lastPoint[1] - lon) > 0.00005) {
      this.trackPoints.push([lat, lon]);
      this.flightTrackHalo.addLatLng([lat, lon]);
      this.flightTrack.addLatLng([lat, lon]);
    }

    // Auto-center map if enabled
    if (this.autoFollow) {
      this.map.panTo([lat, lon], { animate: true, duration: 0.1 });
    }
  }

  showNoGpsAlert(show) {
    if (this.alertBanner) {
      if (show) {
        this.alertBanner.classList.remove('hidden');
      } else {
        this.alertBanner.classList.add('hidden');
      }
    }
  }

  toggleAutoFollow() {
    this.autoFollow = !this.autoFollow;
    if (this.autoFollow && this.currentLat !== null && this.currentLon !== null) {
      this.map.panTo([this.currentLat, this.currentLon]);
    }
    this.updateFollowButtonState();
  }

  updateFollowButtonState() {
    const btn = document.getElementById('btn-nd-follow');
    if (btn) {
      if (this.autoFollow) {
        btn.classList.add('active');
        btn.innerText = 'AUTO-PAN: ON';
      } else {
        btn.classList.remove('active');
        btn.innerText = 'AUTO-PAN: OFF';
      }
    }
  }

  fitTrack() {
    if (this.trackPoints.length > 1) {
      this.map.fitBounds(this.flightTrack.getBounds(), { padding: [30, 30] });
      this.autoFollow = false;
      this.updateFollowButtonState();
    } else {
      this.centerRunway();
    }
  }

  centerRunway() {
    this.map.setView(this.ukllRwy13Threshold, 14);
  }

  resetTrack() {
    this.trackPoints = [];
    this.flightTrackHalo.setLatLngs([]);
    this.flightTrack.setLatLngs([]);
  }
}

window.NavigationDisplay = NavigationDisplay;
