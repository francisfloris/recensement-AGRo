/* =========================================================
   Cartes d'agriculteur : aperçu (canvas) et PDF (jsPDF) avec QR code
   Un même code de dessin sert aux deux rendus (interface « peintre »).
   ========================================================= */
const Cartes = (() => {
  const W = 85.6, H = 54;                 // format carte bancaire (mm)
  const VERT = "#1f7a3f", VERT_F = "#145a2d", VERT_C = "#e7f4ec", JAUNE = "#f2b705", ROUGE = "#dc241f", GRIS = "#6b7280", TEXTE = "#1f2937";
  const PT = 0.3528;                      // 1 point typographique en mm

  const urlVerif = code => `${location.origin}/verifier/${code}`;
  const fdate = s => s ? new Date(s).toLocaleDateString("fr-FR") : "—";

  /* ---------- Peintre jsPDF (unités : mm) ---------- */
  function peintrePDF(doc) {
    return {
      rect(x, y, w, h, fill, r = 0, stroke) {
        if (fill) doc.setFillColor(fill);
        if (stroke) { doc.setDrawColor(stroke); doc.setLineWidth(0.2); }
        const mode = fill && stroke ? "FD" : fill ? "F" : "S";
        r ? doc.roundedRect(x, y, w, h, r, r, mode) : doc.rect(x, y, w, h, mode);
      },
      tri(pts, fill) { doc.setFillColor(fill); doc.triangle(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], "F"); },
      police(size, bold) { doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); },
      mesure(t, size, bold) { this.police(size, bold); return doc.getTextWidth(t); },
      texte(t, x, y, { size = 7, bold = false, color = TEXTE, align = "left" } = {}) { this.police(size, bold); doc.setTextColor(color); doc.text(String(t), x, y, { align }); },
      image(src, x, y, w, h) { try { doc.addImage(src, src.startsWith("data:image/png") ? "PNG" : "JPEG", x, y, w, h); return true; } catch { return false; } },
      ligne(x1, y1, x2, y2, color, lw = 0.2, dash) { doc.setDrawColor(color); doc.setLineWidth(lw); if (dash) doc.setLineDashPattern(dash, 0); doc.line(x1, y1, x2, y2); if (dash) doc.setLineDashPattern([], 0); }
    };
  }

  /* ---------- Peintre canvas (k = pixels par mm) ---------- */
  function peintreCanvas(ctx, k, images) {
    return {
      rect(x, y, w, h, fill, r = 0, stroke) {
        ctx.beginPath();
        if (r && ctx.roundRect) ctx.roundRect(x * k, y * k, w * k, h * k, r * k); else ctx.rect(x * k, y * k, w * k, h * k);
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.2 * k; ctx.stroke(); }
      },
      tri(p, fill) { ctx.beginPath(); ctx.moveTo(p[0] * k, p[1] * k); ctx.lineTo(p[2] * k, p[3] * k); ctx.lineTo(p[4] * k, p[5] * k); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); },
      police(size, bold) { ctx.font = `${bold ? "bold " : ""}${size * PT * k}px Helvetica, Arial, sans-serif`; },
      mesure(t, size, bold) { this.police(size, bold); return ctx.measureText(t).width / k; },
      texte(t, x, y, { size = 7, bold = false, color = TEXTE, align = "left" } = {}) { this.police(size, bold); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = "alphabetic"; ctx.fillText(String(t), x * k, y * k); },
      image(src, x, y, w, h) { const im = images[src]; if (!im) return false; ctx.drawImage(im, x * k, y * k, w * k, h * k); return true; },
      ligne(x1, y1, x2, y2, color, lw = 0.2) { ctx.beginPath(); ctx.moveTo(x1 * k, y1 * k); ctx.lineTo(x2 * k, y2 * k); ctx.strokeStyle = color; ctx.lineWidth = lw * k; ctx.stroke(); }
    };
  }

  /* ---------- Outils ---------- */
  function ajuster(p, t, maxW, size, bold) {
    t = String(t || "");
    if (p.mesure(t, size, bold) <= maxW) return t;
    while (t.length > 1 && p.mesure(t + "...", size, bold) > maxW) t = t.slice(0, -1);
    return t.trim() + "...";
  }
  function tailleAjustee(p, t, maxW, size, min, bold) {
    while (size > min && p.mesure(t, size, bold) > maxW) size -= 0.25;
    return size;
  }
  function qr(p, texte, x, y, taille) {
    const q = qrcode(0, "M"); q.addData(texte); q.make();
    const n = q.getModuleCount(), m = taille / n;
    p.rect(x - 1, y - 1, taille + 2, taille + 2, "#ffffff", 1);
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {                       // regroupe les modules sombres contigus d'une ligne
        if (q.isDark(r, c)) { let f = c; while (f + 1 < n && q.isDark(r, f + 1)) f++; p.rect(x + c * m, y + r * m, (f - c + 1) * m + 0.02, m + 0.02, "#000000"); c = f + 1; }
        else c++;
      }
    }
  }
  function drapeau(p, x, y, w, h) {
    p.rect(x, y, w, h, JAUNE);
    p.tri([x, y, x + w * 0.62, y, x, y + h * 0.95], "#009543");
    p.tri([x + w, y + h, x + w * 0.38, y + h, x + w, y + h * 0.05], ROUGE);
  }
  function entete(p, x, y, cfg, titre) {
    p.rect(x, y, W, 11, VERT, 3);
    p.rect(x, y + 6, W, 5, VERT);
    p.rect(x, y + 11, W, 0.8, JAUNE);
    drapeau(p, x + 3, y + 2.4, 9.5, 6.3);
    p.texte(ajuster(p, (cfg.orgName || "République du Congo"), W - 18, 5.6, true), x + 15, y + 4.6, { size: 5.6, bold: true, color: "#ffffff" });
    p.texte(titre, x + 15, y + 8.8, { size: 7.6, bold: true, color: JAUNE });
  }

  /* ---------- Recto ---------- */
  function recto(p, x, y, d, cfg) {
    p.rect(x, y, W, H, "#ffffff", 3, "#c8cec8");
    entete(p, x, y, cfg, "CARTE D'AGRICULTEUR");

    // Photo
    const px = x + 3, py = y + 14.5, pw = 19, ph = 23.5;
    p.rect(px, py, pw, ph, VERT_C, 1.2);
    if (!(d.photo && p.image(d.photo, px, py, pw, ph))) {
      const ini = ((d.prenom || "")[0] || "") + ((d.nom || "")[0] || "");
      p.texte(ini.toUpperCase(), px + pw / 2, py + ph / 2 + 2.5, { size: 16, bold: true, color: VERT_F, align: "center" });
    }
    p.rect(px, py, pw, ph, null, 1.2, "#b9c4b9");

    // QR code
    const qs = 20.5, qx = x + W - 3 - qs, qy = y + 14.5;
    qr(p, urlVerif(d.code), qx, qy, qs);
    p.texte(d.code, qx + qs / 2, qy + qs + 3.4, { size: tailleAjustee(p, d.code, qs + 2, 6, 4.5, true), bold: true, color: VERT_F, align: "center" });

    // Identité
    const tx = x + 25, tw = qx - 2.5 - tx;
    const nom = (d.nom || "").toUpperCase();
    const sz = tailleAjustee(p, nom, tw, 9.5, 6.5, true);
    p.texte(ajuster(p, nom, tw, sz, true), tx, y + 18.2, { size: sz, bold: true });
    p.texte(ajuster(p, d.prenom, tw, 7.6, false), tx, y + 21.8, { size: 7.6 });
    const champs = [
      ["Sexe", d.sexe === "Féminin" ? "F" : d.sexe === "Masculin" ? "M" : "—"],
      ["Né(e) le", fdate(d.naissance)],
      ["Localité", d.village],
      ["Départ.", d.departement],
      ["Superficie", d.superficie ? `${(+d.superficie).toLocaleString("fr-FR")} ha` : "—"]
    ];
    champs.forEach(([l, v], i) => {
      const ly = y + 25.6 + i * 3.1;
      p.texte(l, tx, ly, { size: 5.2, color: GRIS });
      p.texte(ajuster(p, v || "—", tw - 11, 6.2, true), tx + 11, ly, { size: 6.2, bold: true });
    });

    // Cultures
    p.texte("Cultures :", x + 3, y + 43.2, { size: 5.2, color: GRIS });
    p.texte(ajuster(p, (d.cultures || []).join(", ") || "—", W - 16 - 25, 6, false), x + 12.5, y + 43.2, { size: 6 });

    // Pied
    p.rect(x, y + H - 6.5, W, 6.5, VERT_C, 3);
    p.rect(x, y + H - 6.5, W, 3, VERT_C);
    p.texte(`Émise le ${fdate(new Date())}`, x + 3, y + H - 2.4, { size: 5, color: VERT_F });
    p.texte(ajuster(p, cfg.campaign || "", W - 30, 5, true), x + W - 3, y + H - 2.4, { size: 5, bold: true, color: VERT_F, align: "right" });
  }

  /* ---------- Verso ---------- */
  function verso(p, x, y, d, cfg) {
    p.rect(x, y, W, H, "#ffffff", 3, "#c8cec8");
    entete(p, x, y, cfg, "INFORMATIONS");
    const lignes = [
      "• Cette carte est personnelle, gratuite et non cessible.",
      "• Présentez-la lors des distributions d'intrants,",
      "   formations, appuis et visites des agents.",
      "• En cas de perte, signalez-la à l'agent de votre zone.",
      "• Vérification : scannez le QR code au recto."
    ];
    lignes.forEach((l, i) => p.texte(l, x + 4, y + 16.5 + i * 3.4, { size: 6 }));
    p.texte("Agent recenseur :", x + 4, y + 35.5, { size: 5.4, color: GRIS });
    p.texte(ajuster(p, d.agentName || "—", 38, 6.2, true), x + 4, y + 38.6, { size: 6.2, bold: true });
    p.texte("Recensé le :", x + 4, y + 42.2, { size: 5.4, color: GRIS });
    p.texte(fdate(d.dateCreation), x + 15.5, y + 42.2, { size: 6.2, bold: true });
    p.texte("Signature et cachet", x + W - 22, y + 35.5, { size: 5.4, color: GRIS, align: "center" });
    p.rect(x + W - 39, y + 37, 34, 9.5, null, 1.5, "#b9c4b9");
    p.rect(x, y + H - 4, W, 4, VERT, 3); p.rect(x, y + H - 4, W, 2, VERT);
    p.texte(ajuster(p, urlVerif(d.code), W - 8, 4.8, false), x + W / 2, y + H - 1.2, { size: 4.8, color: "#ffffff", align: "center" });
  }

  function chargerImage(src) {
    return new Promise(ok => { if (!src) return ok(null); const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = src; });
  }

  return {
    async apercu(canvas, d, cfg) {
      const k = canvas.width / W, ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const images = {}; if (d.photo) images[d.photo] = await chargerImage(d.photo);
      recto(peintreCanvas(ctx, k, images), 0, 0, d, cfg);
    },

    /** Génère un PDF A4 : 10 cartes par page (2 × 5), verso optionnel en miroir pour impression recto-verso. */
    pdf(records, cfg, { verso: avecVerso = true } = {}) {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
      doc.setProperties({ title: "Cartes d'agriculteur", creator: "AgriRecensement" });
      const p = peintrePDF(doc);
      const GAP = 4, MX = (210 - 2 * W - GAP) / 2, MY = (297 - 5 * H - 4 * GAP) / 2;
      const pos = (i, miroir) => { const col = i % 2, row = Math.floor(i / 2); const c = miroir ? 1 - col : col; return [MX + c * (W + GAP), MY + row * (H + GAP)]; };
      const traitsCoupe = () => {
        for (let c = 0; c < 2; c++) { const x0 = MX + c * (W + GAP); [x0, x0 + W].forEach(x => { p.ligne(x, 2, x, MY - 1.5, "#999999", 0.15); p.ligne(x, 297 - MY + 1.5, x, 295, "#999999", 0.15); }); }
        for (let r = 0; r < 5; r++) { const y0 = MY + r * (H + GAP); [y0, y0 + H].forEach(y => { p.ligne(2, y, MX - 1.5, y, "#999999", 0.15); p.ligne(210 - MX + 1.5, y, 208, y, "#999999", 0.15); }); }
      };
      let premiere = true;
      for (let s = 0; s < records.length; s += 10) {
        const lot = records.slice(s, s + 10);
        if (!premiere) doc.addPage(); premiere = false;
        traitsCoupe();
        lot.forEach((d, i) => { const [x, y] = pos(i, false); recto(p, x, y, d, cfg); });
        p.texte(`Recto – page ${Math.floor(s / 10) + 1} – ${lot.length} carte(s)`, 105, 296, { size: 6, color: "#999999", align: "center" });
        if (avecVerso) {
          doc.addPage(); traitsCoupe();
          lot.forEach((d, i) => { const [x, y] = pos(i, true); verso(p, x, y, d, cfg); });
          p.texte(`Verso – page ${Math.floor(s / 10) + 1} (imprimer en recto-verso, retournement bord long)`, 105, 296, { size: 6, color: "#999999", align: "center" });
        }
      }
      const nom = records.length === 1 ? `carte_${records[0].code}.pdf` : `cartes_agriculteurs_${new Date().toISOString().slice(0, 10)}.pdf`;
      doc.save(nom);
      return nom;
    }
  };
})();
