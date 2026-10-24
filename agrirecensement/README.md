# 🌱 AgriRecensement – Recensement des agriculteurs (République du Congo)

Application complète de recensement des agriculteurs :

| Module | Description |
|---|---|
| 🖥️ **Serveur central** | Base de données SQLite unique pour toute la campagne, API sécurisée |
| 🔐 **Comptes agents** | Rôles *Administrateur*, *Superviseur*, *Agent recenseur*, mot de passe provisoire à changer à la 1re connexion |
| 🔄 **Synchronisation** | Les agents travaillent **hors ligne** ; les fiches sont envoyées automatiquement dès que le réseau revient |
| 🗺️ **Carte** | Localisation GPS des exploitations (OpenStreetMap / satellite), couleurs par sexe, culture ou superficie |
| 📲 **PWA installable** | S'installe sur Android/iPhone/PC comme une vraie application, fonctionne sans réseau |
| 🪪 **Cartes d'agriculteur** | PDF A4, 10 cartes format bancaire par page, photo + **QR code de vérification**, verso pour recto-verso |

---

## 1. Installation

Prérequis : **Node.js 20 ou plus récent**.

```bash
cd agrirecensement
npm install
npm start
```

L'application est disponible sur `http://localhost:3000`.

**Premier compte :** `admin` / `admin123` → un nouveau mot de passe est demandé immédiatement.

Variables d'environnement facultatives :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `HOST` | `0.0.0.0` | Interface réseau |
| `DATA_DIR` | `./data` | Dossier de la base `recensement.db` |

## 2. Mise en ligne (production)

⚠️ **HTTPS est obligatoire** pour l'installation de la PWA, le GPS et l'appareil photo sur téléphone.

Exemple sur un serveur Linux (VPS) avec **Caddy** (certificat HTTPS automatique) :

```
# /etc/caddy/Caddyfile
recensement.mondomaine.cg {
    reverse_proxy localhost:3000
}
```

Pour garder le serveur actif en permanence : `pm2 start server.js --name agrirecensement` (ou un service systemd).

**Sauvegarde :** copiez régulièrement le fichier `data/recensement.db` (par ex. tous les soirs via `cron`).

## 3. Organisation d'une campagne

1. **L'administrateur** se connecte, va dans **👥 Agents** et crée un compte par agent recenseur (un code agent `A001`, `A002`… est attribué automatiquement).
2. Il règle dans **⚙️ Paramètres des cartes** le nom de l'organisme émetteur et de la campagne (imprimés sur les cartes).
3. **Chaque agent** ouvre l'adresse du serveur sur son téléphone, se connecte (Internet requis la 1re fois), change son mot de passe puis **installe l'application** (bouton 📲).
4. Sur le terrain, l'agent recense **même sans réseau** : photo, GPS, cultures… Le voyant en haut indique :
   - 🟢 *Synchronisé* – 🟡 *N en attente* – 🔴 *Hors ligne*
5. Dès qu'il capte le réseau, les fiches partent au serveur automatiquement.
6. **Superviseurs et administrateur** suivent l'avancement par agent dans le tableau de bord, consultent la carte globale, exportent en CSV/Excel et impriment les cartes d'agriculteur.

## 4. Codes agriculteurs & QR codes

- Chaque fiche reçoit un code unique **`AGR-<code agent>-<numéro>`** (ex. `AGR-A003-00127`), généré sur le téléphone **sans besoin de réseau** et sans risque de doublon entre agents.
- Le QR code de la carte ouvre `https://<serveur>/verifier/<code>` : page publique qui confirme que l'agriculteur est bien recensé (photo, nom, localité – **sans** téléphone ni pièce d'identité). Une fiche supprimée affiche « carte annulée ».

## 5. Impression des cartes

Onglet **🪪 Cartes agriculteurs** → filtrer (ex. « Jamais imprimées », par département) → **Tout sélectionner** → **Générer le PDF**.

- Format 85,6 × 54 mm, 10 cartes par page A4, traits de coupe.
- Verso : imprimer en **recto-verso, retournement bord long** (les versos sont placés en miroir).
- Pour des cartes rigides : imprimer sur papier cartonné 250–300 g puis plastifier.
- Les cartes générées sont marquées « imprimées » (date synchronisée avec le serveur).

## 6. Sécurité

- Mots de passe hachés (scrypt), sessions signées de 30 jours (pour permettre le travail hors ligne prolongé).
- Désactiver un agent ou réinitialiser son mot de passe **révoque immédiatement** ses sessions.
- Un agent ne voit et ne modifie que **ses propres fiches** ; superviseurs et administrateurs voient tout.
- Limitation des tentatives de connexion (10 essais / 15 min).
- À la déconnexion, les données sont effacées du téléphone (après vérification que tout a été envoyé).

## 7. Reprise des données de la première version

Dans la première version (fichier HTML unique), faites **💾 Données → Sauvegarde JSON**, puis dans la nouvelle application **🔄 Synchro & données → Importer**. Les fiches reçoivent automatiquement un nouveau code et sont envoyées au serveur.

## Structure

```
agrirecensement/
├── server.js              # Serveur Express + API + page de vérification
├── data/recensement.db    # Base de données (créée au démarrage)
└── public/                # Application PWA
    ├── index.html, styles.css, manifest.webmanifest, sw.js
    ├── js/store.js        # Stockage hors ligne (IndexedDB) + client API
    ├── js/app.js          # Logique de l'application et synchronisation
    ├── js/map.js          # Cartographie (Leaflet)
    ├── js/cards.js        # Cartes d'agriculteur PDF + QR code
    ├── icons/             # Icônes de l'application
    └── vendor/            # Leaflet, jsPDF, qrcode-generator (inclus, fonctionnent hors ligne)
```
