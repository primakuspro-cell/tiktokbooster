// TikTokBooster - serveur
// Zero dependance : node server.js suffit.
//
// Role : recoit une demande depuis la page, verifie les limites,
// puis passe la commande a un panel SMM et suit son avancement.
// La cle du panel reste ici, elle n'est jamais envoyee au navigateur.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ICI = __dirname;
const PUBLIC = path.join(ICI, "public");
const CONFIG = path.join(ICI, "config.json");
const JOURNAL = path.join(ICI, "commandes.json");

function chargerConfig() {
  let brut = fs.readFileSync(CONFIG, "utf8");
  // Windows ecrit parfois un BOM : JSON.parse le refuse.
  brut = brut.replace(/^\uFEFF/, "");
  const c = JSON.parse(brut);

  // Hebergement : ces variables d'environnement ecrasent config.json.
  // Sur Render/Vercel, on y met les valeurs secretes.
  if (process.env.PORT) {
    c.port = Number(process.env.PORT);
  }
  if (process.env.PANEL_API_URL) {
    c.panel.api_url = process.env.PANEL_API_URL;
  }
  if (process.env.PANEL_API_KEY) {
    c.panel.api_key = process.env.PANEL_API_KEY;
  }
  if (process.env.PANEL_SERVICE_ID) {
    c.panel.service_tiktok_views = process.env.PANEL_SERVICE_ID;
  }
  if (process.env.MODE_DEMO) {
    c.mode_demo = process.env.MODE_DEMO.toLowerCase() !== "false";
  }
  if (process.env.GATE_ACTIF) {
    c.gate = c.gate || {};
    c.gate.actif = process.env.GATE_ACTIF === "true";
  }
  if (process.env.GATE_URL) {
    c.gate = c.gate || {};
    c.gate.url = process.env.GATE_URL;
  }

  return c;
}

let config = chargerConfig();

// ---------------------------------------------------------------
// journal des commandes (persiste entre deux redemarrages)
// ---------------------------------------------------------------
let commandes = {};

function chargerJournal() {
  try {
    if (fs.existsSync(JOURNAL)) {
      commandes = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
    }
  } catch (e) {
    commandes = {};
  }
}

function sauverJournal() {
  try {
    fs.writeFileSync(JOURNAL, JSON.stringify(commandes, null, 2), "utf8");
  } catch (e) {
    console.error("journal non sauve :", e.message);
  }
}

// ---------------------------------------------------------------
// limites par IP
// ---------------------------------------------------------------
const historique = {};

function ipDe(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return (req.socket.remoteAddress || "inconnu").replace("::ffff:", "");
}

function verifierLimite(ip) {
  const maintenant = Date.now();
  const cooldown = config.limites.cooldown_minutes * 60 * 1000;

  const liste = (historique[ip] || []).filter((t) => maintenant - t < 24 * 60 * 60 * 1000);
  historique[ip] = liste;

  if (liste.length >= config.limites.max_par_jour_par_ip) {
    const plusRecent = Math.max.apply(null, liste);
    const reste = plusRecent + cooldown - maintenant;
    return {
      ok: false,
      message:
        "Tu as deja passe une commande aujourd'hui. Prochaine disponible dans " +
        Math.ceil(reste / 60000) +
        " minutes."
    };
  }

  return { ok: true };
}

function enregistrerCommande(ip) {
  if (!historique[ip]) {
    historique[ip] = [];
  }
  historique[ip].push(Date.now());
}

// ---------------------------------------------------------------
// validation
// ---------------------------------------------------------------
const MOTIF_TIKTOK = /^https?:\/\/(www\.|vm\.|m\.)?tiktok\.com\/.+/i;

function validerCommande(corps) {
  const lien = String(corps.lien || "").trim();
  const quantite = parseInt(corps.quantite, 10);

  if (!lien) {
    return { ok: false, message: "Le lien de la video est vide." };
  }

  if (!MOTIF_TIKTOK.test(lien)) {
    return { ok: false, message: "Ce lien n'est pas un lien TikTok valide." };
  }

  if (!Number.isFinite(quantite)) {
    return { ok: false, message: "Quantite invalide." };
  }

  if (quantite < config.limites.min) {
    return { ok: false, message: "Minimum " + config.limites.min + " vues." };
  }

  if (quantite > config.limites.max) {
    return { ok: false, message: "Maximum " + config.limites.max + " vues." };
  }

  return { ok: true, lien: lien, quantite: quantite };
}

// ---------------------------------------------------------------
// appel du panel SMM
// ---------------------------------------------------------------
function appelPanel(params) {
  return new Promise((resolve) => {
    const corps = new URLSearchParams();
    corps.append("key", config.panel.api_key);
    Object.keys(params).forEach((k) => corps.append(k, params[k]));

    const donnees = corps.toString();

    const url = new URL(config.panel.api_url);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(donnees)
      }
    };

    const requete = require(url.protocol === "http:" ? "http" : "https").request(options, (reponse) => {
      let texte = "";
      reponse.on("data", (bloc) => (texte += bloc));
      reponse.on("end", () => {
        try {
          resolve(JSON.parse(texte));
        } catch (e) {
          resolve({ error: "Reponse panel illisible : " + texte.slice(0, 200) });
        }
      });
    });

    requete.on("error", (e) => resolve({ error: e.message }));
    requete.setTimeout(25000, () => {
      requete.destroy();
      resolve({ error: "Le panel n'a pas repondu a temps." });
    });

    requete.write(donnees);
    requete.end();
  });
}

function identifiant() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------------------------------------------------------------
// routes
// ---------------------------------------------------------------
function json(reponse, code, objet) {
  const corps = JSON.stringify(objet);
  reponse.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  reponse.end(corps);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function servirStatique(reponse, chemin) {
  const relatif = chemin === "/" ? "index.html" : chemin.replace(/^\/+/, "");

  if (relatif.indexOf("..") !== -1) {
    reponse.writeHead(403);
    reponse.end("403");
    return;
  }

  const fichier = path.join(PUBLIC, relatif);

  fs.readFile(fichier, (erreur, contenu) => {
    if (erreur) {
      reponse.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      reponse.end("404");
      return;
    }
    reponse.writeHead(200, {
      "Content-Type": TYPES[path.extname(fichier)] || "application/octet-stream"
    });
    reponse.end(contenu);
  });
}

async function traiterCommande(req, reponse) {
  let brut = "";
  let trop = false;

  req.on("data", (bloc) => {
    brut += bloc;
    if (brut.length > 100000) {
      trop = true;
      req.destroy();
    }
  });

  req.on("end", async () => {
    if (trop) {
      json(reponse, 413, { ok: false, message: "Requete trop volumineuse." });
      return;
    }

    let corps;
    try {
      corps = JSON.parse(brut || "{}");
    } catch (e) {
      json(reponse, 400, { ok: false, message: "Requete illisible." });
      return;
    }

    const valide = validerCommande(corps);
    if (!valide.ok) {
      json(reponse, 400, { ok: false, message: valide.message });
      return;
    }

    const ip = ipDe(req);
    const limite = verifierLimite(ip);
    if (!limite.ok) {
      json(reponse, 429, { ok: false, message: limite.message });
      return;
    }

    const id = identifiant();

    // Mode demo : aucune commande reelle, on simule l'avancement.
    if (config.mode_demo) {
      commandes[id] = {
        id: id,
        lien: valide.lien,
        quantite: valide.quantite,
        service: "demo",
        debut: Date.now(),
        reste: valide.quantite,
        statut: "En cours"
      };
      enregistrerCommande(ip);
      sauverJournal();

      console.log("[demo] " + valide.quantite + " vues -> " + valide.lien);

      json(reponse, 200, {
        ok: true,
        id: id,
        quantite: valide.quantite,
        message: "Commande acceptee (mode demo)."
      });
      return;
    }

    const resultat = await appelPanel({
      action: "add",
      service: config.panel.service_tiktok_views,
      link: valide.lien,
      quantity: valide.quantite
    });

    if (!resultat || resultat.error) {
      json(reponse, 502, {
        ok: false,
        message: "Le panel a refuse : " + ((resultat && resultat.error) || "erreur inconnue")
      });
      return;
    }

    commandes[id] = {
      id: id,
      lien: valide.lien,
      quantite: valide.quantite,
      service: config.panel.service_tiktok_views,
      panel_order: resultat.order || null,
      debut: Date.now(),
      reste: valide.quantite,
      statut: "En cours"
    };
    enregistrerCommande(ip);
    sauverJournal();

    console.log("[commande] " + valide.quantite + " vues -> " + valide.lien + " (panel " + resultat.order + ")");

    json(reponse, 200, {
      ok: true,
      id: id,
      quantite: valide.quantite,
      message: "Commande envoyee au panel."
    });
  });
}

async function traiterStatut(reponse, id) {
  const commande = commandes[id];

  if (!commande) {
    json(reponse, 404, { ok: false, message: "Commande inconnue." });
    return;
  }

  if (commande.service === "demo") {
    const ecoule = (Date.now() - commande.debut) / 1000;
    const debit = commande.quantite / 120; // termine en 2 minutes
    const fait = Math.min(commande.quantite, Math.floor(ecoule * debit));
    commande.reste = commande.quantite - fait;
    commande.statut = commande.reste > 0 ? "En cours" : "Termine";

    json(reponse, 200, {
      ok: true,
      id: commande.id,
      statut: commande.statut,
      quantite: commande.quantite,
      livre: fait,
      reste: commande.reste,
      progression: Math.round((fait / commande.quantite) * 100)
    });
    return;
  }

  if (!commande.panel_order) {
    json(reponse, 200, {
      ok: true,
      id: commande.id,
      statut: "En attente",
      quantite: commande.quantite,
      livre: 0,
      reste: commande.quantite,
      progression: 0
    });
    return;
  }

  const resultat = await appelPanel({
    action: "status",
    order: commande.panel_order
  });

  if (!resultat || resultat.error) {
    json(reponse, 200, {
      ok: true,
      id: commande.id,
      statut: commande.statut,
      quantite: commande.quantite,
      livre: commande.quantite - commande.reste,
      reste: commande.reste,
      progression: Math.round(((commande.quantite - commande.reste) / commande.quantite) * 100)
    });
    return;
  }

  commande.statut = resultat.status || commande.statut;
  commande.reste = Number.isFinite(resultat.remains) ? resultat.remains : commande.reste;
  sauverJournal();

  const livre = commande.quantite - commande.reste;

  json(reponse, 200, {
    ok: true,
    id: commande.id,
    statut: commande.statut,
    quantite: commande.quantite,
    livre: livre,
    reste: commande.reste,
    progression: Math.max(0, Math.min(100, Math.round((livre / commande.quantite) * 100)))
  });
}

// ---------------------------------------------------------------
// serveur
// ---------------------------------------------------------------
chargerJournal();

const serveur = http.createServer((req, reponse) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

  reponse.setHeader("X-Content-Type-Options", "nosniff");

  if (url.pathname === "/api/order" && req.method === "POST") {
    traiterCommande(req, reponse);
    return;
  }

  if (url.pathname.startsWith("/api/order/") && req.method === "GET") {
    traiterStatut(reponse, url.pathname.split("/").pop());
    return;
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    json(reponse, 200, {
      min: config.limites.min,
      max: config.limites.max,
      cooldown_minutes: config.limites.cooldown_minutes,
      demo: config.mode_demo,
      gate: config.gate || { actif: false }
    });
    return;
  }

  servirStatique(reponse, url.pathname);
});

serveur.listen(config.port, () => {
  console.log("");
  console.log("  TikTokBooster");
  console.log("  http://127.0.0.1:" + config.port);
  console.log("");
  console.log("  mode : " + (config.mode_demo ? "DEMO (aucune vue reelle)" : "PANEL REEl"));
  console.log("  max  : " + config.limites.max + " vues par commande");
  console.log("");
});
