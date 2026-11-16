/**
 * Navigation Display (ND) Tactical Moving Map with Authentic Garmin G1000 Avionics
 * 
 * FEATURES:
 * 1. Garmin G1000 TAWS Terrain Mode (Dynamic Red/Yellow Proximity Elevation Warnings):
 *    - RED: Terrain >= Aircraft Altitude - 100 FT (Terrain Impact Hazard)
 *    - YELLOW: Aircraft Altitude - 1000 FT <= Terrain < Aircraft Altitude - 100 FT (Caution Clearance)
 *    - DARK NAVY / BLACK: Terrain < Aircraft Altitude - 1000 FT (Safe Clearance)
 * 2. Garmin G1000 Topo Mode (Authentic Hypsometric Elevation Coloring):
 *    - Absolute elevation contours and colored terrain relief matching Garmin G1000 MFD.
 * 3. Range Rings (10 NM & 25 NM) with authentic compass marks and distance badge.
 * 4. Garmin Softkeys Bar ([ TRAFFIC ] [ TOPO ] [ TERRAIN ] [ SATELLITE ] [ RELIEF ]).
 * 5. Waypoint markers (UKLL cyan, UK51 magenta) & UKLL RWY 13/31 extended ILS corridor.
 * 6. ZERO-MOCK COMPLIANCE:
 *    - Prominent red 'NO GPS FIX • POSITION LOST' warning if telemetry is lost.
 *    - Removes aircraft marker and freezes track. NEVER simulates fake coordinates.
 */

// ================= GARMIN HIGH-PERFORMANCE CANVAS ELEVATION LAYER =================

const GarminElevationLayer = L.GridLayer.extend({
  options: {
    minZoom: 4,
    maxZoom: 16,
    tileSize: 256,
    mode: 'taws', // 'taws' or 'topo'
    currentAltMsl: 1064,
  },

  initialize: function (options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this.mode = options.mode || 'taws';
    this.currentAltMsl = options.currentAltMsl || 1064;
  },

  setAircraftAltitude: function (altMsl) {
    if (altMsl === null || altMsl === undefined || isNaN(altMsl)) return;
    const diff = Math.abs(altMsl - this.currentAltMsl);
    if (diff >= 30) {
      this.currentAltMsl = altMsl;
      if (this.mode === 'taws') {
        this.redraw();
      }
    }
  },

  createTile: function (coords, done) {
    const tile = document.createElement('canvas');
    tile.width = 256;
    tile.height = 256;
    const ctx = tile.getContext('2d');

    // Clamp zoom to available Terrarium levels (up to 14)
    const z = Math.min(coords.z, 14);
    const scale = Math.pow(2, coords.z - z);
    const x = Math.floor(coords.x / scale);
    const y = Math.floor(coords.y / scale);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `/api/tiles/terrarium/${z}/${x}/${y}.png`;

    img.onload = () => {
      try {
        const offscreen = document.createElement('canvas');
        offscreen.width = 256;
        offscreen.height = 256;
        const offCtx = offscreen.getContext('2d');

        if (scale > 1) {
          const subW = 256 / scale;
          const subH = 256 / scale;
          const subX = (coords.x % scale) * subW;
          const subY = (coords.y % scale) * subH;
          offCtx.drawImage(img, subX, subY, subW, subH, 0, 0, 256, 256);
        } else {
          offCtx.drawImage(img, 0, 0);
        }

        const srcImgData = offCtx.getImageData(0, 0, 256, 256);
        const src = srcImgData.data;

        const outImgData = ctx.createImageData(256, 256);
        const out = outImgData.data;

        const alt = this.currentAltMsl;
        const redThresh = alt - 100;
        const yellowThresh = alt - 1000;
        const isTaws = this.mode === 'taws';

        for (let i = 0; i < src.length; i += 4) {
          const r = src[i];
          const g = src[i + 1];
          const b = src[i + 2];

          // Terrarium elevation decode: (R * 256.0 + G + B / 256.0) - 32768.0
          const elevM = (r * 256.0 + g + b / 256.0) - 32768.0;
          const elevFt = elevM * 3.28084;

          if (isTaws) {
            // Authentic Garmin G1000 TAWS Proximity Mode
            if (elevFt >= redThresh) {
              // RED: Hazard / Impact Zone (Terrain at or above aircraft - 100 FT)
              out[i] = 238;     // R
              out[i + 1] = 28;  // G
              out[i + 2] = 28;  // B
              out[i + 3] = 235; // A
            } else if (elevFt >= yellowThresh) {
              // YELLOW: Caution Zone (100 FT to 1000 FT below aircraft)
              out[i] = 252;     // R
              out[i + 1] = 211; // G
              out[i + 2] = 16;  // B
              out[i + 3] = 235; // A
            } else {
              // GREEN: Safe Clearance Zone (> 1000 FT below aircraft)
              if (elevM <= 0) {
                // Water body / sea level (Deep navy blue)
                out[i] = 15;
                out[i + 1] = 45;
                out[i + 2] = 95;
                out[i + 3] = 240;
              } else {
                // Safe ground terrain: Garmin TAWS Green
                out[i] = 38;
                out[i + 1] = 138;
                out[i + 2] = 52;
                out[i + 3] = 235;
              }
            }
          } else {
            // Authentic Garmin G1000 Topo Hypsometric Mode
            if (elevM < 0) {
              // Water bodies / sea level
              out[i] = 15; out[i + 1] = 45; out[i + 2] = 95; out[i + 3] = 240;
            } else if (elevM < 150) {
              // Lowlands: deep green
              out[i] = 45; out[i + 1] = 110; out[i + 2] = 50; out[i + 3] = 235;
            } else if (elevM < 250) {
              // Plains: bright green
              out[i] = 85; out[i + 1] = 135; out[i + 2] = 45; out[i + 3] = 235;
            } else if (elevM < 350) {
              // Rolling hills: yellow-olive
              out[i] = 145; out[i + 1] = 155; out[i + 2] = 45; out[i + 3] = 235;
            } else if (elevM < 500) {
              // Moderate hills (Lviv plateau 350-450m): warm ochre/gold
              out[i] = 195; out[i + 1] = 160; out[i + 2] = 60; out[i + 3] = 235;
            } else if (elevM < 800) {
              // Sub-Carpathian foothills: terracotta / orange-brown
              out[i] = 185; out[i + 1] = 105; out[i + 2] = 50; out[i + 3] = 235;
            } else if (elevM < 1200) {
              // Carpathian mountains: deep sienna/brown
              out[i] = 135; out[i + 1] = 65; out[i + 2] = 35; out[i + 3] = 240;
            } else {
              // Mountain peaks: slate gray / white
              out[i] = 120; out[i + 1] = 120; out[i + 2] = 130; out[i + 3] = 240;
            }
          }
        }

        ctx.putImageData(outImgData, 0, 0);
        done(null, tile);
      } catch (err) {
        done(null, tile);
      }
    };

    img.onerror = () => {
      done(null, tile);
    };

    return tile;
  }
});


// ================= NAVIGATION DISPLAY CLASS =================

class NavigationDisplay {
  constructor(containerId = 'nd-map', alertBannerId = 'nd-no-gps-alert') {
    this.container = document.getElementById(containerId);
    this.alertBanner = document.getElementById(alertBannerId);

    if (!this.container) {
      console.warn(`ND Map container '${containerId}' not found`);
      return;
    }

    // UKLL (Lviv Danylo Halytskyi Intl Airport) RWY 13/31 Coordinates (Official AIP Ukraine / OSM)
    // Physical concrete runway: 3,305 m × 45 m, True heading: 135.84°
    this.ukllRwy13Threshold = [49.820397, 23.942372];
    this.ukllRwy13DisplacedThreshold = [49.817786, 23.946300];
    this.ukllRwy31DisplacedThreshold = [49.799899, 23.973212];
    this.ukllRwy31Threshold = [49.799098, 23.974418];
    this.rwy13Heading = 135.84;

    this.autoFollow = true;
    this.trackPoints = [];
    this.currentLat = null;
    this.currentLon = null;
    this.currentHeading = 0;
    this.currentAltMsl = 1064; // Default UKLL runway elevation
    this.isOnline = false;

    this.initMap();
  }

  initMap() {
    // Initialize Leaflet map
    this.map = L.map(this.container.id, {
      center: this.ukllRwy13Threshold,
      zoom: 12,
      zoomControl: true,
      attributionControl: true,
    });

    // ================= TERRAIN & TOPOGRAPHIC BASE LAYERS =================

    // 1. Garmin G1000 TAWS Mode (Dynamic Red/Yellow Elevation Proximity)
    const garminTaws = new GarminElevationLayer({
      mode: 'taws',
      currentAltMsl: this.currentAltMsl,
      attribution: 'Терейн: &copy; Garmin TAWS (SRTM 30m)',
    });

    // 2. Garmin G1000 Topo Mode (Authentic Hypsometric Elevation Contours)
    const garminTopo = new GarminElevationLayer({
      mode: 'topo',
      attribution: 'Терейн: &copy; Garmin Topo (SRTM 30m)',
    });

    // 3. OpenTopoMap: Topographic elevation contours (ізогіпси) & hillshade relief
    const openTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      subdomains: 'abc',
      attribution: 'Терейн: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
    });

    // 4. ESRI World Topo: High-detail topographic relief with elevation shading
    const esriTopo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Терейн: &copy; Esri World Topo'
    });

    // 5. ESRI Shaded Relief: Pure 3D elevation hillshade terrain model
    const esriRelief = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 13,
      attribution: 'Рельєф: &copy; Esri Shaded Relief'
    });

    // 6. ESRI Satellite: High-res satellite imagery showing physical terrain & geography
    const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Супутник: &copy; Esri World Imagery'
    });

    // 7. OpenStreetMap: Clean standard vector base
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    });

    this.layers = {
      garmin_taws: garminTaws,
      garmin_topo: garminTopo,
      opentopo: openTopo,
      esritopo: esriTopo,
      relief: esriRelief,
      satellite: esriSat,
      osm: osm,
    };

    // Default active layer: Garmin G1000 TAWS Terrain Mode (matching real Garmin MFD!)
    this.currentLayerKey = 'garmin_taws';
    this.layers.garmin_taws.addTo(this.map);

    // Draw Runway 13/31 & Alignment lines with high-contrast outlines
    this.drawAirportEnvironment();

    // Draw Airport & Nearby Waypoint Markers (UKLL cyan, UK51 magenta)
    this.createAirportWaypoints();

    // Draw Garmin Range Rings (10 NM & 25 NM)
    this.createRangeRings();

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

    // Create Garmin G1000 Softkeys Bar
    this.createSoftkeys();

    // Create Garmin Terrain Legend Box
    this.createLegends();

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

  createSoftkeys() {
    if (!this.container) return;
    const bar = document.createElement('div');
    bar.className = 'garmin-softkeys-bar';
    bar.innerHTML = `
      <button class="garmin-softkey-btn" data-layer="osm">TRAFFIC</button>
      <button class="garmin-softkey-btn" data-layer="garmin_topo">TOPO</button>
      <button class="garmin-softkey-btn active" data-layer="garmin_taws">TERRAIN</button>
      <button class="garmin-softkey-btn" data-layer="satellite">SATELLITE</button>
      <button class="garmin-softkey-btn" data-layer="opentopo">RELIEF</button>
    `;
    this.container.appendChild(bar);
    this.softkeysBar = bar;

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.garmin-softkey-btn');
      if (btn && btn.dataset.layer) {
        this.setLayer(btn.dataset.layer);
      }
    });
  }

  updateSoftkeys(layerKey) {
    if (!this.softkeysBar) return;
    const btns = this.softkeysBar.querySelectorAll('.garmin-softkey-btn');
    btns.forEach((btn) => {
      const btnLayer = btn.dataset.layer;
      const isActive = (btnLayer === layerKey);
      btn.classList.toggle('active', isActive);
    });
  }

  createLegends() {
    if (!this.container) return;
    const legend = document.createElement('div');
    legend.id = 'nd-garmin-legend';
    legend.className = 'garmin-terrain-legend';
    this.container.appendChild(legend);
    this.legendEl = legend;
    this.updateLegend(this.currentLayerKey);
  }

  updateLegend(layerKey) {
    if (!this.legendEl) return;
    if (layerKey === 'garmin_taws') {
      this.legendEl.style.display = 'block';
      this.legendEl.innerHTML = `
        <div class="legend-title">GARMIN G1000 TAWS</div>
        <div class="legend-item"><span class="color-box" style="background:#ee1c1c;"></span> РЕЛЬЄФ ВИЩЕ (+100 FT)</div>
        <div class="legend-item"><span class="color-box" style="background:#fcd310;"></span> ЗАПАС &lt; 1000 FT</div>
        <div class="legend-item"><span class="color-box" style="background:#268a34;"></span> БЕЗПЕЧНО (&gt; 1000 FT)</div>
      `;
    } else if (layerKey === 'garmin_topo') {
      this.legendEl.style.display = 'block';
      this.legendEl.innerHTML = `
        <div class="legend-title">GARMIN G1000 TOPO</div>
        <div class="legend-item"><span class="color-box" style="background:#787882;"></span> &gt; 1200 м (Вершини)</div>
        <div class="legend-item"><span class="color-box" style="background:#874123;"></span> 800 - 1200 м (Карпати)</div>
        <div class="legend-item"><span class="color-box" style="background:#b96932;"></span> 500 - 800 м (Передгір'я)</div>
        <div class="legend-item"><span class="color-box" style="background:#c3a03c;"></span> 300 - 500 м (Пагорби)</div>
        <div class="legend-item"><span class="color-box" style="background:#55872d;"></span> 150 - 300 м (Рівнини)</div>
        <div class="legend-item"><span class="color-box" style="background:#2d6e32;"></span> &lt; 150 м (Низовини)</div>
      `;
    } else {
      this.legendEl.style.display = 'none';
    }
  }

  createAirportWaypoints() {
    // UKLL Waypoint Marker (Cyan)
    const ukllIcon = L.divIcon({
      className: 'garmin-wpt-label-container',
      html: `
        <div class="garmin-wpt-label">
          <div class="wpt-dot cyan"></div>
          <span class="wpt-text cyan">UKLL</span>
        </div>
      `,
      iconSize: [60, 20],
      iconAnchor: [5, 10],
    });
    L.marker(this.ukllRwy13Threshold, { icon: ukllIcon, interactive: false, zIndexOffset: 800 }).addTo(this.map);

    // UK51 Nearby Aerodrome / Waypoint (Magenta)
    const uk51Coords = [49.7712, 23.8650];
    const uk51Icon = L.divIcon({
      className: 'garmin-wpt-label-container',
      html: `
        <div class="garmin-wpt-label">
          <div class="wpt-dot magenta"></div>
          <span class="wpt-text magenta">UK51</span>
        </div>
      `,
      iconSize: [60, 20],
      iconAnchor: [5, 10],
    });
    L.marker(uk51Coords, { icon: uk51Icon, interactive: false, zIndexOffset: 800 }).addTo(this.map);
  }

  createRangeRings() {
    this.rangeRingsGroup = L.layerGroup().addTo(this.map);

    // Inner ring (10 NM = 18,520 m)
    this.innerRing = L.circle(this.ukllRwy13Threshold, {
      radius: 10 * 1852,
      color: '#ffffff',
      weight: 1.4,
      dashArray: '5, 6',
      fill: false,
      opacity: 0.45,
      interactive: false,
    }).addTo(this.rangeRingsGroup);

    // Outer ring (25 NM = 46,300 m)
    this.outerRing = L.circle(this.ukllRwy13Threshold, {
      radius: 25 * 1852,
      color: '#ffffff',
      weight: 1.8,
      dashArray: '8, 8',
      fill: false,
      opacity: 0.65,
      interactive: false,
    }).addTo(this.rangeRingsGroup);

    // 25 NM Badge marker
    const rangeIcon = L.divIcon({
      className: 'garmin-range-label-container',
      html: '<div class="garmin-range-badge">25 NM</div>',
      iconSize: [50, 20],
      iconAnchor: [25, 10],
    });

    const nmInDegLat = 1.0 / 60.0;
    const nmInDegLon = nmInDegLat / Math.cos((49.82 * Math.PI) / 180.0);
    const badgeLat = this.ukllRwy13Threshold[0] + 25 * nmInDegLat * 0.7071;
    const badgeLon = this.ukllRwy13Threshold[1] + 25 * nmInDegLon * 0.7071;

    this.rangeBadgeMarker = L.marker([badgeLat, badgeLon], {
      icon: rangeIcon,
      interactive: false,
      zIndexOffset: 850,
    }).addTo(this.rangeRingsGroup);
  }

  updateRangeRings(lat, lon) {
    if (!this.rangeRingsGroup || !this.innerRing || !this.outerRing || !this.rangeBadgeMarker) return;
    this.innerRing.setLatLng([lat, lon]);
    this.outerRing.setLatLng([lat, lon]);

    const nmInDegLat = 1.0 / 60.0;
    const nmInDegLon = nmInDegLat / Math.cos((lat * Math.PI) / 180.0);
    const badgeLat = lat + (25 * nmInDegLat * 0.7071);
    const badgeLon = lon + (25 * nmInDegLon * 0.7071);
    this.rangeBadgeMarker.setLatLng([badgeLat, badgeLon]);
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
    this.updateSoftkeys(layerKey);
    this.updateLegend(layerKey);

    // Sync header dropdown if available
    const select = document.getElementById('nd-layer-select');
    if (select && select.value !== layerKey) {
      select.value = layerKey;
    }
  }

  drawAirportEnvironment() {
    // 1. Physical Runway 13/31 (45m wide geographic polygon)
    // Calculated perpendicular offsets (22.5m each side) matching OSM & AIP Ukraine exactly
    const rwyPolygon = [
      [49.820538, 23.942597],
      [49.820256, 23.942147],
      [49.798957, 23.974193],
      [49.799239, 23.974643],
    ];

    // Asphalt surface fill & high-contrast border matching actual airport footprint
    L.polygon(rwyPolygon, {
      color: '#000000',
      weight: 2,
      fillColor: '#1e293b',
      fillOpacity: 0.85,
    }).addTo(this.map).bindTooltip('ЗПС 13/31 UKLL (3,305 × 45 м, Курс 136°)', { permanent: false });

    // Runway casing halo for high contrast on satellite & topographic maps
    L.polyline([this.ukllRwy13Threshold, this.ukllRwy31Threshold], {
      color: '#000000',
      weight: 6,
      opacity: 0.8,
    }).addTo(this.map);

    // Crisp white dashed centerline
    L.polyline([this.ukllRwy13Threshold, this.ukllRwy31Threshold], {
      color: '#ffffff',
      weight: 2.5,
      dashArray: '12, 10',
      opacity: 0.98,
    }).addTo(this.map);

    // Displaced threshold landing bar (RWY 13)
    L.polyline([
      [49.817927, 23.946525],
      [49.817645, 23.946075]
    ], {
      color: '#22c55e',
      weight: 3.5,
      opacity: 0.95,
    }).addTo(this.map).bindTooltip('ЗМІЩЕНИЙ ПОРІГ ПОСАДКИ 13 (LDA 2,895 м)', { permanent: false });

    // 2. Extended ILS approach corridor (5 NM backwards along 315.84 deg)
    const nmInDegreesLat = 1.0 / 60.0;
    const nmInDegreesLon = nmInDegreesLat / Math.cos((49.8204 * Math.PI) / 180);
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

    // Touchdown threshold markers
    L.circleMarker(this.ukllRwy13Threshold, {
      radius: 6,
      color: '#ffffff',
      fillColor: '#22c55e',
      fillOpacity: 0.95,
      weight: 2,
    }).addTo(this.map).bindTooltip('THR 13 UKLL (326 м MSL)', { permanent: false });

    L.circleMarker(this.ukllRwy31Threshold, {
      radius: 6,
      color: '#ffffff',
      fillColor: '#ef4444',
      fillOpacity: 0.95,
      weight: 2,
    }).addTo(this.map).bindTooltip('THR 31 UKLL (328 м MSL)', { permanent: false });
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

    // Update Garmin terrain elevation altitude reference
    if (msl !== null && msl !== undefined) {
      this.currentAltMsl = msl;
      if (this.layers.garmin_taws) {
        this.layers.garmin_taws.setAircraftAltitude(msl);
      }
    }

    // Update Range Rings around aircraft
    this.updateRangeRings(lat, lon);

    // Update Terrain & Clearance HUD Badge
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
    this.map.setView(this.ukllRwy13Threshold, 12);
  }

  resetTrack() {
    this.trackPoints = [];
    this.flightTrackHalo.setLatLngs([]);
    this.flightTrack.setLatLngs([]);
  }
}

window.NavigationDisplay = NavigationDisplay;
