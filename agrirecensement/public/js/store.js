/* =========================================================
   Stockage local (IndexedDB) + client API
   ========================================================= */
const Store = (() => {
  const NOM = "agrirecensement", VERSION = 1;
  let dbp = null;
  const p = r => new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((ok, ko) => {
      const r = indexedDB.open(NOM, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("farmers")) d.createObjectStore("farmers", { keyPath: "uid" });
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "k" });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
    return dbp;
  }
  async function ecrire(store, fn) {
    const d = await open();
    return new Promise((ok, ko) => {
      const t = d.transaction(store, "readwrite");
      fn(t.objectStore(store));
      t.oncomplete = () => ok();
      t.onerror = () => ko(t.error);
      t.onabort = () => ko(t.error || new Error("Transaction annulée (espace de stockage plein ?)"));
    });
  }

  return {
    async all() { const d = await open(); return p(d.transaction("farmers").objectStore("farmers").getAll()); },
    putMany(recs) { return recs.length ? ecrire("farmers", s => recs.forEach(r => s.put(r))) : Promise.resolve(); },
    put(r) { return this.putMany([r]); },
    delMany(uids) { return uids.length ? ecrire("farmers", s => uids.forEach(u => s.delete(u))) : Promise.resolve(); },
    clearFarmers() { return ecrire("farmers", s => s.clear()); },
    async getMeta(k) { const d = await open(); const r = await p(d.transaction("meta").objectStore("meta").get(k)); return r ? r.v : undefined; },
    setMeta(k, v) { return ecrire("meta", s => s.put({ k, v })); },
    delMeta(...ks) { return ecrire("meta", s => ks.forEach(k => s.delete(k))); },
    async demanderPersistance() { try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {} },
    async espace() { try { return await navigator.storage.estimate(); } catch { return null; } }
  };
})();

const Api = {
  token: null,
  async call(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: "Bearer " + this.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store"
      });
    } catch {
      const e = new Error("Pas de connexion au serveur"); e.reseau = true; throw e;
    }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || "Erreur serveur (" + res.status + ")"); e.status = res.status; throw e; }
    return data;
  }
};
