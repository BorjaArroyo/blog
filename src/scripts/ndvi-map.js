/**
 * NDVI Map — Client-side Edge Computing Pipeline
 *
 * 1. Search Element84 STAC API for latest Sentinel-2 L2A scene
 * 2. Fetch Red (B04) and NIR (B08) COG bands via geotiff.js
 * 3. Compute NDVI per-pixel on CPU
 * 4. Render as image overlay on MapLibre basemap
 */
import maplibregl from 'maplibre-gl';
import { ndviToRGBA } from './ndvi-colormap.js';

// ─── Configuration ──────────────────────────────────────────────
const STAC_API = 'https://earth-search.aws.element84.com/v1/search';
const COLLECTION = 'sentinel-2-l2a';
const MAX_CLOUD_COVER = 20;

// Casa de Campo, Madrid
const DEFAULT_CENTER = [-3.7486, 40.4225];
const DEFAULT_ZOOM = 13;

// Max pixel dimension for raster decode (balances quality vs speed)
const MAX_RASTER_DIM = 1024;

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
    query: {
      'eo:cloud_cover': { lte: MAX_CLOUD_COVER },
    },
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

  if (!data.features || data.features.length === 0) {
    setStatus('No scenes found. Try a different area or increase cloud cover threshold.', 'error');
    return null;
  }

  const scene = data.features[0];
  const sceneDate = scene.properties.datetime?.slice(0, 10) ?? 'unknown';
  const cloudCover = scene.properties['eo:cloud_cover']?.toFixed(1) ?? '?';
  setStatus(`Found scene ${sceneDate} (☁ ${cloudCover}%) — STAC ${elapsed}ms`);

  return scene;
}

// ─── Band URLs ──────────────────────────────────────────────────
function getBandUrl(scene, band) {
  const asset = scene.assets[band];
  if (!asset) throw new Error(`Band ${band} not found in scene assets`);
  return asset.href;
}

// ─── Extract scene bounding box in EPSG:4326 ───────────────────
function getSceneBBox(scene) {
  // STAC items always have a bbox in [west, south, east, north] EPSG:4326
  return scene.bbox;
}

// ─── Initialize Map ─────────────────────────────────────────────
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
    layers: [
      {
        id: 'osm-tiles',
        type: 'raster',
        source: 'osm',
        minzoom: 0,
        maxzoom: 19,
      },
    ],
  },
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  maxZoom: 16,
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');

// ─── Load NDVI layer ────────────────────────────────────────────
let currentSourceIds = [];
let isLoading = false;

async function loadNDVI() {
  if (isLoading) return;
  isLoading = true;

  const bounds = map.getBounds();

  try {
    const scene = await searchLatestScene(bounds);
    if (!scene) { isLoading = false; return; }

    const redUrl = getBandUrl(scene, 'red');
    const nirUrl = getBandUrl(scene, 'nir');
    const sceneDate = scene.properties.datetime?.slice(0, 10) ?? '';

    // Remove previous layers/sources
    for (const id of currentSourceIds) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }

    const sourceId = 'ndvi-' + Date.now();
    currentSourceIds = [sourceId];

    setStatus('Loading bands (Red + NIR)…');
    const t0 = performance.now();

    const { fromUrl } = await import('geotiff');

    // Fetch both bands in parallel
    const [redTiff, nirTiff] = await Promise.all([
      fromUrl(redUrl),
      fromUrl(nirUrl),
    ]);

    const [redImage, nirImage] = await Promise.all([
      redTiff.getImage(),
      nirTiff.getImage(),
    ]);

    // Read at a downscaled resolution using COG overviews for speed
    const imageWidth = redImage.getWidth();
    const imageHeight = redImage.getHeight();
    const scale = Math.min(1, MAX_RASTER_DIM / Math.max(imageWidth, imageHeight));
    const width = Math.round(imageWidth * scale);
    const height = Math.round(imageHeight * scale);

    setStatus(`Decoding ${width}×${height} pixels…`);

    const [redRaster, nirRaster] = await Promise.all([
      redImage.readRasters({ width, height, samples: [0] }),
      nirImage.readRasters({ width, height, samples: [0] }),
    ]);

    const redData = redRaster[0];
    const nirData = nirRaster[0];

    // Compute NDVI and render to canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    const pixels = imageData.data;

    const computeT0 = performance.now();

    for (let i = 0; i < redData.length; i++) {
      const red = redData[i];
      const nir = nirData[i];
      const sum = nir + red;

      // Handle nodata (typically 0 in both bands)
      if (red === 0 && nir === 0) {
        pixels[i * 4 + 3] = 0; // fully transparent
        continue;
      }

      const ndvi = sum > 0 ? (nir - red) / sum : 0;
      const [r, g, b, a] = ndviToRGBA(ndvi);
      pixels[i * 4] = r;
      pixels[i * 4 + 1] = g;
      pixels[i * 4 + 2] = b;
      pixels[i * 4 + 3] = a;
    }

    const computeMs = (performance.now() - computeT0).toFixed(0);
    ctx.putImageData(imageData, 0, 0);

    // Use the STAC item bbox (EPSG:4326) for geographic placement
    const [west, south, east, north] = getSceneBBox(scene);
    const coordinates = [
      [west, north],  // top-left
      [east, north],  // top-right
      [east, south],  // bottom-right
      [west, south],  // bottom-left
    ];

    // Add as image source to MapLibre
    map.addSource(sourceId, {
      type: 'image',
      url: canvas.toDataURL(),
      coordinates,
    });

    map.addLayer({
      id: sourceId,
      type: 'raster',
      source: sourceId,
      paint: {
        'raster-opacity': 0.85,
        'raster-fade-duration': 300,
      },
    });

    const totalMs = (performance.now() - t0).toFixed(0);
    setStatus(`${sceneDate} · ${width}×${height}px · compute ${computeMs}ms · total ${totalMs}ms`);

  } catch (err) {
    console.error('NDVI pipeline error:', err);
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    isLoading = false;
  }
}

// ─── Event binding ──────────────────────────────────────────────
map.on('load', () => {
  loadNDVI();
});

// Reload NDVI when user finishes panning/zooming
let reloadTimeout;
map.on('moveend', () => {
  clearTimeout(reloadTimeout);
  reloadTimeout = setTimeout(() => {
    loadNDVI();
  }, 800);
});
