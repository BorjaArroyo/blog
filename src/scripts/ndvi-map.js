/**
 * NDVI Map — Client-side Edge Computing Pipeline (WebGL)
 *
 * 1. Search Element84 STAC API for latest Sentinel-2 L2A scene
 * 2. Fetch Red (B04) and NIR (B08) COG bands — viewport-windowed
 * 3. Compute NDVI per-pixel on GPU via WebGL fragment shader
 * 4. Render as image overlay on MapLibre basemap
 */
import maplibregl from 'maplibre-gl';
import proj4 from 'proj4';
import { ndviToRGBA } from './ndvi-colormap.js';
import { renderNDVIWebGL } from './ndvi-webgl-layer.js';

// ─── Configuration ──────────────────────────────────────────────
const STAC_API = 'https://earth-search.aws.element84.com/v1/search';
const COLLECTION = 'sentinel-2-l2a';
const MAX_CLOUD_COVER = 20;

// Casa de Campo, Madrid
const DEFAULT_CENTER = [-3.7486, 40.4225];
const DEFAULT_ZOOM = 13;

// Cap output resolution to avoid downloading too much data
const MAX_OUTPUT_DIM = 1024;

// ─── DOM References ─────────────────────────────────────────────
const mapContainer = document.getElementById('ndvi-map');
const statusEl = document.getElementById('ndvi-status');

if (!mapContainer) {
  throw new Error('Missing #ndvi-map container');
}

// ─── Status helpers ─────────────────────────────────────────────
function setStatus(text, type = 'info') {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.type = type;
}

// ─── STAC Search ────────────────────────────────────────────────
async function searchLatestScene(bounds) {
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];

  const body = {
    collections: [COLLECTION],
    bbox,
    limit: 1,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    query: { 'eo:cloud_cover': { lte: MAX_CLOUD_COVER } },
  };

  setStatus('Searching Sentinel-2 archive…');
  const t0 = performance.now();

  const res = await fetch(STAC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`STAC search failed: ${res.status}`);

  const data = await res.json();
  const elapsed = (performance.now() - t0).toFixed(0);

  if (!data.features?.length) {
    setStatus('No scenes found — try a different area or raise cloud cover.', 'error');
    return null;
  }

  const scene = data.features[0];
  const sceneDate = scene.properties.datetime?.slice(0, 10) ?? 'unknown';
  const cloudPct = scene.properties['eo:cloud_cover']?.toFixed(1) ?? '?';
  setStatus(`Found scene ${sceneDate} (☁ ${cloudPct}%) — ${elapsed} ms`);
  return scene;
}

// ─── Band URL helper ────────────────────────────────────────────
function getBandUrl(scene, band) {
  const asset = scene.assets[band];
  if (!asset) throw new Error(`Band "${band}" not in scene assets`);
  return asset.href;
}

// ─── Projection helper ─────────────────────────────────────────
async function ensureProj(image) {
  const geoKeys = image.getGeoKeys();
  const code = geoKeys.ProjectedCSTypeGeoKey;
  if (!code) throw new Error('No ProjectedCSTypeGeoKey in GeoTIFF');
  const epsg = `EPSG:${code}`;

  if (!proj4.defs(epsg)) {
    const r = await fetch(`https://epsg.io/${code}.proj4`);
    if (!r.ok) throw new Error(`Could not fetch proj4 def for ${epsg}`);
    proj4.defs(epsg, await r.text());
  }
  return epsg;
}

// ─── Viewport → GeoTIFF pixel window ────────────────────────────
function viewportToWindow(image, mapBounds, epsg) {
  const [geoXmin, geoYmin, geoXmax, geoYmax] = image.getBoundingBox();
  const imgW = image.getWidth();
  const imgH = image.getHeight();

  // Reproject map bounds to the GeoTIFF's native CRS
  const sw = proj4('EPSG:4326', epsg, [mapBounds.getWest(), mapBounds.getSouth()]);
  const ne = proj4('EPSG:4326', epsg, [mapBounds.getEast(), mapBounds.getNorth()]);

  // Intersect viewport with image extent
  const xMin = Math.max(geoXmin, sw[0]);
  const yMin = Math.max(geoYmin, sw[1]);
  const xMax = Math.min(geoXmax, ne[0]);
  const yMax = Math.min(geoYmax, ne[1]);
  if (xMin >= xMax || yMin >= yMax) return null;

  // Convert geo → pixel (origin = top-left)
  const pxLeft  = Math.floor(((xMin - geoXmin) / (geoXmax - geoXmin)) * imgW);
  const pxTop   = Math.floor(((geoYmax - yMax) / (geoYmax - geoYmin)) * imgH);
  const pxRight = Math.ceil(((xMax - geoXmin) / (geoXmax - geoXmin)) * imgW);
  const pxBot   = Math.ceil(((geoYmax - yMin) / (geoYmax - geoYmin)) * imgH);

  // Clamp to image dimensions — geotiff.js window = [left, top, right, bottom]
  const win = [
    Math.max(0, pxLeft),
    Math.max(0, pxTop),
    Math.min(imgW, pxRight),
    Math.min(imgH, pxBot),
  ];

  // Back-project the actual pixel window to geo-coords for MapLibre alignment
  const aXmin = geoXmin + (win[0] / imgW) * (geoXmax - geoXmin);
  const aXmax = geoXmin + (win[2] / imgW) * (geoXmax - geoXmin);
  const aYmax = geoYmax - (win[1] / imgH) * (geoYmax - geoYmin);
  const aYmin = geoYmax - (win[3] / imgH) * (geoYmax - geoYmin);

  // Corners in WGS84 for MapLibre [TL, TR, BR, BL]
  const coords = [
    proj4(epsg, 'EPSG:4326', [aXmin, aYmax]),
    proj4(epsg, 'EPSG:4326', [aXmax, aYmax]),
    proj4(epsg, 'EPSG:4326', [aXmax, aYmin]),
    proj4(epsg, 'EPSG:4326', [aXmin, aYmin]),
  ];

  return { win, coords };
}

// ─── Build the 1D colormap canvas ───────────────────────────────
function buildColormapCanvas() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 1;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(256, 1);
  for (let i = 0; i < 256; i++) {
    const ndvi = (i / 255) * 2 - 1;
    const [r, g, b, a] = ndviToRGBA(ndvi);
    img.data[i * 4]     = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Cache the colormap so we don't rebuild it every render
const colormapCanvas = buildColormapCanvas();

// ─── Initialize MapLibre ────────────────────────────────────────
const map = new maplibregl.Map({
  container: mapContainer,
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '&copy; OpenStreetMap contributors',
      },
    },
    layers: [{
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm',
      minzoom: 0,
      maxzoom: 19,
    }],
  },
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  maxZoom: 16,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

// ─── Load NDVI layer ────────────────────────────────────────────
let currentId = null;
let isLoading = false;

async function loadNDVI() {
  if (isLoading) return;
  isLoading = true;

  const bounds = map.getBounds();

  try {
    // 1. STAC search
    const scene = await searchLatestScene(bounds);
    if (!scene) { isLoading = false; return; }

    const redUrl = getBandUrl(scene, 'red');
    const nirUrl = getBandUrl(scene, 'nir');
    const sceneDate = scene.properties.datetime?.slice(0, 10) ?? '';

    // 2. Open COGs
    setStatus('Opening COGs…');
    const { fromUrl } = await import('geotiff');
    const [redTiff, nirTiff] = await Promise.all([fromUrl(redUrl), fromUrl(nirUrl)]);

    // Always work with the full-resolution image for metadata.
    // geotiff.js will automatically pick the best overview level
    // when we specify output width/height smaller than the window.
    const [redImage, nirImage] = await Promise.all([
      redTiff.getImage(0),
      nirTiff.getImage(0),
    ]);

    // 3. Projection + viewport window
    const epsg = await ensureProj(redImage);
    const vw = viewportToWindow(redImage, bounds, epsg);
    if (!vw) throw new Error('Viewport does not overlap the scene');

    // Calculate output resolution: cap to MAX_OUTPUT_DIM
    const winW = vw.win[2] - vw.win[0];
    const winH = vw.win[3] - vw.win[1];
    const scale = Math.min(1, MAX_OUTPUT_DIM / Math.max(winW, winH));
    const outW = Math.round(winW * scale);
    const outH = Math.round(winH * scale);

    setStatus(`Fetching ${outW}×${outH} px (from ${winW}×${winH})…`);
    const t0 = performance.now();

    // 4. Fetch — geotiff.js uses COG overviews automatically when outW < winW
    const [redRaster, nirRaster] = await Promise.all([
      redImage.readRasters({ window: vw.win, width: outW, height: outH, samples: [0] }),
      nirImage.readRasters({ window: vw.win, width: outW, height: outH, samples: [0] }),
    ]);

    const fetchMs = (performance.now() - t0).toFixed(0);
    setStatus(`WebGL: computing NDVI…`);

    // 5. GPU compute
    const gpuT0 = performance.now();
    const ndviCanvas = renderNDVIWebGL(redRaster[0], nirRaster[0], outW, outH, colormapCanvas);
    const gpuMs = (performance.now() - gpuT0).toFixed(0);

    // 6. Add to map
    // Remove old layer/source
    if (currentId) {
      if (map.getLayer(currentId)) map.removeLayer(currentId);
      if (map.getSource(currentId)) map.removeSource(currentId);
    }

    const id = 'ndvi-' + Date.now();
    currentId = id;

    map.addSource(id, {
      type: 'image',
      url: ndviCanvas.toDataURL(),
      coordinates: vw.coords,
    });
    map.addLayer({
      id,
      type: 'raster',
      source: id,
      paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 300 },
    });

    const totalMs = (performance.now() - t0).toFixed(0);
    setStatus(
      `${sceneDate} · ${outW}×${outH} px · fetch ${fetchMs} ms · GPU ${gpuMs} ms · total ${totalMs} ms`,
      'success',
    );
  } catch (err) {
    console.error('NDVI pipeline error:', err);
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    isLoading = false;
  }
}

// ─── Event binding ──────────────────────────────────────────────
map.on('load', () => loadNDVI());

let reloadTimeout;
map.on('moveend', () => {
  clearTimeout(reloadTimeout);
  reloadTimeout = setTimeout(loadNDVI, 800);
});
