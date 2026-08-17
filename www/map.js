/**
 * Pin-drop map for the inspection block.
 *
 * Leaflet is loaded from a CDN ON DEMAND, not bundled. That is a deliberate
 * trade: satellite tiles need a connection anyway, so a map that only works
 * online costs nothing extra, and vendoring ~150 KB of library into every APK
 * to power a feature that cannot function offline is the worse deal.
 *
 * Everything here degrades to nothing. If the library will not load, the caller
 * shows a notice and GPS stays the way to place a plot — which is the better
 * method regardless, since the surveyor is standing on the parcel.
 *
 * TO MAKE THE MAP WORK OFFLINE LATER: drop leaflet.js and leaflet.css into
 * www/vendor/ and point LEAFLET_JS/LEAFLET_CSS at them. Tiles would still need
 * a connection or a pre-cached tile set.
 */

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';

// Same imagery the desktop Field Map uses, so a plot looks the same in both.
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE_ATTR = 'Esri';

const KANO = { lat: 11.9964, lng: 8.5919 };

let loadPromise = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);

  if (!loadPromise) {
    loadPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      document.head.appendChild(css);

      const script = document.createElement('script');
      script.src = LEAFLET_JS;
      script.onload = () => resolve(window.L);
      script.onerror = () => reject(new Error('Map library could not be downloaded.'));
      document.head.appendChild(script);

      // Without this an offline device hangs on a script tag that never fires
      // either handler, and the sheet appears frozen.
      setTimeout(() => reject(new Error('Map library timed out.')), 15000);
    }).catch((error) => {
      loadPromise = null;      // let a later attempt retry once back online
      throw error;
    });
  }

  return loadPromise;
}

/**
 * Mount a pin-drop map.
 *
 * @param {HTMLElement} container
 * @param {?{lat:number,lng:number}} initial
 * @param {(coords:{lat:number,lng:number}) => void} onPick
 * @returns {Promise<{setPin:Function, destroy:Function}>}
 */
export async function mountPinMap(container, initial, onPick) {
  const L = await loadLeaflet();

  // Leaflet refuses to re-initialise a container it has already used.
  if (container._leaflet_id) {
    container.innerHTML = '';
    delete container._leaflet_id;
  }

  const start = initial || KANO;

  const map = L.map(container, {
    center: [start.lat, start.lng],
    zoom: initial ? 17 : 12,
    attributionControl: false
  });

  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);

  let marker = initial ? L.marker([initial.lat, initial.lng]).addTo(map) : null;

  const setPin = (coords, { pan = true } = {}) => {
    if (!coords) return;

    if (marker) {
      marker.setLatLng([coords.lat, coords.lng]);
    } else {
      marker = L.marker([coords.lat, coords.lng]).addTo(map);
    }

    if (pan) map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), 17));
  };

  map.on('click', (event) => {
    const coords = { lat: event.latlng.lat, lng: event.latlng.lng };
    setPin(coords, { pan: false });
    onPick(coords);
  });

  // The sheet animates open, so the container has no size when Leaflet first
  // measures it — without this the tiles render as grey slabs.
  setTimeout(() => map.invalidateSize(), 250);

  return {
    setPin,
    destroy: () => {
      try {
        map.remove();
      } catch {
        /* already gone */
      }
    }
  };
}
