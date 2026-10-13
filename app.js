const TYPE_COLORS = {
  mainland: "#e8c4b0",
  island: "#9ecfc9",
};

const ISLAND_BARANGAYS = new Set([
  "Cabacongan",
  "Canatuan",
  "Colongcogong",
  "Daraga",
  "Gata",
  "Gogon",
  "Haponan",
  "Oring",
  "Pagolinan",
  "Pandanan",
  "San Vicente",
]);

function normalizeName(name) {
  return String(name)
    .replace(/\(Pob\.?\)/gi, "")
    .replace(/\(Mandiclom\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ringKm2(ring) {
  const R = 6371008.8;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    area +=
      ((lon2 - lon1) * Math.PI) / 180 *
      (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180));
  }
  return (area * R * R) / 2 / 1e6;
}

function geometryKm2(geometry) {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  return polygons.reduce((sum, polygon) => {
    const outer = Math.abs(ringKm2(polygon[0]));
    const holes = polygon.slice(1).reduce((h, ring) => h + Math.abs(ringKm2(ring)), 0);
    return sum + (outer - holes);
  }, 0);
}

function outerRings(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates[0]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((polygon) => polygon[0]);
  return [];
}

function ringBbox(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += (x2 - x1) * (y1 + y2);
  }
  return Math.abs(area) / 2;
}

function bboxesTouch(a, b, buf) {
  return !(a[2] + buf < b[0] || b[2] + buf < a[0] || a[3] + buf < b[1] || b[3] + buf < a[1]);
}

function classifyLandmass(features) {
  const pieces = [];
  features.forEach((feature, featureIndex) => {
    outerRings(feature.geometry).forEach((ring) => {
      pieces.push({
        featureIndex,
        bbox: ringBbox(ring),
        area: ringArea(ring),
      });
    });
  });

  const parent = pieces.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function unite(i, j) {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[a] = b;
  }

  const buf = 0.0008;
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      if (bboxesTouch(pieces[i].bbox, pieces[j].bbox, buf)) unite(i, j);
    }
  }

  const clusterArea = new Map();
  pieces.forEach((piece, i) => {
    const root = find(i);
    clusterArea.set(root, (clusterArea.get(root) || 0) + piece.area);
  });
  let mainlandRoot = 0;
  let mainlandArea = -1;
  clusterArea.forEach((area, root) => {
    if (area > mainlandArea) {
      mainlandArea = area;
      mainlandRoot = root;
    }
  });

  const land = Array(features.length).fill(0);
  const island = Array(features.length).fill(0);
  pieces.forEach((piece, i) => {
    if (find(i) === mainlandRoot) land[piece.featureIndex] += piece.area;
    else island[piece.featureIndex] += piece.area;
  });

  return features.map((feature, i) => {
    const name = normalizeName(feature.properties.brgy_name);
    if (ISLAND_BARANGAYS.has(name)) return "island";
    return island[i] > land[i] ? "island" : "mainland";
  });
}

function formatKm2(n) {
  if (n < 1) return `${n.toFixed(2)} km²`;
  return `${n.toFixed(1)} km²`;
}

// New: format distance helper
function formatDistance(meters) {
  if (meters == null || !isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

// New: get approximate polygon center (average of outer ring coords)
function getFeatureCenter(geometry) {
  if (!geometry) return null;
  const coords =
    geometry.type === "Polygon"
      ? geometry.coordinates[0]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates[0][0]
        : [];
  if (!coords || !coords.length) return null;
  let sumX = 0,
    sumY = 0;
  coords.forEach(([lng, lat]) => {
    sumX += lng;
    sumY += lat;
  });
  return [sumX / coords.length, sumY / coords.length]; // [lng, lat]
}

const streets = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 16,
    attribution: "Tiles &copy; Esri",
  }
);

const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri",
  }
);

const map = L.map("map", {
  center: [13.77, 123.86],
  zoom: 11,
  layers: [streets],
  zoomControl: false,
});

L.control.zoom({ position: "bottomright" }).addTo(map);
L.control.scale({ metric: true, imperial: false }).addTo(map);

// SPX Hub coordinates (Tawog / near Katery)
const SPX_HUB = { lat: 13.7741485, lng: 123.8634766 };
const hubLatLng = L.latLng(SPX_HUB.lat, SPX_HUB.lng);

// Add hub marker and optional reference circles
const hubMarker = L.marker(hubLatLng, { title: "SPX Hub (Caramoan)", riseOnHover: true }).addTo(map);
hubMarker.bindPopup("SPX Hub (Tawog / near Katery)");
L.circle(hubLatLng, { radius: 1000, color: '#3388ff', weight: 1, fillOpacity: 0.03 }).addTo(map);
L.circle(hubLatLng, { radius: 3000, color: '#3388ff', weight: 1, dashArray: '4 6', fillOpacity: 0 }).addTo(map);

const layers = { streets, satellite };
document.querySelectorAll("[data-basemap]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-basemap]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    Object.values(layers).forEach((layer) => map.removeLayer(layer));
    layers[btn.dataset.basemap].addTo(map);
  });
});

const listEl = document.getElementById("barangay-list");
const searchEl = document.getElementById("search");
const layerByName = new Map();
const areaByName = new Map();
const typeByName = new Map();
let activeName = null;
let allBounds = null;
let listFilter = "all";

function focusPadding() {
  const wide = window.innerWidth > 820;
  return {
    paddingTopLeft: wide ? [250, 18] : [14, 150],
    paddingBottomRight: wide ? [216, 18] : [14, 160],
  };
}

function setActive(name) {
  activeName = name;
  listEl.querySelectorAll("li").forEach((li) => {
    li.classList.toggle("active", li.dataset.name === name);
    if (li.dataset.name === name) li.scrollIntoView({ block: "nearest" });
  });
  layerByName.forEach((layer, key) => {
    const selected = key === name;
    layer.setStyle({
      weight: selected ? 1.5 : name ? 0.5 : 0.8,
      color: selected ? "#8a6a5c" : "#fff",
      fillOpacity: name ? (selected ? 0.85 : 0.28) : 0.7,
    });
    if (selected) layer.bringToFront();
  });
}

function flyToBarangay(name) {
  const layer = layerByName.get(name);
  if (!layer) return;
  setActive(name);
  map.flyToBounds(layer.getBounds(), {
    ...focusPadding(),
    maxZoom: 15,
    duration: 0.85,
  });
  layer.openPopup();
}

function fillList(items) {
  function render() {
    const q = searchEl.value.trim().toLowerCase();
    listEl.innerHTML = "";
    const visible = items.filter((item) => {
      if (listFilter !== "all" && item.kind !== listFilter) return false;
      return item.name.toLowerCase().includes(q);
    });

    const groups = [
      { label: "Island", kind: "island" },
      { label: "Mainland", kind: "mainland" },
    ];
    groups.forEach((group) => {
      const rows = visible.filter((item) => item.kind === group.kind);
      if (!rows.length) return;
      const heading = document.createElement("li");
      heading.className = "group";
      heading.textContent = `${group.label} · ${rows.length}`;
      listEl.appendChild(heading);
      rows.forEach((item) => {
        const li = document.createElement("li");
        li.dataset.name = item.name;
        li.innerHTML = `<span class="swatch" style="background:${TYPE_COLORS[item.kind]}"></span><span class="name">${item.name}</span><span class="area">${formatKm2(item.area)} · ${formatDistance(item.distanceKm*1000)}</span>`;
        li.addEventListener("click", () => flyToBarangay(item.name));
        if (item.name === activeName) li.classList.add("active");
        listEl.appendChild(li);
      });
    });
  }

  searchEl.addEventListener("input", render);
  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      listFilter = btn.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("active", b === btn));
      render();
    });
  });
  render();
}

document.getElementById("reset-view").addEventListener("click", () => {
  activeName = null;
  listFilter = "all";
  document.querySelectorAll("[data-filter]").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === "all");
  });
  searchEl.value = "";
  searchEl.dispatchEvent(new Event("input"));
  setActive(null);
  if (allBounds) map.flyToBounds(allBounds, { padding: [40, 40], duration: 0.7 });
});

fetch("data/barangays.geojson")
  .then((res) => res.json())
  .then((geojson) => {
    // compute displayName and area
    geojson.features.forEach((feature) => {
      const name = normalizeName(feature.properties.brgy_name);
      const area = geometryKm2(feature.geometry);
      feature.properties.displayName = name;
      feature.properties.areaKm2 = area;
      areaByName.set(name, area);
    });

    // classify island/mainland
    const kinds = classifyLandmass(geojson.features);
    geojson.features.forEach((feature, i) => {
      const name = feature.properties.displayName;
      feature.properties.kind = kinds[i];
      typeByName.set(name, kinds[i]);
    });

    // compute centers and distances to hub
    geojson.features.forEach((feature) => {
      const center = getFeatureCenter(feature.geometry); // [lng, lat]
      if (center) {
        feature.properties.center = center;
        const ll = L.latLng(center[1], center[0]);
        const distMeters = hubLatLng.distanceTo(ll);
        feature.properties.distanceMeters = distMeters;
        feature.properties.distanceKm = distMeters / 1000;
      } else {
        feature.properties.distanceMeters = null;
        feature.properties.distanceKm = Infinity;
      }
    });

    const layer = L.geoJSON(geojson, {
      style(feature) {
        return {
          color: "#fff",
          weight: 0.8,
          fillColor: TYPE_COLORS[feature.properties.kind],
          fillOpacity: 0.72,
        };
      },
      onEachFeature(feature, lyr) {
        const name = feature.properties.displayName;
        const area = feature.properties.areaKm2;
        const kind = feature.properties.kind;
        const kindLabel = kind === "island" ? "Island" : "Mainland";

        const distMeters = feature.properties.distanceMeters;
        const distanceText = distMeters != null ? `Distance from SPX Hub: ${formatDistance(distMeters)}` : "Distance unavailable";

        layerByName.set(name, lyr);
        lyr.bindPopup(
          `<div class="popup"><h2>${name}</h2><p class="sub">${kindLabel} · ${formatKm2(area)}</p><p class="sub">${distanceText}</p></div>`
        );
        lyr.bindTooltip(name, {
          permanent: true,
          direction: "center",
          className: "brgy-label",
          opacity: 1,
        });
        lyr.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          flyToBarangay(name);
        });
      },
    }).addTo(map);

    allBounds = layer.getBounds();
    map.fitBounds(allBounds, { padding: [28, 28] });

    const items = [...layerByName.keys()]
      .map((name) => {
        const feature = geojson.features.find((f) => f.properties.displayName === name);
        const distanceKm = feature && isFinite(feature.properties.distanceKm) ? feature.properties.distanceKm : Infinity;
        return {
          name,
          area: areaByName.get(name),
          kind: typeByName.get(name),
          distanceKm,
        };
      })
      // sort by distance then name
      .sort((a, b) => {
        if (a.distanceKm === b.distanceKm) return a.name.localeCompare(b.name);
        return a.distanceKm - b.distanceKm;
      });

    fillList(items);
    const islandCount = items.filter((item) => item.kind === "island").length;
    document.getElementById("land-count").textContent = String(items.length - islandCount);
    document.getElementById("island-count").textContent = String(islandCount);
  })
  .catch((err) => {
    console.error(err);
    document.getElementById("land-count").textContent = "—";
    document.getElementById("island-count").textContent = "—";
  });
