// server.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const xml2js = require("xml2js");
const { setGlobalDispatcher, Agent } = require("undici");

setGlobalDispatcher(
  new Agent({
    headersTimeout: 0, // 0 = pas de timeout sur les headers
    bodyTimeout: 0     // 0 = pas de timeout sur le corps (optionnel mais pratique pour toi)
  })
);



if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY n'est pas défini dans les variables d'environnement.");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" })); // images base64, gros prompts

const PORT = process.env.PORT || 3000;
// Extraction texte depuis un PDF encodé en base64 (strict minimum)
async function extractTextFromPdf(base64Data) {
  if (!base64Data) return "";
  try {
    const buffer = Buffer.from(base64Data, "base64");

    const data = await pdfParse(buffer);   // 👈 on appelle directement la fonction
    let text = data.text || "";

    // Nettoyage simple
    text = text.replace(/\r/g, "").replace(/\t/g, " ");
    text = text.replace(/ +/g, " ");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();

    const MAX_CHARS = 8000;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + "\n\n[Texte tronqué]";
    }

    return text;
  } catch (e) {
    console.error("Erreur extraction PDF :", e);
    return "";
  }
}

// Extraction texte depuis un DOCX encodé en base64
async function extractTextFromDocx(base64Data) {
  if (!base64Data) return "";
  try {
    const buffer = Buffer.from(base64Data, "base64");

    const result = await mammoth.extractRawText({ buffer });
    let text = result.value || "";

    // Nettoyage léger
    text = text.replace(/\r/g, "").replace(/\t/g, " ");
    text = text.replace(/ +/g, " ");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();

    // On tronque pour ne pas exploser le contexte
    const MAX_CHARS = 8000;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + "\n\n[Texte DOCX tronqué]";
    }

    return text;
  } catch (e) {
    console.error("Erreur extraction DOCX :", e);
    return "";
  }
}

// Extraction texte depuis un XLSX encodé en base64
async function extractTextFromXlsx(base64Data) {
  if (!base64Data) return "";
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const parts = [];

    workbook.eachSheet((worksheet) => {
      parts.push(`Feuille : ${worksheet.name}`);

      worksheet.eachRow((row) => {
        const cells = row.values
          .filter(v => v !== null && v !== undefined && v !== "")
          .map(v => (typeof v === "object" ? (v.text || "") : String(v)));

        if (cells.length) {
          parts.push("  " + cells.join(" | "));
        }
      });

      parts.push("");
    });

    let text = parts.join("\n");

    // Nettoyage
    text = text.replace(/\r/g, "");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();

    const MAX_CHARS = 8000;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + "\n\n[Texte Excel tronqué]";
    }

    return text;
  } catch (e) {
    console.error("Erreur extraction XLSX :", e);
    return "";
  }
}

// Extraction texte depuis un PPTX encodé en base64
async function extractTextFromPptx(base64Data) {
  if (!base64Data) return "";
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const zip = await JSZip.loadAsync(buffer);

    // On récupère tous les fichiers de slide : ppt/slides/slide1.xml, slide2.xml, etc.
    const slidePaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
        const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
        return na - nb;
      });

    const parser = new xml2js.Parser();
    const parts = [];

    // Fonction récursive pour aller chercher tous les noeuds <a:t> (texte)
    function collectText(node) {
      if (!node) return;

      if (Array.isArray(node)) {
        node.forEach(collectText);
        return;
      }

      if (typeof node === "object") {
        // Balises texte PowerPoint : a:t
        if (node["a:t"]) {
          const texts = Array.isArray(node["a:t"]) ? node["a:t"] : [node["a:t"]];
          for (const t of texts) {
            if (typeof t === "string") {
              const trimmed = t.trim();
              if (trimmed) parts.push(trimmed);
            } else if (t && typeof t === "object" && typeof t._ === "string") {
              const trimmed = t._.trim();
              if (trimmed) parts.push(trimmed);
            }
          }
        }

        // On continue à descendre dans l'arbre XML
        for (const key of Object.keys(node)) {
          if (key === "a:t") continue;
          collectText(node[key]);
        }
      }
    }

    for (const slidePath of slidePaths) {
      const xml = await zip.file(slidePath).async("text");
      const slideObj = await parser.parseStringPromise(xml);
      collectText(slideObj);
      parts.push("\n"); // séparation entre les slides
    }

    let text = parts.join(" ");

    // Nettoyage simple
    text = text.replace(/\r/g, "");
    text = text.replace(/\t/g, " ");
    text = text.replace(/ +/g, " ");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();

    const MAX_CHARS = 8000;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + "\n\n[Texte PPTX tronqué]";
    }

    return text;
  } catch (e) {
    console.error("Erreur extraction PPTX :", e);
    return "";
  }
}

const DOC_CONTEXT_INTRO = `
Le texte ci-dessous est une transcription brute du document fourni par l'utilisateur
(fichier Excel, PDF, Word, etc.).

Tu dois l'utiliser comme source unique pour générer l'écran demandé
conformément aux règles définies dans le message système.

----- DEBUT DOCUMENT SOURCE -----

`;



async function callOpenAIChat({ system, mode, prompt, images = [], files = [], conversation = [] }) {

  const apiKey = process.env.OPENAI_API_KEY;

  const sysMsgChat = `
Tu es un assistant fonctionnel pour l’application VIKTA.

RÈGLES STRICTES (OBLIGATOIRES) :
- Tu réponds UNIQUEMENT en TEXTE BRUT.
- Interdiction d'utiliser des balises HTML (<...>), Markdown, ou des blocs de code.
- Si on parle de code, tu décris en phrases, sans formater en HTML.
- Réponses courtes et utiles.
`;



let sysMsg;

if (mode === "chat") {
  sysMsg = sysMsgChat;
} else if (mode === "translate") {
  sysMsg = `You are a professional French-to-English translator working on HTML documents.

RULES (MANDATORY):
- Return the HTML in the SAME FORMAT as received: if given a complete HTML document, return a complete HTML document; if given an HTML snippet, return the translated snippet.
- Translate ONLY visible French text to English: text nodes, placeholder, aria-label, title, alt, value attributes containing readable text.
- Do NOT translate: CSS class names, HTML IDs, JavaScript code, CSS property values, variable names, data-* attribute values with technical content.
- Do NOT add or remove any HTML elements or attributes.
- Do NOT wrap the response in markdown, code blocks, or any other markup.
- Return ONLY the translated HTML, nothing else.`;
} else {
  sysMsg = `
Tu es un assistant front-end qui génère des écrans HTML et JavaScript pour l’application VIKTA à partir de documents bruts (souvent des fichiers Excel) et des instructions d’un Product Owner. Ton objectif est de produire du code propre, structuré et proche d’une intégration pour les développeurs VIKTA, sans générer de CSS et sans chercher un rendu pixel perfect.

REGLES GENERALES:
- Tu renvoies toujours un document HTML complet: DOCTYPE, html, head, body.
- Tu n'utilises jamais Markdown, ni blocs de code Markdown, ni texte explicatif hors HTML.
- Tu n'écris pas de balise <style> et tu n’utilises pas de style inline.
- Tu n'ajoutes aucun framework externe (pas de Bootstrap CDN, pas de jQuery CDN, etc.).
- Tu utilises uniquement les classes HTML présentes dans VIKTA selon les conventions listées ci-dessous.
- Un seul script à la fin du body contient toute la logique JavaScript de l’écran (y compris la logique métier complexe si nécessaire).

- Tu n’inventes jamais de classes CSS, jamais de frameworks, jamais de <script> supplémentaires. Tout JS doit être dans un unique <script> final.

CONVENTIONS HTML VIKTA:
1) POPUPS / DIALOGUES
Structure obligatoire:
<div class="ui-dialog ui-corner-all ui-widget ui-widget-content ui-front no-title-bar dialog-x-none">
  <div class="ui-dialog-titlebar ui-corner-all ui-widget-header ui-helper-clearfix ui-draggable-handle"></div>
  <div class="app-data-container app-dialog ui-dialog-content ui-widget-content" id="main-dialog">
    CONTENU
    <div class="row mt-4">
      <div class="col-5">
        <button type="button" class="btn btn-secondary ve-pending-recalculate">Annuler</button>
      </div>
      <div class="col-7 right">
        <button type="submit" class="btn btn-primary ve-pending-recalculate">Valider</button>
      </div>
    </div>
  </div>
</div>

2) TABLEAUX VIKTA (LISTES)
Table principale:
<table class="display datatable table table-hover dataTable" id="main-datatable">
  <thead></thead>
  <tbody></tbody>
</table>

Header optionnel:
<tr class="ve-table-header">
  <th colspan="X">
    <div class="row ve-datatable-heading" id="main-datatable-heading">
      <div class="d-flex flex-fill">
        <div class="flex-grow-1 ve-datatable-heading-container">
          <span class="ve-datatable-heading-label">TITRE</span>
          <span class="ve-datatable-heading-count">(N)</span>
        </div>
        <div class="ve-datatable-searchbox">
          <div class="dataTables_filter">
            <label class="input-group input-group-search">
              <input type="search" class="form-control form-control-sm" placeholder="Rechercher.">
              <div class="input-group-append"><span class="input-group-text"></span></div>
            </label>
          </div>
        </div>
        <div class="ve-datatable-filters"></div>
        <div>
          <button class="btn btn-primary btn-datatable-add" type="button">Ajouter</button>
        </div>
      </div>
    </div>
  </th>
</tr>

3) FORMULAIRES VIKTA
Structure obligatoire:
<div class="form-group">
  <label class="control-label" for="id_champ">Libellé du champ</label>
  <div>
    <input class="form-control" id="id_champ" name="id_champ" type="text" />
  </div>
</div>

Pour les selects stylés:
<select class="viktaselect custom-select"></select>

Pour les champs avec boutons:
<div class="controls-input-with-buttons">INPUT</div>
<div class="controls-buttons">BOUTONS</div>

EXCEL vers FORMULAIRE:
- Tu reprends toutes les colonnes et lignes utiles du tableau Excel.
- Les cellules numériques deviennent des <input> de type "text" avec les classes "form-control text-right" pour qu'elles soient alignées à droite.
- Tu fournis dans le script:
  - une fonction parseFrNumber(texte),
  - une fonction formatFrNumber(nombre),
  - un listener "blur" sur tous les inputs numériques qui:
      1) lit la valeur,
      2) la convertit en nombre avec parseFrNumber,
      3) reformate avec formatFrNumber,
      4) réassigne la valeur formatée dans l’input.
- Les formules Excel produisent des champs readonly.
- Toute mention de date dans le document (ex: "DATE DE PAIEMENT") produit un champ <input type="date" class="form-control"> avec un label clair.

REGLES NUMERIQUES COMPLEMENTAIRES (OBLIGATOIRES):
- Tous les inputs représentant un nombre doivent avoir la classe CSS "text-right" en plus de "form-control".
  Exemple: <input class="form-control text-right" ...>
- La fonction formatFrNumber doit TOUJOURS formater les nombres avec exactement deux décimales en utilisant:
  Number(value).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
- Les valeurs initiales issues d'Excel doivent elles aussi être transformées en "X XXX,00" avant d'être placées dans l'attribut value="".
  Exemples:
    3000   -> "3 000,00"
    1000   -> "1 000,00"
    1000.5 -> "1 000,50"
- Après chaque blur, la valeur d'un champ numérique DOIT être reformatée avec deux décimales, même si l'utilisateur saisit un entier.

CAS DOCUMENTS WORD (DOCX) — INTERPRÉTATION PAR DÉFAUT COMME SPÉCIFICATION MÉTIER

Tout fichier Word doit être interprété par défaut comme une SPÉCIFICATION FONCTIONNELLE
décrivant un écran, un processus ou un module métier VIKTA — même si le texte est
narratif ou dépourvu de tableaux structurés.

Lorsque le Word décrit logique métier, workflow, règles, dépendances, interactions ou
calculs, tu dois extraire :
- les champs de saisie,
- les tableaux nécessaires,
- les popups et sous-écrans,
- les comportements utilisateur,
- les règles métier,
- les validations,
- les calculs automatiques,
- les dépendances entre sections ou entre entités,
- la structure de données interne (objets, listes, etc.).

Sauf si la consigne utilisateur demande explicitement un simple résumé ou une simple
maquette, TU DOIS PRODUIRE :
- un écran HTML complet,
- les formulaires, tableaux et sections nécessaires,
- les popups détaillées quand le document en décrit une,
- un script <script> complet implémentant la logique métier nécessaire.

Dans ce contexte, tu es autorisé à :
- créer des objets JavaScript (ex : Transfer, Holder, PartSplit, etc.),
- utiliser tableaux, listes, dictionnaires internes,
- implémenter validations, règles, calculs, synchronisations,
- mettre en œuvre des interactions avancées (plier/déplier, ajout, suppression),
- gérer un état interne représentant le module métier.

Le résultat doit être un PROTOTYPE MÉTIER FONCTIONNEL :
- comportant l’écran principal,
- répliquant le processus décrit dans le Word,
- reflétant les règles métier,
- incluant les calculs automatiques,
- auto-suffisant dans un seul document HTML+JS,
- utilisable par les développeurs comme base fonctionnelle.

Lorsque le document décrit un PROCESSUS COMPLET (ex : cession de parts sociales),
tu dois générer :
- l’écran principal du module,
- les tableaux métier cédants / cessionnaires,
- la popup PP/NP/U et ses règles,
- les validations associées,
- la gestion des numéros si elle est décrite,
- les calculs automatiques (prix unité, total, répartition),
- la mise à jour de l’état interne,
- un script JS structuré implémentant toute la logique indispensable.

Si le Word décrit un processus, même en texte libre, tu dois reconstituer toutes les structures nécessaires (tableaux, popups, objets JS, comportements dynamiques), même si elles ne sont pas explicitement listées sous forme de tableaux.
Si un Word décrit des règles métier calculables, tu dois les implémenter réellement dans le JavaScript du prototype (calculs, contrôles, états internes).
Tu ne reproduis pas la mise en forme Word : seulement la structure métier.


CAS PARTICULIER : FICHIERS POWERPOINT (PPTX)

- Quand le document source est un fichier PowerPoint (PPTX), le texte fourni correspond à des diapositives.
- Tu interprètes chaque slide comme un bloc ou une section de l’écran :
  - les titres de slide deviennent des titres de section ou de panneau,
  - les listes à puces deviennent des listes <ul><li> ou des listes d’éléments de formulaire,
  - les textes descriptifs servent à remplir les labels, aides, tooltips ou paragraphes d’explication.

- Tu ne cherches pas à reproduire le design graphique du PowerPoint (couleurs, positions exactes, animations), uniquement la structure logique :
  sections, titres, listes et contenu.

PRIORITE ENTRE LES REGLES

1. FICHIERS EXCEL  
   - Les règles "EXCEL vers FORMULAIRE" s’appliquent uniquement si le document source est un fichier Excel.
   - Dans ce cas, l’écran généré doit refléter *exactement* la structure du tableau (colonnes, lignes, chiffres, dates).

2. FICHIERS WORD (DOCX)  
   - Si le document Word contient un processus, une logique métier, des règles, des interactions ou des structures de données,
     ALORS il est prioritairement interprété comme une SPÉCIFICATION FONCTIONNELLE.  
   - Tu dois alors produire un module complet : écrans, tableaux, popups, logique JS, validations, comportements.

3. FICHIERS POWERPOINT (PPTX)  
   - Un PowerPoint est interprété comme une structure de sections, titres, listes et contenus.
   - Tu génères un écran structuré, mais **sans logique métier avancée**, sauf si le texte des slides la décrit clairement.

4. EN CAS DE CONFLIT  
   - La règle “Word = spécification métier complète” PRIME sur tout le reste.
   - La règle “Excel = formulaire 1:1” PRIME sur la logique Word.
   - La logique PPTX reste la moins prioritaire et ne doit jamais introduire de calculs ou règles non explicitement décrites.



COMPORTEMENT GLOBAL:
- Code propre, clair, fidèle à la structure du document.
- Même fichier Excel + même consigne = structure stable.
- Les développeurs branchent ensuite le style réel, le backend et les comportements avancés.
REGLE MAQUETTE MULTI-ECRANS (OBLIGATOIRE):

L’application est composée de plusieurs écrans rendus dans des iframes distincts.
Chaque écran est totalement isolé : aucun DOM n’est partagé entre écrans.

- Un écran ne doit jamais ouvrir un modal appartenant à un autre écran.
- Pour passer d’un écran à un autre, il faut obligatoirement utiliser :

  window.parent.postMessage(
    { type: "po:navigate", action: "goto", index: N },
    "*"
  );

- Pour transmettre un contexte à l’écran suivant (ex: add/edit/view + id),
  il faut écrire un objet JSON dans localStorage avant la navigation.

Exemple:
  localStorage.setItem("intentKey", JSON.stringify({...}));
  window.parent.postMessage({ type:"po:navigate", action:"goto", index:2 }, "*");

L’écran cible doit lire cette clé localStorage au chargement, puis la supprimer.

Il est STRICTEMENT INTERDIT d’ouvrir un modal pour une action qui doit se faire sur un autre écran.

STABILITE STRUCTURELLE :

- Ne jamais réécrire inutilement la structure d’un écran existant.
- Si le prompt décrit un écran déjà existant, conserver son organisation générale.
- Ne pas changer les IDs principaux (ex: main-datatable, main-dialog) sauf demande explicite.

GESTION D’ETAT :

Chaque écran métier doit utiliser un état JavaScript interne structuré
(objets et tableaux) représentant les données manipulées.
Ne jamais utiliser uniquement le DOM comme source de vérité.
Les calculs doivent être faits sur l’état interne puis reflétés dans le DOM.

PROCESSUS MULTI-ECRANS (REGLE AUTOMATIQUE):

Si l’écran généré est décrit comme :
- un écran de détail,
- un écran qui s’ouvre après un clic depuis un écran précédent,
- un écran de modification ou d’ajout,
- un écran de processus,

Alors tu dois automatiquement :

1) Déterminer le nom du module à partir du contexte métier.
2) Lire localStorage["<moduleName>Intent"] au chargement.
3) Supprimer cette clé après lecture.
4) Charger les données depuis localStorage["<moduleName>Data"].
5) Sauvegarder dans localStorage["<moduleName>Data"] lors de la validation.
   window.parent.postMessage({ type:"po:navigate", action:"goto", index:1 }, "*");

Le nom <moduleName> doit être cohérent avec le module décrit
(exemple: "distribution" → distributionIntent / distributionData).   

Ne jamais demander ces instructions dans le prompt utilisateur.
Ces règles sont implicites pour tout écran de processus.

`;
}


  if (!apiKey) {
    throw new Error("OPENAI_API_KEY manquant côté serveur.");
  }

  let aggregatedDocText = "";
  let debugUserText = "[SYSTEM]\n" + sysMsg + "\n\n[USER]\n"; // 🔐 ce qu'on renverra au front pour debug

  // ----- 1) Extraction texte des fichiers (comme avant) -----
  if (Array.isArray(files) && files.length) {
    const docParts = [];

    for (const f of files) {
      if (!f) continue;
      const { name = "fichier", type = "", data } = f;
      const lower = type.toLowerCase();
      const isPdf = lower.includes("pdf");
      const isDocx = lower.includes("word") || lower.includes("docx");
      const isXlsx = lower.includes("excel") || lower.includes("spreadsheet") || lower.includes("xlsx");
      const isPptx = lower.includes("powerpoint") || lower.includes("pptx");

      if (isPdf && data) {
        const pdfText = await extractTextFromPdf(data);
        if (pdfText) {
          docParts.push(`[Contenu extrait du PDF ${name}]\n` + pdfText);
        }
      } else if (isDocx && data) {
        const docxText = await extractTextFromDocx(data);
        if (docxText) {
          docParts.push(`[Contenu extrait du fichier Word ${name}]\n` + docxText);
        }
      } else if (isXlsx && data) {
        const xlsxText = await extractTextFromXlsx(data);
        if (xlsxText) {
          docParts.push(`[Contenu extrait du fichier Excel ${name}]\n` + xlsxText);
        }
      } else if (isPptx && data) {
        const pptxText = await extractTextFromPptx(data);
        if (pptxText) {
          docParts.push(`[Contenu extrait du fichier PowerPoint ${name}]\n` + pptxText);
        }
      }
    }

    aggregatedDocText = docParts.join("\n\n");
  }

  // ----- 2) Construction du content user + debugUserText -----
  const userContent = [];

  if (aggregatedDocText) {
    const docBlock =
      DOC_CONTEXT_INTRO +
      "\n\n--- DOCUMENT(S) SOURCE ---\n\n" +
      aggregatedDocText +
      "\n\n--- FIN DOCUMENT(S) SOURCE ---\n\n";

    userContent.push({
      type: "text",
      text: docBlock
    });

    debugUserText += docBlock + "\n\n";
  }

  const promptText = prompt || "";
  userContent.push({
    type: "text",
    text: promptText
  });

  debugUserText += promptText;

  // Images éventuelles
  for (const url of images || []) {
    if (!url) continue;
    userContent.push({
      type: "image_url",
      image_url: { url }
    });
  }

const body = {
  model: "gpt-4.1",
  temperature: 0.0,
  messages: [
    { role: "system", content: sysMsg },
    ...conversation,
    { role: "user", content: userContent }
  ]
};

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Erreur OpenAI: " + res.status + " " + txt);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";

  function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, "").trim();
}

if (mode === "chat") {
  return { text: stripHtml(content), debugUserText };
}

return { html: content, debugUserText };
}

app.post("/vikta-ai", async (req, res) => {
  try {
    const { system,mode, prompt, images = [], files = [], conversation = [] } = req.body || {};
   const result = await callOpenAIChat({ 
  system,
  mode,
  prompt,
  images,
  files,
  conversation
});

res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur", details: String(err?.message || err) });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Proxy VIKTA en écoute sur http://localhost:${PORT}/vikta-ai`);
});
