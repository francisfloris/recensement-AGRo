/* =========================================================
   AgriRecensement – application principale
   ========================================================= */
const DEPARTEMENTS = ["Bouenza","Brazzaville","Congo-Oubangui","Cuvette","Cuvette-Ouest","Djoué-Léfini","Kouilou","Lékoumou","Likouala","Niari","Nkéni-Alima","Plateaux","Pointe-Noire","Pool","Sangha"];
const CULTURES = ["Manioc","Banane plantain","Arachide","Maïs","Igname","Patate douce","Taro","Haricot","Maraîchage","Riz","Cacao","Café","Palmier à huile","Canne à sucre","Arboriculture fruitière","Piment"];
const ELEVAGES = ["Volaille","Porcin","Caprin","Ovin","Bovin","Pisciculture","Apiculture","Lapins"];
const EQUIPEMENTS = ["Houe / machette","Brouette","Pulvérisateur","Motoculteur","Tracteur","Moto-pompe","Décortiqueuse","Moulin / râpe à manioc","Moyen de transport"];
const ROLES = { admin: "Administrateur", superviseur: "Superviseur", agent: "Agent recenseur" };
const PAR_PAGE = 20;
const SYNC_INTERVALLE = 120000;

const S = { session: null, config: { orgName: "", campaign: "" }, donnees: [], rev: 0, lastSync: null, syncing: false, agents: [], vue: "tableau", page: 1, selectionCartes: new Set(), installPrompt: null, timer: null };

/* ---------------- Utilitaires ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Number(n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const fdate = s => s ? new Date(s).toLocaleDateString("fr-FR") : "—";
const fdateh = s => s ? new Date(s).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "jamais";
const initiales = d => (((d.prenom || "")[0] || "") + ((d.nom || "")[0] || "")).toUpperCase();
const visibles = () => S.donnees.filter(d => !d.deleted);
const role = () => S.session?.user?.role;
const estGestion = () => ["admin", "superviseur"].includes(role());
function toast(m, ms = 2800) { const t = $("#toast"); t.textContent = m; t.classList.add("vu"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("vu"), ms); }
function age(d) { if (!d) return ""; const n = new Date(d), a = new Date(); let x = a.getFullYear() - n.getFullYear(); if (a < new Date(a.getFullYear(), n.getMonth(), n.getDate())) x--; return x; }
function newUid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12)); }
function depuis(iso) {
  if (!iso) return "jamais";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "à l'instant"; if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`; return `il y a ${Math.floor(s / 86400)} j`;
}
function avatar(d) { return d.photo ? `<img class="avatar" src="${d.photo}" alt="">` : `<span class="avatar">${esc(initiales(d))}</span>`; }
function remplirSelect(el, items, defaut) { el.innerHTML = (defaut ? `<option value="">${defaut}</option>` : "") + items.map(i => Array.isArray(i) ? `<option value="${esc(i[0])}">${esc(i[1])}</option>` : `<option>${esc(i)}</option>`).join(""); }

/* ---------------- Code agriculteur unique (fonctionne hors ligne) ---------------- */
async function nouveauCode() {
  const ac = S.session.user.agentCode, prefixe = `AGR-${ac}-`;
  const maxLocal = S.donnees.filter(d => (d.code || "").startsWith(prefixe)).reduce((m, d) => Math.max(m, parseInt(d.code.slice(-5)) || 0), 0);
  const compteur = (await Store.getMeta("compteur")) || 0;
  const n = Math.max(maxLocal, compteur) + 1;
  await Store.setMeta("compteur", n);
  return prefixe + String(n).padStart(5, "0");
}

/* =========================================================
   DÉMARRAGE & SESSION
   ========================================================= */
async function boot() {
  enregistrerSW();
  preparerFormulaire();
  S.config = (await Store.getMeta("config")) || S.config;
  afficherConfig();
  chargerConfig();
  S.session = await Store.getMeta("session");
  if (!S.session) return montrerEcran("login");
  Api.token = S.session.token;
  if (S.session.user.mustChange) return montrerEcran("mdp");
  entrerApp();
}

function montrerEcran(nom) {
  $("#ecranLogin").hidden = nom !== "login";
  $("#ecranMdp").hidden = nom !== "mdp";
  $("#app").hidden = nom !== "app";
}

async function chargerConfig() {
  try { S.config = await Api.call("GET", "/api/config"); await Store.setMeta("config", S.config); afficherConfig(); } catch {}
}
function afficherConfig() {
  $$("[data-org]").forEach(e => e.textContent = S.config.orgName || "");
  $$("[data-campagne]").forEach(e => e.textContent = S.config.campaign || "");
}

$("#formLogin").onsubmit = async e => {
  e.preventDefault();
  const f = e.target, err = $("#erreurLogin"), btn = f.querySelector("button");
  err.textContent = ""; btn.disabled = true; btn.textContent = "Connexion…";
  try {
    const r = await Api.call("POST", "/api/login", { username: f.username.value.trim(), password: f.password.value });
    const ancien = await Store.getMeta("ownerId");
    if (ancien !== r.user.id) { await Store.clearFarmers(); await Store.delMeta("rev", "lastSync", "compteur"); }
    await Store.setMeta("ownerId", r.user.id);
    await Store.setMeta("compteur", Math.max(r.lastSeq || 0, (await Store.getMeta("compteur")) || 0));
    S.session = { token: r.token, user: r.user };
    await Store.setMeta("session", S.session);
    Api.token = r.token;
    f.reset();
    if (r.user.mustChange) return montrerEcran("mdp");
    entrerApp();
  } catch (ex) {
    err.textContent = ex.reseau ? "Impossible de joindre le serveur. Vérifiez votre connexion Internet." : ex.message;
  } finally { btn.disabled = false; btn.textContent = "Se connecter"; }
};

$("#formMdpForce").onsubmit = async e => {
  e.preventDefault();
  const f = e.target, err = $("#erreurMdpForce");
  if (f.next.value !== f.confirm.value) return err.textContent = "Les deux mots de passe ne correspondent pas.";
  try {
    const r = await Api.call("POST", "/api/me/password", { current: f.current.value, next: f.next.value });
    S.session = { token: r.token, user: r.user }; Api.token = r.token;
    await Store.setMeta("session", S.session);
    f.reset(); toast("✅ Mot de passe modifié"); entrerApp();
  } catch (ex) { err.textContent = ex.message; }
};

async function entrerApp() {
  montrerEcran("app");
  Store.demanderPersistance();
  S.donnees = await Store.all();
  S.rev = (await Store.getMeta("rev")) || 0;
  S.lastSync = await Store.getMeta("lastSync");
  const u = S.session.user;
  $("#nomUtilisateur").textContent = `${u.name} · ${u.agentCode}`;
  $$("[data-role]").forEach(el => el.hidden = !el.dataset.role.split(" ").includes(u.role));
  remplirFiltresAgents();
  const h = location.hash.slice(1);
  afficher($("#vue-" + h) ? h : "tableau");
  majPastille();
  await synchroniser();
  verifierSession();
  clearInterval(S.timer); S.timer = setInterval(() => synchroniser(), SYNC_INTERVALLE);
}

async function verifierSession() {
  try {
    const r = await Api.call("GET", "/api/me");
    S.session.user = r.user; await Store.setMeta("session", S.session);
    const c = (await Store.getMeta("compteur")) || 0;
    if (r.lastSeq > c) await Store.setMeta("compteur", r.lastSeq);
  } catch (e) { if (e.status === 401) sessionExpiree(e.message); }
}

async function sessionExpiree(msg) {
  clearInterval(S.timer);
  await Store.delMeta("session");
  S.session = null; Api.token = null;
  montrerEcran("login");
  $("#erreurLogin").textContent = (msg || "Session expirée.") + " Vos fiches non envoyées sont conservées : reconnectez-vous pour les synchroniser.";
}

async function deconnexion() {
  let enAttente = S.donnees.filter(d => d._dirty).length;
  if (enAttente && navigator.onLine) { await synchroniser({ manuel: true }); enAttente = S.donnees.filter(d => d._dirty).length; }
  if (enAttente && !confirm(`⚠️ ${enAttente} fiche(s) n'ont pas pu être envoyées au serveur et seront DÉFINITIVEMENT PERDUES.\n\nConnectez-vous à Internet et synchronisez d'abord.\n\nSe déconnecter quand même ?`)) return;
  if (!enAttente && !confirm("Se déconnecter ? Les données de cet appareil seront effacées (elles restent sur le serveur).")) return;
  await Store.clearFarmers();
  await Store.delMeta("session", "rev", "lastSync", "ownerId", "compteur");
  location.hash = ""; location.reload();
}
$("#btnLogout").onclick = deconnexion;

/* =========================================================
   SYNCHRONISATION
   ========================================================= */
async function synchroniser({ manuel = false } = {}) {
  if (S.syncing || !S.session) return;
  if (!navigator.onLine) { majPastille(); if (manuel) toast("📴 Hors ligne : les fiches seront envoyées dès le retour du réseau."); return; }
  S.syncing = true; majPastille();
  let envoyees = 0, rejetees = 0;
  try {
    const aEnvoyer = S.donnees.filter(d => d._dirty);
    do {
      const lot = aEnvoyer.splice(0, 40).map(d => { const c = { ...d }; delete c._dirty; delete c._erreur; return c; });
      const r = await Api.call("POST", "/api/sync", { changes: lot, since: S.rev });
      const res = await appliquerReponse(r, lot);
      envoyees += res.ok; rejetees += res.ko;
    } while (aEnvoyer.length);
    S.lastSync = new Date().toISOString();
    await Store.setMeta("lastSync", S.lastSync);
    if (manuel) toast(rejetees ? `⚠️ ${envoyees} fiche(s) envoyée(s), ${rejetees} refusée(s) – voir la liste` : `✅ Synchronisé${envoyees ? ` : ${envoyees} fiche(s) envoyée(s)` : ""}`);
  } catch (e) {
    if (e.status === 401) { S.syncing = false; return sessionExpiree(e.message); }
    if (manuel) toast("❌ Échec de la synchronisation : " + e.message);
  } finally {
    S.syncing = false; majPastille(); rafraichir();
  }
}

async function appliquerReponse(r, lot) {
  const parUid = new Map(S.donnees.map(d => [d.uid, d]));
  const envoye = new Map(lot.map(d => [d.uid, d.updatedAt]));
  const aEcrire = [];
  let ok = 0, ko = 0;
  for (const uid of r.accepted) {
    const d = parUid.get(uid);
    if (d && d.updatedAt === envoye.get(uid)) { d._dirty = false; delete d._erreur; aEcrire.push(d); ok++; }
  }
  for (const rej of r.rejected) {
    const d = parUid.get(rej.uid); if (!d) continue;
    if (/existe déjà/.test(rej.reason) && !d.cartImprimee) { d.code = await nouveauCode(); d.updatedAt = new Date().toISOString(); delete d._erreur; }
    else { d._erreur = rej.reason; ko++; }
    aEcrire.push(d);
  }
  for (const srv of r.records) {
    const loc = parUid.get(srv.uid);
    if (loc && loc._dirty && loc.updatedAt > srv.updatedAt) continue;
    const rec = { ...srv, _dirty: false };
    parUid.set(srv.uid, rec); aEcrire.push(rec);
  }
  S.donnees = [...parUid.values()];
  await Store.putMany(aEcrire);
  const purge = S.donnees.filter(d => d.deleted && !d._dirty).map(d => d.uid);
  if (purge.length) { await Store.delMany(purge); S.donnees = S.donnees.filter(d => !(d.deleted && !d._dirty)); }
  S.rev = r.rev; await Store.setMeta("rev", S.rev);
  return { ok, ko };
}

function majPastille() {
  const p = $("#pastilleSync"), t = $("#texteSync");
  const n = S.donnees.filter(d => d._dirty).length;
  p.className = "pastille-sync";
  if (S.syncing) { p.classList.add("encours", "attente"); t.textContent = "Synchronisation…"; }
  else if (!navigator.onLine) { p.classList.add("hors-ligne"); t.textContent = "Hors ligne" + (n ? ` · ${n} en attente` : ""); }
  else if (n) { p.classList.add("attente"); t.textContent = `${n} en attente`; }
  else { p.classList.add("en-ligne"); t.textContent = "Synchronisé"; }
  if (S.vue === "sync") rendreSync();
}
$("#pastilleSync").onclick = () => synchroniser({ manuel: true });
window.addEventListener("online", () => { majPastille(); toast("📶 Connexion rétablie – synchronisation…"); synchroniser(); });
window.addEventListener("offline", () => { majPastille(); toast("📴 Mode hors ligne : vous pouvez continuer à recenser."); });

/* =========================================================
   NAVIGATION
   ========================================================= */
function afficher(vue) {
  S.vue = vue;
  $$("#nav button").forEach(b => b.classList.toggle("actif", b.dataset.vue === vue));
  $$(".vue").forEach(v => v.classList.toggle("actif", v.id === "vue-" + vue));
  history.replaceState(null, "", "#" + vue);
  rafraichir();
  window.scrollTo(0, 0);
}
function rafraichir() {
  ({ tableau: rendreTableau, liste: rendreListe, carte: rendreCarte, cartes: rendreCartes, sync: rendreSync, agents: rendreAgents, compte: rendreCompte }[S.vue] || (() => {}))();
}
$$("#nav button").forEach(b => b.onclick = () => { if (b.dataset.vue === "formulaire") resetForm(); afficher(b.dataset.vue); });

/* =========================================================
   FORMULAIRE
   ========================================================= */
const form = $("#form");
let photoData = "";

function preparerFormulaire() {
  remplirSelect($("#selDept"), DEPARTEMENTS, "— Choisir —");
  for (const id of ["#fDept", "#mDept", "#cDept"]) remplirSelect($(id), DEPARTEMENTS, "Tous les départements");
  for (const id of ["#fCulture", "#mCulture"]) remplirSelect($(id), CULTURES, "Toutes cultures");
  const cases = (id, nom, items) => $(id).innerHTML = items.map(i => `<label><input type="checkbox" name="${nom}" value="${esc(i)}"> ${esc(i)}</label>`).join("");
  cases("#casesCultures", "cultures", CULTURES); cases("#casesElevage", "elevage", ELEVAGES); cases("#casesEquip", "equipements", EQUIPEMENTS);
}
function remplirFiltresAgents() {
  const agents = [...new Map(S.donnees.filter(d => d.agentId).map(d => [d.agentId, d.agentName || "Agent " + d.agentId])).entries()];
  for (const id of ["#fAgent", "#cAgent"]) { const v = $(id).value; remplirSelect($(id), agents.map(([i, n]) => [i, n]), "Tous les agents"); $(id).value = v; }
}

$("#photoInput").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    const img = new Image();
    img.onload = () => {
      // recadrage portrait 4:5 pour la carte, 300 px de haut
      const c = document.createElement("canvas"), ratio = 0.8;
      let sw = img.width, sh = img.height, sx = 0, sy = 0;
      if (sw / sh > ratio) { sw = sh * ratio; sx = (img.width - sw) / 2; } else { sh = sw / ratio; sy = (img.height - sh) / 2; }
      c.width = 240; c.height = 300;
      c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, 240, 300);
      photoData = c.toDataURL("image/jpeg", 0.78); majPhoto();
    };
    img.src = ev.target.result;
  };
  r.readAsDataURL(f);
};
function majPhoto() { $("#apercuPhoto").src = photoData || ""; $("#apercuPhoto").hidden = !photoData; $("#suppPhoto").hidden = !photoData; }
$("#suppPhoto").onclick = () => { photoData = ""; $("#photoInput").value = ""; majPhoto(); };

function dansLeCongo(lat, lng) { return lat >= -5.2 && lat <= 3.8 && lng >= 11 && lng <= 18.8; }
$("#btnGPS").onclick = () => {
  if (!navigator.geolocation) return toast("Géolocalisation non disponible sur cet appareil");
  $("#infoGPS").textContent = "⏳ Recherche du signal GPS… (restez à l'extérieur, loin des arbres si possible)";
  navigator.geolocation.getCurrentPosition(
    p => {
      form.lat.value = p.coords.latitude.toFixed(6); form.lng.value = p.coords.longitude.toFixed(6);
      const prec = Math.round(p.coords.accuracy);
      $("#infoGPS").textContent = `✅ Position capturée – précision ±${prec} m` + (prec > 50 ? " (faible : réessayez à découvert)" : "") + (dansLeCongo(p.coords.latitude, p.coords.longitude) ? "" : " ⚠️ position hors du Congo");
    },
    err => { $("#infoGPS").textContent = "❌ Position introuvable (" + (err.code === 1 ? "autorisation refusée" : "signal insuffisant") + "). Utilisez « Choisir sur la carte »."; },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
};
$("#btnChoisirCarte").onclick = () => Carto.ouvrirPicker($("#modalCarte"), $("#cartePicker"), $("#coordPicker"),
  { lat: form.lat.value, lng: form.lng.value, dept: form.departement.value },
  (lat, lng) => { form.lat.value = lat.toFixed(6); form.lng.value = lng.toFixed(6); $("#infoGPS").textContent = "📍 Position choisie sur la carte"; });
$("#validerPicker").onclick = () => { if (!Carto.validerPicker($("#modalCarte"))) toast("Touchez la carte pour placer l'exploitation"); };
$("#fermerPicker").onclick = () => $("#modalCarte").classList.remove("ouvert");

function resetForm() {
  form.reset(); form.uid.value = ""; photoData = ""; majPhoto();
  $$(".invalide").forEach(e => e.classList.remove("invalide"));
  $("#infoGPS").textContent = ""; $("#titreForm").textContent = "Nouvel agriculteur";
}
$("#btnAnnuler").onclick = () => { resetForm(); afficher("liste"); };

function valider() {
  $$(".invalide").forEach(e => e.classList.remove("invalide"));
  const manquants = [...form.querySelectorAll("[required]")].filter(el => !el.value.trim());
  manquants.forEach(el => el.classList.add("invalide"));
  if (manquants.length) { manquants[0].focus(); toast("Veuillez remplir les champs obligatoires (*)"); return false; }
  const tel = form.telephone.value.replace(/[\s.-]/g, "");
  if (!/^(\+?242)?0?[456]\d{7}$/.test(tel)) { form.telephone.classList.add("invalide"); form.telephone.focus(); toast("Numéro invalide (ex. 06 123 45 67)"); return false; }
  const a = age(form.naissance.value);
  if (a < 10 || a > 110) { form.naissance.classList.add("invalide"); toast("Date de naissance incohérente"); return false; }
  const sc = parseFloat(form.superficieCultivee.value), st = parseFloat(form.superficie.value);
  if (!isNaN(sc) && sc > st) { form.superficieCultivee.classList.add("invalide"); toast("La superficie cultivée dépasse la superficie totale"); return false; }
  if (!form.querySelector("[name=cultures]:checked")) { $("#casesCultures").classList.add("invalide"); toast("Sélectionnez au moins une culture"); return false; }
  if ((form.lat.value || form.lng.value) && !dansLeCongo(+form.lat.value, +form.lng.value) && !confirm("Les coordonnées GPS semblent hors du Congo. Continuer ?")) return false;
  return true;
}

form.onsubmit = async e => {
  e.preventDefault();
  if (!valider()) return;
  const o = {};
  for (const [k, v] of new FormData(form).entries()) {
    if (["cultures", "elevage", "equipements"].includes(k)) (o[k] = o[k] || []).push(v); else o[k] = typeof v === "string" ? v.trim() : v;
  }
  ["cultures", "elevage", "equipements"].forEach(k => o[k] = o[k] || []);
  o.photo = photoData;
  const tel = o.telephone.replace(/\s/g, "");
  const dbl = visibles().find(d => d.telephone.replace(/\s/g, "") === tel && d.uid !== o.uid);
  if (dbl && !confirm(`Le numéro ${o.telephone} est déjà utilisé par ${dbl.prenom} ${dbl.nom} (${dbl.code}).\nEnregistrer quand même ?`)) return;

  const maintenant = new Date().toISOString();
  let rec;
  if (o.uid) {
    const ex = S.donnees.find(d => d.uid === o.uid);
    rec = { ...ex, ...o, updatedAt: maintenant, _dirty: true };
  } else {
    const u = S.session.user;
    rec = { ...o, uid: newUid(), code: await nouveauCode(), agentId: u.id, agentName: u.name, dateCreation: maintenant, updatedAt: maintenant, _dirty: true };
  }
  delete rec._erreur;
  try { await Store.put(rec); } catch (err) { return toast("❌ Enregistrement impossible : " + err.message); }
  const i = S.donnees.findIndex(d => d.uid === rec.uid);
  if (i >= 0) S.donnees[i] = rec; else S.donnees.push(rec);
  toast(o.uid ? "✅ Fiche mise à jour" : `✅ Agriculteur enregistré : ${rec.code}`);
  remplirFiltresAgents(); resetForm(); majPastille(); afficher("liste");
  synchroniser();
};

function editer(uid) {
  const d = S.donnees.find(x => x.uid === uid); if (!d) return;
  resetForm(); fermerModal();
  for (const [k, v] of Object.entries(d)) {
    if (Array.isArray(v)) form.querySelectorAll(`[name="${k}"]`).forEach(c => c.checked = v.includes(c.value));
    else if (form.elements[k] && !(form.elements[k] instanceof RadioNodeList) && form.elements[k].type !== "file") form.elements[k].value = v ?? "";
  }
  photoData = d.photo || ""; majPhoto();
  $("#titreForm").textContent = `Modifier : ${d.prenom} ${d.nom} (${d.code})`;
  afficher("formulaire");
}

async function supprimer(uid) {
  const d = S.donnees.find(x => x.uid === uid);
  if (!d || !confirm(`Supprimer définitivement ${d.prenom} ${d.nom} (${d.code}) ?\nSa carte d'agriculteur sera invalidée.`)) return;
  Object.assign(d, { deleted: true, updatedAt: new Date().toISOString(), _dirty: true });
  await Store.put(d);
  fermerModal(); toast("Fiche supprimée"); majPastille(); rafraichir(); synchroniser();
}

/* =========================================================
   TABLEAU DE BORD
   ========================================================= */
function compter(liste, fn) { const c = {}; liste.forEach(d => [].concat(fn(d)).forEach(k => { if (k) c[k] = (c[k] || 0) + 1; })); return Object.entries(c).sort((a, b) => b[1] - a[1]); }
function barres(el, entrees, max = 8, couleur) {
  if (!entrees.length) { $(el).innerHTML = `<div class="vide">Aucune donnée</div>`; return; }
  const m = Math.max(...entrees.map(e => e[1]));
  $(el).innerHTML = entrees.slice(0, max).map(([k, v]) => `<div class="barre"><span title="${esc(k)}">${esc(k)}</span><div class="piste"><div class="rempli" style="width:${v / m * 100}%;${couleur ? `background:${couleur}` : ""}"></div></div><span class="n">${v}</span></div>`).join("");
}
function rendreTableau() {
  const L = visibles(), n = L.length;
  const sup = L.reduce((s, d) => s + (parseFloat(d.superficie) || 0), 0);
  const pct = x => n ? Math.round(x / n * 100) + " %" : "—";
  $("#portee").textContent = estGestion() ? "— toutes les fiches" : "— mes fiches";
  $("#stats").innerHTML = [
    [n, "Agriculteurs recensés"], [fmt(sup) + " ha", "Superficie totale"], [n ? fmt(sup / n) + " ha" : "—", "Superficie moyenne"],
    [pct(L.filter(d => d.sexe === "Féminin").length), "Femmes"], [pct(L.filter(d => age(d.naissance) <= 35).length), "Jeunes (≤ 35 ans)"],
    [pct(L.filter(d => d.cooperative === "Oui").length), "En coopérative"], [pct(L.filter(d => Carto.valide(d)).length), "Géolocalisés"],
    [L.filter(d => d.cartImprimee).length, "Cartes imprimées"]
  ].map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  barres("#g-dept", compter(L, d => d.departement), 15);
  barres("#g-cultures", compter(L, d => d.cultures), 10, "#d99a00");
  barres("#g-sexe", compter(L, d => d.sexe), 2, "#2563eb");
  const tr = a => a < 25 ? "Moins de 25 ans" : a < 36 ? "25 – 35 ans" : a < 50 ? "36 – 49 ans" : a < 65 ? "50 – 64 ans" : "65 ans et +";
  const ordre = ["Moins de 25 ans", "25 – 35 ans", "36 – 49 ans", "50 – 64 ans", "65 ans et +"];
  barres("#g-age", compter(L, d => d.naissance ? tr(age(d.naissance)) : null).sort((a, b) => ordre.indexOf(a[0]) - ordre.indexOf(b[0])), 5, "#7c3aed");
  barres("#g-diff", compter(L, d => d.difficulte), 7, "#c0392b");
  // 14 derniers jours
  const jours = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); return d.toISOString().slice(0, 10); });
  const cj = Object.fromEntries(jours.map(j => [j, 0]));
  L.forEach(d => { const j = (d.dateCreation || "").slice(0, 10); if (j in cj) cj[j]++; });
  const mj = Math.max(1, ...Object.values(cj));
  $("#g-jours").innerHTML = `<div class="colonnes">${jours.map(j => `<div class="col" title="${fdate(j)} : ${cj[j]}"><b>${cj[j] || ""}</b><div style="height:${cj[j] / mj * 100}%"></div>${j.slice(8)}</div>`).join("")}</div>`;
  const der = [...L].sort((a, b) => (b.dateCreation || "").localeCompare(a.dateCreation || "")).slice(0, 6);
  $("#derniers").innerHTML = der.length ? der.map(d => `
    <div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--bord);cursor:pointer" onclick="voir('${d.uid}')">
      ${avatar(d)}<div style="flex:1"><b>${esc(d.prenom)} ${esc(d.nom)}</b><div class="muted petit">${esc(d.village)}, ${esc(d.departement)}</div></div>
      <span class="muted petit">${fdate(d.dateCreation)}</span></div>`).join("")
    : `<div class="vide">Aucun enregistrement.<br><br><button class="btn btn-p" onclick="resetForm();afficher('formulaire')">➕ Recenser un agriculteur</button></div>`;
  // Avancement par agent
  $("#carteAgents").hidden = !estGestion();
  if (estGestion()) chargerAgents().then(() => {
    const agents = S.agents.filter(a => a.role !== "admin" || a.count);
    const max = Math.max(1, ...agents.map(a => a.count));
    $("#tabAgents").innerHTML = agents.length ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Code</th><th>Zone</th><th style="width:40%">Fiches</th><th>Dernière synchro</th></tr></thead><tbody>${agents.map(a => `
      <tr><td>${esc(a.name)} ${a.active ? "" : '<span class="badge off">désactivé</span>'}</td><td class="code">${esc(a.agentCode)}</td><td>${esc(a.zone || "—")}</td>
      <td><div class="barre" style="grid-template-columns:1fr 40px;margin:0"><div class="piste"><div class="rempli" style="width:${a.count / max * 100}%"></div></div><span class="n">${a.count}</span></div></td>
      <td>${a.lastSync ? depuis(a.lastSync) : "jamais"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="vide">Aucun agent. Créez des comptes dans l'onglet « Agents ».</div>`;
  });
}

/* =========================================================
   LISTE
   ========================================================= */
function badgeSync(d) {
  if (d._erreur) return `<span class="badge err" title="${esc(d._erreur)}">⚠️ Refusée</span>`;
  if (d._dirty) return `<span class="badge att">⏳ En attente</span>`;
  return `<span class="badge">☁️ OK</span>`;
}
function filtrerListe() {
  const q = $("#recherche").value.toLowerCase().trim(), dp = $("#fDept").value, sx = $("#fSexe").value, cu = $("#fCulture").value, ag = $("#fAgent").value;
  return visibles().filter(d =>
    (!dp || d.departement === dp) && (!sx || d.sexe === sx) && (!cu || (d.cultures || []).includes(cu)) && (!ag || String(d.agentId) === ag) &&
    (!q || [d.code, d.nom, d.prenom, d.telephone, d.village, d.district, d.piece].join(" ").toLowerCase().includes(q))
  ).sort((a, b) => (b.dateCreation || "").localeCompare(a.dateCreation || ""));
}
function rendreListe() {
  const liste = filtrerListe(), nbP = Math.max(1, Math.ceil(liste.length / PAR_PAGE));
  if (S.page > nbP) S.page = nbP;
  const tranche = liste.slice((S.page - 1) * PAR_PAGE, S.page * PAR_PAGE), g = estGestion();
  $("#tbody").innerHTML = tranche.length ? tranche.map(d => `
    <tr>
      <td>${avatar(d)}</td><td class="code"><b>${esc(d.code)}</b></td>
      <td>${esc((d.nom || "").toUpperCase())} ${esc(d.prenom)}</td>
      <td><span class="badge ${d.sexe === "Féminin" ? "f" : ""}">${d.sexe === "Féminin" ? "F" : "M"}</span></td>
      <td>${age(d.naissance)} ans</td><td>${esc(d.telephone)}</td><td>${esc(d.departement)}</td><td>${esc(d.village)}</td>
      <td>${fmt(d.superficie)} ha</td>${g ? `<td>${esc(d.agentName || "")}</td>` : ""}<td>${badgeSync(d)}</td>
      <td><button class="btn btn-s btn-petit" onclick="voir('${d.uid}')">Voir</button> <button class="btn btn-s btn-petit" onclick="editer('${d.uid}')">✏️</button></td>
    </tr>`).join("") : `<tr><td colspan="12" class="vide">Aucun agriculteur trouvé.</td></tr>`;
  $("#pagination").innerHTML = liste.length > PAR_PAGE ? `
    <button class="btn btn-s btn-petit" ${S.page <= 1 ? "disabled" : ""} onclick="S.page--;rendreListe()">‹ Préc.</button>
    <span>Page ${S.page} / ${nbP} — ${liste.length} résultat(s)</span>
    <button class="btn btn-s btn-petit" ${S.page >= nbP ? "disabled" : ""} onclick="S.page++;rendreListe()">Suiv. ›</button>` : `<span class="muted">${liste.length} résultat(s)</span>`;
}
["#recherche", "#fDept", "#fSexe", "#fCulture", "#fAgent"].forEach(s => $(s).addEventListener("input", () => { S.page = 1; rendreListe(); }));

/* =========================================================
   FICHE DÉTAILLÉE
   ========================================================= */
function voir(uid) {
  const d = S.donnees.find(x => x.uid === uid); if (!d) return;
  const ch = (l, v) => `<div><span>${l}</span>${esc(Array.isArray(v) ? (v.join(", ") || "—") : (v || "—"))}</div>`;
  $("#modalContenu").innerHTML = `
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:16px">
      ${d.photo ? `<img src="${d.photo}" style="width:80px;height:100px;border-radius:12px;object-fit:cover">` : `<span class="avatar" style="width:70px;height:70px;font-size:24px">${esc(initiales(d))}</span>`}
      <div><h2 style="margin:0">${esc((d.nom || "").toUpperCase())} ${esc(d.prenom)}</h2><span class="badge code">${esc(d.code)}</span> ${badgeSync(d)}
      <div class="muted petit" style="margin-top:4px">Recensé le ${fdate(d.dateCreation)} par ${esc(d.agentName || "—")}${d.cartImprimee ? ` · Carte imprimée le ${fdate(d.cartImprimee)}` : ""}</div>
      ${d._erreur ? `<div class="petit" style="color:var(--rouge)">Refusée par le serveur : ${esc(d._erreur)}</div>` : ""}</div>
    </div>
    <h3>Identité</h3><div class="fiche">
      ${ch("Sexe", d.sexe)}${ch("Date de naissance", d.naissance ? fdate(d.naissance) + ` (${age(d.naissance)} ans)` : "")}${ch("Téléphone", d.telephone)}
      ${ch("Pièce d'identité", d.piece)}${ch("Situation matrimoniale", d.matrimonial)}${ch("Personnes à charge", d.charges)}${ch("Instruction", d.instruction)}
    </div><br>
    <h3>Localisation</h3><div class="fiche">
      ${ch("Département", d.departement)}${ch("District", d.district)}${ch("Village / quartier", d.village)}${ch("Coordonnées GPS", Carto.valide(d) ? `${d.lat}, ${d.lng}` : "")}
    </div><br>
    <h3>Exploitation</h3><div class="fiche">
      ${ch("Superficie totale", d.superficie ? fmt(d.superficie) + " ha" : "")}${ch("Superficie cultivée", d.superficieCultivee ? fmt(d.superficieCultivee) + " ha" : "")}
      ${ch("Statut foncier", d.foncier)}${ch("Expérience", d.experience ? d.experience + " ans" : "")}${ch("Type d'activité", d.activite)}${ch("Main-d'œuvre", d.mainOeuvre)}
      ${ch("Source d'eau", d.eau)}${ch("Destination", d.destination)}${ch("Cultures", d.cultures)}${ch("Élevage", d.elevage)}${ch("Équipements", d.equipements)}
    </div><br>
    <h3>Organisation</h3><div class="fiche">
      ${ch("Coopérative", d.cooperative === "Oui" ? "Oui – " + (d.nomCooperative || "") : d.cooperative)}${ch("Accès au crédit", d.credit)}${ch("Encadrement technique", d.encadrement)}${ch("Difficulté principale", d.difficulte)}
    </div>
    ${d.observations ? `<br><h3>Observations</h3><p>${esc(d.observations)}</p>` : ""}
    <div class="actions no-print" style="margin-top:20px">
      <button class="btn btn-s" onclick="window.print()">🖨 Imprimer la fiche</button>
      <button class="btn btn-s" onclick="carteUnique('${d.uid}')">🪪 Carte PDF</button>
      ${Carto.valide(d) ? `<button class="btn btn-s" onclick="voirSurCarte('${d.uid}')">🗺️ Sur la carte</button>` : ""}
      <button class="btn btn-s" onclick="editer('${d.uid}')">✏️ Modifier</button>
      <button class="btn btn-d" onclick="supprimer('${d.uid}')">Supprimer</button>
      <button class="btn btn-p" onclick="fermerModal()">Fermer</button>
    </div>`;
  $("#modal").classList.add("ouvert");
}
function fermerModal() { $("#modal").classList.remove("ouvert"); }
$("#modal").onclick = e => { if (e.target.id === "modal") fermerModal(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") { fermerModal(); $("#modalCarte").classList.remove("ouvert"); } });
function voirSurCarte(uid) { const d = S.donnees.find(x => x.uid === uid); fermerModal(); afficher("carte"); setTimeout(() => Carto.centrerSur(+d.lat, +d.lng), 150); }

/* =========================================================
   CARTE
   ========================================================= */
function rendreCarte() {
  const dp = $("#mDept").value, cu = $("#mCulture").value;
  const L = visibles().filter(d => (!dp || d.departement === dp) && (!cu || (d.cultures || []).includes(cu)));
  Carto.afficherGrande($("#carteGrande"), L, {
    couleur: $("#mCouleur").value, fond: $("#mFond").value, legendeEl: $("#legende"), infoEl: $("#carteInfo"),
    popup: d => `<div style="display:flex;gap:8px;align-items:center">${avatar(d)}<div><b>${esc(d.prenom)} ${esc((d.nom || "").toUpperCase())}</b><br><span class="code">${esc(d.code)}</span></div></div>
      <div style="margin-top:6px">${esc(d.village)}, ${esc(d.departement)}<br>${fmt(d.superficie)} ha · ${esc((d.cultures || []).slice(0, 3).join(", "))}</div>
      <button class="btn btn-p btn-petit" style="margin-top:6px" onclick="voir('${d.uid}')">Voir la fiche</button>`
  });
}
["#mDept", "#mCulture", "#mCouleur", "#mFond"].forEach(s => $(s).addEventListener("change", rendreCarte));

/* =========================================================
   CARTES D'AGRICULTEUR (PDF)
   ========================================================= */
function filtrerCartes() {
  const dp = $("#cDept").value, st = $("#cStatut").value, ag = $("#cAgent").value, q = $("#cRecherche").value.toLowerCase().trim();
  return visibles().filter(d => (!dp || d.departement === dp) && (!ag || String(d.agentId) === ag) &&
    (st === "" || (st === "oui" ? !!d.cartImprimee : !d.cartImprimee)) &&
    (!q || [d.code, d.nom, d.prenom, d.village].join(" ").toLowerCase().includes(q))
  ).sort((a, b) => (a.code || "").localeCompare(b.code || ""));
}
function rendreCartes() {
  const L = filtrerCartes();
  const uids = new Set(L.map(d => d.uid));
  [...S.selectionCartes].forEach(u => { if (!uids.has(u)) S.selectionCartes.delete(u); });
  $("#cListe").innerHTML = L.length ? L.map(d => `
    <label><input type="checkbox" value="${d.uid}" ${S.selectionCartes.has(d.uid) ? "checked" : ""}>${avatar(d)}
    <div style="flex:1"><b>${esc((d.nom || "").toUpperCase())} ${esc(d.prenom)}</b><div class="muted petit">${esc(d.code)} · ${esc(d.village)}</div></div>
    ${d.cartImprimee ? `<span class="badge">imprimée ${fdate(d.cartImprimee)}</span>` : ""}${d.photo ? "" : '<span class="badge off">sans photo</span>'}</label>`).join("")
    : `<div class="vide">Aucun agriculteur pour ces critères.</div>`;
  $$("#cListe input").forEach(c => c.onchange = () => { c.checked ? S.selectionCartes.add(c.value) : S.selectionCartes.delete(c.value); majSelectionCartes(); });
  majSelectionCartes();
}
function majSelectionCartes() {
  const n = S.selectionCartes.size, total = filtrerCartes().length;
  $("#cCompte").textContent = `${n} sélectionnée(s) · ${Math.ceil(n / 10)} page(s) A4`;
  $("#cTout").checked = n > 0 && n === total;
  $("#btnPDF").disabled = !n;
  const premier = S.donnees.find(d => S.selectionCartes.has(d.uid)) || visibles()[0] || {
    code: "AGR-A001-00001", nom: "Exemple", prenom: "Marie", sexe: "Féminin", naissance: "1985-06-12", village: "Hinda", departement: "Kouilou", superficie: "2.5", cultures: ["Manioc", "Arachide", "Maïs"]
  };
  Cartes.apercu($("#apercuCarte"), premier, S.config);
}
$("#cTout").onchange = e => { filtrerCartes().forEach(d => e.target.checked ? S.selectionCartes.add(d.uid) : S.selectionCartes.delete(d.uid)); rendreCartes(); };
["#cDept", "#cStatut", "#cAgent", "#cRecherche"].forEach(s => $(s).addEventListener("input", rendreCartes));

async function marquerImprimees(recs) {
  const t = new Date().toISOString();
  recs.forEach(d => Object.assign(d, { cartImprimee: t, updatedAt: t, _dirty: true }));
  await Store.putMany(recs); majPastille(); synchroniser();
}
$("#btnPDF").onclick = async () => {
  const recs = S.donnees.filter(d => S.selectionCartes.has(d.uid)).sort((a, b) => a.code.localeCompare(b.code));
  if (!recs.length) return;
  const btn = $("#btnPDF"); btn.disabled = true; btn.textContent = "Génération…";
  await new Promise(r => setTimeout(r, 30));
  try {
    const nom = Cartes.pdf(recs, S.config, { verso: $("#cVerso").checked });
    await marquerImprimees(recs);
    S.selectionCartes.clear();
    toast(`✅ ${nom} téléchargé (${recs.length} carte(s))`);
  } catch (e) { toast("❌ Erreur PDF : " + e.message); console.error(e); }
  btn.textContent = "🖨️ Générer le PDF"; rendreCartes();
};
async function carteUnique(uid) {
  const d = S.donnees.find(x => x.uid === uid);
  try { Cartes.pdf([d], S.config, { verso: true }); await marquerImprimees([d]); toast("✅ Carte PDF téléchargée"); } catch (e) { toast("❌ " + e.message); }
}

/* =========================================================
   SYNCHRO & DONNÉES
   ========================================================= */
async function rendreSync() {
  const n = S.donnees.filter(d => d._dirty).length, err = S.donnees.filter(d => d._erreur).length;
  const esp = await Store.espace();
  $("#etatSync").innerHTML = `
    <div><b>${navigator.onLine ? "🟢 En ligne" : "🔴 Hors ligne"}</b><span>Réseau</span></div>
    <div><b>${depuis(S.lastSync)}</b><span>Dernière synchronisation</span></div>
    <div><b>${visibles().length}</b><span>Fiches sur l'appareil</span></div>
    <div><b style="color:${n ? "#b45309" : ""}">${n}</b><span>En attente d'envoi${err ? ` (dont ${err} refusée(s))` : ""}</span></div>
    ${esp ? `<div style="grid-column:1/-1"><b>${(esp.usage / 1048576).toFixed(1)} Mo</b><span>Espace utilisé sur ${(esp.quota / 1073741824).toFixed(1)} Go disponibles</span></div>` : ""}`;
  $("#btnSync").disabled = S.syncing;
  majInstall();
}
$("#btnSync").onclick = () => synchroniser({ manuel: true });

function telecharger(nom, contenu, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([contenu], { type })); a.download = nom; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
const dateFichier = () => new Date().toISOString().slice(0, 10);
$("#expCSV").onclick = () => {
  const L = visibles(); if (!L.length) return toast("Aucune donnée à exporter");
  const cols = [["code", "Code"], ["nom", "Nom"], ["prenom", "Prénom"], ["sexe", "Sexe"], ["naissance", "Date naissance"], ["age", "Âge"], ["piece", "Pièce identité"], ["telephone", "Téléphone"], ["matrimonial", "Situation matrimoniale"], ["charges", "Personnes à charge"], ["instruction", "Instruction"], ["departement", "Département"], ["district", "District"], ["village", "Village"], ["lat", "Latitude"], ["lng", "Longitude"], ["superficie", "Superficie (ha)"], ["superficieCultivee", "Superficie cultivée (ha)"], ["foncier", "Statut foncier"], ["experience", "Expérience (ans)"], ["activite", "Activité"], ["mainOeuvre", "Main-d'œuvre"], ["eau", "Source d'eau"], ["destination", "Destination"], ["cultures", "Cultures"], ["elevage", "Élevage"], ["equipements", "Équipements"], ["cooperative", "Coopérative"], ["nomCooperative", "Nom coopérative"], ["credit", "Crédit"], ["encadrement", "Encadrement"], ["difficulte", "Difficulté"], ["agentName", "Agent recenseur"], ["observations", "Observations"], ["dateCreation", "Date recensement"], ["cartImprimee", "Carte imprimée le"]];
  const cel = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lignes = [cols.map(c => cel(c[1])).join(";")].concat(L.map(d => cols.map(([k]) => { let v = k === "age" ? age(d.naissance) : d[k]; if (Array.isArray(v)) v = v.join(", "); return cel(v); }).join(";")));
  telecharger(`recensement_agriculteurs_${dateFichier()}.csv`, "\uFEFF" + lignes.join("\r\n"), "text/csv;charset=utf-8");
  toast("Export CSV téléchargé");
};
$("#expJSON").onclick = () => {
  const L = visibles(); if (!L.length) return toast("Aucune donnée à exporter");
  telecharger(`sauvegarde_recensement_${S.session.user.agentCode}_${dateFichier()}.json`, JSON.stringify(L.map(d => { const c = { ...d }; delete c._erreur; delete c._rev; return c; })), "application/json");
  toast("Sauvegarde téléchargée");
};
$("#impJSON").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = async ev => {
    try {
      const imp = JSON.parse(ev.target.result); if (!Array.isArray(imp)) throw new Error();
      let aj = 0, maj = 0; const aEcrire = [];
      for (const o of imp) {
        if (!o || !o.nom) continue;
        if (!o.uid) { // fichier de la 1re version de l'application
          Object.assign(o, { uid: newUid(), ancienId: o.id, code: await nouveauCode(), agentId: S.session.user.id, agentName: S.session.user.name, dateCreation: o.dateCreation || new Date().toISOString() });
          delete o.id;
        }
        o.updatedAt = o.updatedAt || new Date().toISOString();
        const ex = S.donnees.find(d => d.uid === o.uid);
        if (ex && ex.updatedAt >= o.updatedAt) continue;
        const rec = { ...o, _dirty: true }; delete rec._erreur;
        if (ex) { Object.assign(ex, rec); aEcrire.push(ex); maj++; } else { S.donnees.push(rec); aEcrire.push(rec); aj++; }
      }
      await Store.putMany(aEcrire);
      toast(`Import : ${aj} ajoutée(s), ${maj} mise(s) à jour`); remplirFiltresAgents(); majPastille(); synchroniser();
    } catch { toast("❌ Fichier invalide"); }
    e.target.value = "";
  };
  r.readAsText(f);
};

$("#btnDemo").onclick = async () => {
  if (!confirm("Ajouter 40 agriculteurs FICTIFS ? Ils seront envoyés au serveur central.")) return;
  const noms = ["Mabiala", "Nkounkou", "Moukoko", "Loubaki", "Massamba", "Ngoma", "Bouanga", "Mavoungou", "Tchibinda", "Okemba", "Ibara", "Ondongo", "Malonga", "Batchi", "Mpika", "Kimbembe"];
  const pH = ["Jean", "Pierre", "Alain", "Serge", "Gildas", "Rodrigue", "Brice", "Fulbert", "Armel", "Christ"], pF = ["Marie", "Grâce", "Clarisse", "Mireille", "Prisca", "Bénédicte", "Nadège", "Chantal", "Josiane", "Ornella"];
  const lieux = { "Kouilou": [["Hinda", -4.65, 12.03], ["Loango", -4.65, 11.80], ["Madingo-Kayes", -4.16, 11.37]], "Pointe-Noire": [["Tchiamba-Nzassi", -4.95, 11.98], ["Mongo-Mpoukou", -4.75, 11.90]], "Niari": [["Dolisie", -4.20, 12.67], ["Kibangou", -3.46, 12.30], ["Louvakou", -4.15, 12.55]], "Bouenza": [["Nkayi", -4.18, 13.29], ["Madingou", -4.15, 13.55], ["Loudima", -4.11, 13.06]], "Pool": [["Kinkala", -4.36, 14.76], ["Mindouli", -4.27, 14.35], ["Boko", -4.77, 14.64]], "Plateaux": [["Djambala", -2.54, 14.75], ["Lékana", -2.32, 14.60]], "Lékoumou": [["Sibiti", -3.68, 13.35], ["Zanaga", -2.85, 13.83]], "Cuvette": [["Owando", -0.48, 15.90], ["Oyo", -1.17, 15.97]], "Sangha": [["Ouesso", 1.61, 16.05], ["Pokola", 1.40, 16.32]] };
  const r = a => a[Math.floor(Math.random() * a.length)], ri = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a, sous = (a, n) => [...a].sort(() => Math.random() - .5).slice(0, n);
  const u = S.session.user, recs = [];
  for (let i = 0; i < 40; i++) {
    const sexe = Math.random() < .45 ? "Féminin" : "Masculin", dp = r(Object.keys(lieux)), [vil, la, lo] = r(lieux[dp]);
    const sup = +(Math.random() * 8 + 0.25).toFixed(2), date = new Date(Date.now() - ri(0, 13) * 864e5 - ri(0, 8e6)).toISOString(), coop = Math.random() < .4 ? "Oui" : "Non";
    recs.push({
      uid: newUid(), code: await nouveauCode(), agentId: u.id, agentName: u.name, nom: r(noms), prenom: r(sexe === "Féminin" ? pF : pH), sexe,
      naissance: `${ri(1955, 2004)}-${String(ri(1, 12)).padStart(2, "0")}-${String(ri(1, 28)).padStart(2, "0")}`, piece: "",
      telephone: `0${r(["5", "6"])} ${ri(100, 999)} ${ri(10, 99)} ${ri(10, 99)}`, matrimonial: r(["Marié(e)", "Célibataire", "Union libre", "Veuf(ve)"]), charges: String(ri(0, 9)),
      instruction: r(["Aucun", "Primaire", "Secondaire", "Supérieur"]), departement: dp, district: vil, village: vil,
      lat: (la + (Math.random() - .5) * 0.12).toFixed(6), lng: (lo + (Math.random() - .5) * 0.12).toFixed(6),
      superficie: String(sup), superficieCultivee: String(+(sup * (.4 + Math.random() * .6)).toFixed(2)), foncier: r(["Propriété coutumière", "Location", "Propriétaire (titre foncier)", "Prêt / don"]),
      experience: String(ri(1, 35)), activite: r(["Activité principale", "Activité secondaire"]), mainOeuvre: String(ri(1, 8)), eau: r(["Pluie uniquement", "Rivière / marigot", "Puits / forage"]),
      destination: r(["Vente", "Mixte", "Autoconsommation"]), cultures: [...new Set([r(["Manioc", "Manioc", "Banane plantain", "Arachide", "Maïs", "Cacao"]), ...sous(CULTURES, ri(0, 3))])],
      elevage: Math.random() < .5 ? sous(ELEVAGES, ri(1, 2)) : [], equipements: ["Houe / machette", ...sous(EQUIPEMENTS.slice(1), ri(0, 2))],
      cooperative: coop, nomCooperative: coop === "Oui" ? r(["Coop Mbongui", "GIE Les Bâtisseurs", "Coop Avenir Vert"]) : "", credit: r(["Oui", "Non", "Non"]),
      encadrement: r(["Oui", "Non"]), difficulte: r(["Accès aux intrants", "Financement", "Écoulement / transport", "Ravageurs / maladies", "Manque d'équipement"]),
      observations: "Donnée de démonstration", photo: "", dateCreation: date, updatedAt: new Date().toISOString(), _dirty: true
    });
  }
  S.donnees.push(...recs); await Store.putMany(recs);
  toast("40 agriculteurs de démonstration ajoutés"); remplirFiltresAgents(); majPastille(); afficher("tableau"); synchroniser();
};

/* =========================================================
   AGENTS (ADMIN / SUPERVISEUR)
   ========================================================= */
async function chargerAgents() {
  if (!navigator.onLine) return;
  try { S.agents = await Api.call("GET", "/api/users"); } catch (e) { if (e.status === 401) sessionExpiree(e.message); }
}
async function rendreAgents() {
  if (!estGestion()) return;
  if (!navigator.onLine) { $("#tbodyAgents").innerHTML = `<tr><td colspan="9" class="vide">📴 La gestion des agents nécessite une connexion Internet.</td></tr>`; return; }
  await chargerAgents();
  const admin = role() === "admin";
  $("#tbodyAgents").innerHTML = S.agents.map(a => `
    <tr><td><b>${esc(a.name)}</b>${a.phone ? `<div class="muted petit">${esc(a.phone)}</div>` : ""}</td><td>${esc(a.username)}</td><td class="code">${esc(a.agentCode)}</td>
    <td>${ROLES[a.role]}</td><td>${esc(a.zone || "—")}</td><td><b>${a.count}</b></td><td>${a.lastSync ? fdateh(a.lastSync) : "jamais"}</td>
    <td>${a.active ? '<span class="badge">Actif</span>' : '<span class="badge off">Désactivé</span>'}${a.mustChange ? ' <span class="badge att" title="Doit changer son mot de passe">mdp provisoire</span>' : ""}</td>
    ${admin ? `<td><button class="btn btn-s btn-petit" onclick="reinitMdp(${a.id})">🔑 Mot de passe</button> <button class="btn btn-s btn-petit" onclick="modifierZone(${a.id})">📍 Zone</button>
      ${a.id !== S.session.user.id ? `<button class="btn ${a.active ? "btn-d" : "btn-p"} btn-petit" onclick="basculerActif(${a.id},${!a.active})">${a.active ? "Désactiver" : "Réactiver"}</button>` : ""}</td>` : ""}</tr>`).join("");
  if (admin) { const f = $("#formConfig"); f.orgName.value = S.config.orgName || ""; f.campaign.value = S.config.campaign || ""; }
}
$("#formAgent").onsubmit = async e => {
  e.preventDefault();
  const f = e.target, body = Object.fromEntries(new FormData(f).entries());
  try {
    const u = await Api.call("POST", "/api/users", body);
    alert(`✅ Compte créé\n\nNom : ${u.name}\nIdentifiant : ${u.username}\nMot de passe provisoire : ${body.password}\nCode agent : ${u.agentCode}\n\nTransmettez ces informations à l'agent. Il devra changer son mot de passe à la première connexion.`);
    f.reset(); rendreAgents();
  } catch (ex) { toast("❌ " + ex.message); }
};
async function reinitMdp(id) {
  const a = S.agents.find(x => x.id === id);
  const pw = prompt(`Nouveau mot de passe provisoire pour ${a.name} (6 caractères min.) :`, Math.random().toString(36).slice(2, 8));
  if (!pw) return;
  try { await Api.call("PUT", "/api/users/" + id, { password: pw }); alert(`Mot de passe de ${a.name} réinitialisé : ${pw}\nIl devra le changer à la prochaine connexion.`); rendreAgents(); } catch (e) { toast("❌ " + e.message); }
}
async function modifierZone(id) {
  const a = S.agents.find(x => x.id === id), z = prompt(`Zone d'affectation de ${a.name} :`, a.zone || "");
  if (z === null) return;
  try { await Api.call("PUT", "/api/users/" + id, { zone: z }); rendreAgents(); } catch (e) { toast("❌ " + e.message); }
}
async function basculerActif(id, actif) {
  const a = S.agents.find(x => x.id === id);
  if (!actif && !confirm(`Désactiver ${a.name} ? Il ne pourra plus se connecter ni synchroniser.`)) return;
  try { await Api.call("PUT", "/api/users/" + id, { active: actif }); toast(actif ? "Compte réactivé" : "Compte désactivé"); rendreAgents(); } catch (e) { toast("❌ " + e.message); }
}
$("#formConfig").onsubmit = async e => {
  e.preventDefault();
  try { S.config = await Api.call("PUT", "/api/config", Object.fromEntries(new FormData(e.target).entries())); await Store.setMeta("config", S.config); afficherConfig(); toast("✅ Paramètres enregistrés"); }
  catch (ex) { toast("❌ " + ex.message); }
};

/* =========================================================
   COMPTE
   ========================================================= */
function rendreCompte() {
  const u = S.session.user;
  $("#infosCompte").innerHTML = [["Nom", u.name], ["Identifiant", u.username], ["Rôle", ROLES[u.role]], ["Code agent", u.agentCode], ["Zone", u.zone || "—"], ["Fiches sur l'appareil", visibles().length]]
    .map(([l, v]) => `<div><span>${l}</span><b>${esc(v)}</b></div>`).join("");
}
$("#formMdp").onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  if (f.next.value !== f.confirm.value) return toast("Les mots de passe ne correspondent pas");
  try {
    const r = await Api.call("POST", "/api/me/password", { current: f.current.value, next: f.next.value });
    S.session = { token: r.token, user: r.user }; Api.token = r.token; await Store.setMeta("session", S.session);
    f.reset(); toast("✅ Mot de passe modifié");
  } catch (ex) { toast("❌ " + (ex.reseau ? "Connexion Internet nécessaire" : ex.message)); }
};

/* =========================================================
   PWA : service worker & installation
   ========================================================= */
let majDemandee = false;
function enregistrerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").then(reg => {
    const proposer = w => { if (w && navigator.serviceWorker.controller) { $("#bandeauMaj").hidden = false; $("#btnMaj").onclick = () => { majDemandee = true; w.postMessage("skipWaiting"); }; } };
    if (reg.waiting) proposer(reg.waiting);
    reg.addEventListener("updatefound", () => { const w = reg.installing; w.addEventListener("statechange", () => { if (w.state === "installed") proposer(w); }); });
    setInterval(() => reg.update().catch(() => {}), 30 * 60e3);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (majDemandee) { majDemandee = false; location.reload(); } });
}
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); S.installPrompt = e; majInstall(); });
window.addEventListener("appinstalled", () => { S.installPrompt = null; majInstall(); toast("✅ Application installée"); });
function majInstall() {
  const installee = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("#btnInstaller").hidden = $("#btnInstaller2").hidden = !S.installPrompt || installee;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $("#infoInstall").innerHTML = installee ? "✅ L'application est installée sur cet appareil."
    : S.installPrompt ? "" : ios ? "Sur iPhone/iPad : touchez <b>Partager</b> puis <b>Sur l'écran d'accueil</b>."
    : "Sur Android (Chrome) : menu <b>⋮</b> puis <b>Installer l'application</b> / <b>Ajouter à l'écran d'accueil</b>.";
}
async function installer() { if (!S.installPrompt) return; S.installPrompt.prompt(); await S.installPrompt.userChoice; S.installPrompt = null; majInstall(); }
$("#btnInstaller").onclick = installer; $("#btnInstaller2").onclick = installer;

/* Exposition des fonctions utilisées dans le HTML généré */
Object.assign(window, { voir, editer, supprimer, fermerModal, afficher, resetForm, rendreListe, carteUnique, voirSurCarte, reinitMdp, modifierZone, basculerActif, S });

boot();
