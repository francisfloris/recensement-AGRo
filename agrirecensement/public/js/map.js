/* =========================================================
   Cartographie (Leaflet) : carte des exploitations + sélecteur de position
   ========================================================= */
const Carto = (() => {
  const CENTRE_CONGO = [-1.2, 15.2];
  const CHEFS_LIEUX = {
    "Bouenza": [-4.15, 13.55], "Brazzaville": [-4.27, 15.28], "Congo-Oubangui": [-1.23, 16.80], "Cuvette": [-0.48, 15.90],
    "Cuvette-Ouest": [-0.88, 14.82], "Djoué-Léfini": [-3.47, 15.53], "Kouilou": [-4.65, 11.95], "Lékoumou": [-3.68, 13.35],
    "Likouala": [1.62, 18.06], "Niari": [-4.20, 12.67], "Nkéni-Alima": [-1.87, 15.86], "Plateaux": [-2.54, 14.75],
    "Pointe-Noire": [-4.78, 11.86], "Pool": [-4.36, 14.76], "Sangha": [1.61, 16.05]
  };
  const FONDS = {
    osm: () => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }),
    sat: () => L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagerie © Esri" })
  };
  const PALETTE = ["#1f7a3f", "#d97706", "#2563eb", "#9333ea", "#dc2626", "#0891b2", "#65a30d", "#db2777", "#4b5563"];

  let grande = null, couche = null, fondActuel = null, fondNom = "";
  let picker = null, pickerMarker = null, pickerCb = null, pickerPos = null;

  const valide = d => d.lat !== "" && d.lng !== "" && d.lat != null && d.lng != null && !isNaN(+d.lat) && !isNaN(+d.lng);

  function changerFond(map, nom) {
    if (fondNom === nom && fondActuel) return;
    if (fondActuel) map.removeLayer(fondActuel);
    fondActuel = FONDS[nom]().addTo(map); fondNom = nom;
  }

  function couleurs(records, mode) {
    if (mode === "sexe") return { fn: d => d.sexe === "Féminin" ? "#db2777" : "#2563eb", legende: [["Hommes", "#2563eb"], ["Femmes", "#db2777"]] };
    if (mode === "superficie") {
      const cl = [[1, "< 1 ha", "#fde68a"], [3, "1 – 3 ha", "#facc15"], [5, "3 – 5 ha", "#84cc16"], [10, "5 – 10 ha", "#16a34a"], [Infinity, "> 10 ha", "#14532d"]];
      return { fn: d => cl.find(c => (+d.superficie || 0) < c[0])[2], legende: cl.map(c => [c[1], c[2]]) };
    }
    const cpt = {};
    records.forEach(d => { const c = (d.cultures || [])[0]; if (c) cpt[c] = (cpt[c] || 0) + 1; });
    const top = Object.entries(cpt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);
    const map = Object.fromEntries(top.map((c, i) => [c, PALETTE[i]]));
    return { fn: d => map[(d.cultures || [])[0]] || PALETTE[8], legende: [...top.map(c => [c, map[c]]), ["Autres", PALETTE[8]]] };
  }

  return {
    CHEFS_LIEUX,
    valide,

    afficherGrande(el, records, { couleur = "sexe", fond = "osm", popup, legendeEl, infoEl } = {}) {
      if (!grande) {
        grande = L.map(el, { preferCanvas: true, zoomControl: true }).setView(CENTRE_CONGO, 6);
        L.control.scale({ imperial: false }).addTo(grande);
      }
      changerFond(grande, fond);
      setTimeout(() => grande.invalidateSize(), 50);
      if (couche) grande.removeLayer(couche);
      couche = L.featureGroup().addTo(grande);
      const avecGPS = records.filter(valide);
      const { fn, legende } = couleurs(avecGPS, couleur);
      avecGPS.forEach(d => {
        L.circleMarker([+d.lat, +d.lng], { radius: 7, weight: 1.5, color: "#fff", fillColor: fn(d), fillOpacity: .9 })
          .bindPopup(() => popup(d)).addTo(couche);
      });
      if (avecGPS.length) grande.fitBounds(couche.getBounds().pad(0.15), { maxZoom: 13 });
      if (legendeEl) legendeEl.innerHTML = legende.map(([l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join("");
      if (infoEl) infoEl.textContent = `${avecGPS.length} exploitation(s) géolocalisée(s) sur ${records.length}` + (records.length - avecGPS.length ? ` — ${records.length - avecGPS.length} sans coordonnées GPS` : "") + (navigator.onLine ? "" : " — hors ligne : seules les zones déjà consultées s'affichent");
    },

    centrerSur(lat, lng) { if (grande) grande.setView([lat, lng], 15); },

    ouvrirPicker(modalEl, mapEl, coordEl, { lat, lng, dept }, cb) {
      pickerCb = cb;
      modalEl.classList.add("ouvert");
      const init = valide({ lat, lng }) ? [+lat, +lng] : (CHEFS_LIEUX[dept] || CENTRE_CONGO);
      const zoom = valide({ lat, lng }) ? 15 : (CHEFS_LIEUX[dept] ? 11 : 6);
      if (!picker) {
        picker = L.map(mapEl);
        FONDS.osm().addTo(picker);
        L.control.layers({ "Plan": FONDS.osm(), "Satellite": FONDS.sat() }).addTo(picker);
        picker.on("click", e => {
          pickerPos = e.latlng;
          if (pickerMarker) pickerMarker.setLatLng(e.latlng); else pickerMarker = L.marker(e.latlng, { draggable: true }).addTo(picker).on("dragend", ev => { pickerPos = ev.target.getLatLng(); majCoord(); });
          majCoord();
        });
      }
      const majCoord = () => { coordEl.textContent = pickerPos ? `Lat ${pickerPos.lat.toFixed(6)}, Lng ${pickerPos.lng.toFixed(6)}` : "Aucune position choisie"; };
      this._majCoord = majCoord;
      picker.setView(init, zoom);
      if (pickerMarker) { picker.removeLayer(pickerMarker); pickerMarker = null; }
      pickerPos = null;
      if (valide({ lat, lng })) { pickerPos = L.latLng(+lat, +lng); pickerMarker = L.marker(pickerPos, { draggable: true }).addTo(picker).on("dragend", ev => { pickerPos = ev.target.getLatLng(); majCoord(); }); }
      majCoord();
      setTimeout(() => picker.invalidateSize(), 80);
    },
    validerPicker(modalEl) {
      if (!pickerPos) return false;
      pickerCb && pickerCb(pickerPos.lat, pickerPos.lng);
      modalEl.classList.remove("ouvert");
      return true;
    }
  };
})();
