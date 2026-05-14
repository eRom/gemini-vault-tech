import fs from "fs";
import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error(
    "🚨 VAULT_EMBED_API_KEY manquante dans les variables d'environnement.",
  );
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const corpusName = process.env.VAULT_CORPUS_NAME || "default";
const githubRepo = process.env.GITHUB_REPOSITORY || "unknown-repo";
const githubRef = process.env.GITHUB_REF_NAME || "main";

// displayName humain-lisible : "vault|{corpus}|{repo}|{path}"
const encodeDisplayName = (path: string) =>
  `vault|${corpusName}|${githubRepo}|${path}`;

// Trouve ou crée le FileSearchStore correspondant au corpus
async function getOrCreateStore(): Promise<string> {
  const pager = await ai.fileSearchStores.list({ config: { pageSize: 20 } });
  for await (const store of pager) {
    if (store.displayName === corpusName) {
      return store.name!;
    }
  }
  console.log(`🆕 Création du FileSearchStore [${corpusName}]...`);
  const created = await ai.fileSearchStores.create({
    config: { displayName: corpusName },
  });
  return created.name!;
}

// Polling LRO (uploadToFileSearchStore retourne une opération longue)
async function awaitOperation(op: any): Promise<any> {
  while (!op.done) {
    await new Promise((r) => setTimeout(r, 2000));
    op = await ai.operations.get({ operation: op });
  }
  if (op.error) {
    throw new Error(
      `LRO failed: ${op.error.message || JSON.stringify(op.error)}`,
    );
  }
  return op;
}

// customMetadata : repo + path stockés pour permettre filtrage et re-fetch GitHub
const buildCustomMetadata = (path: string) => [
  { key: "repo", stringValue: githubRepo },
  { key: "path", stringValue: path },
  { key: "corpus", stringValue: corpusName },
  { key: "ref", stringValue: githubRef },
];

// Fallback legacy : parse repo/path depuis displayName si customMetadata absent
const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

async function syncFiles() {
  const parseList = (envVar?: string) =>
    envVar?.split(" ").filter(Boolean) || [];

  const added = parseList(process.env.ADDED_FILES);
  const modified = parseList(process.env.MODIFIED_FILES);
  const deleted = parseList(process.env.DELETED_FILES);

  const toDelete = [...deleted, ...modified];
  const toUpload = [...added, ...modified];

  if (toDelete.length === 0 && toUpload.length === 0) {
    console.log("💤 Aucun fichier pertinent à synchroniser.");
    return;
  }

  // --- ÉTAPE 0 : RÉSOLUTION DU STORE ---
  const storeName = await getOrCreateStore();
  console.log(`📦 Store actif : ${storeName} (corpus: ${corpusName})`);

  // --- ÉTAPE 1 : INVENTAIRE DES DOCUMENTS EXISTANTS DU REPO ---
  const existingDocs = new Map<string, string>(); // path → documentName

  console.log(
    `🔍 Inventaire des documents du repo [${githubRepo}] dans le store...`,
  );

  try {
    const docPager = await ai.fileSearchStores.documents.list({
      parent: storeName,
      config: { pageSize: 20 },
    });
    for await (const doc of docPager) {
      let docRepo: string | undefined;
      let docPath: string | undefined;
      // 1. lecture customMetadata (préféré)
      for (const m of doc.customMetadata || []) {
        if (m.key === "repo") docRepo = m.stringValue;
        if (m.key === "path") docPath = m.stringValue;
      }
      // 2. fallback parse displayName (rétrocompat)
      if (!docRepo || !docPath) {
        const meta = parseDisplayName(doc.displayName);
        if (meta) {
          docRepo = docRepo || meta.repo;
          docPath = docPath || meta.path;
        }
      }
      if (docRepo === githubRepo && docPath) {
        existingDocs.set(docPath, doc.name!);
      }
    }
  } catch (e: any) {
    console.log(`⚠️  Lecture du store impossible : ${e.message}`);
  }

  // --- ÉTAPE 2 : SUPPRESSIONS ---
  for (const path of toDelete) {
    const docId = existingDocs.get(path);
    if (docId) {
      console.log(`💥 Suppression de l'ancienne version : ${path}`);
      try {
        await ai.fileSearchStores.documents.delete({
          name: docId,
          config: { force: true },
        });
      } catch (e: any) {
        console.error(`❌ Échec suppression ${path} : ${e.message}`);
      }
    }
  }

  // --- ÉTAPE 3 : UPLOAD + INDEXATION (RAG persistant) ---
  let bytesAddedInThisPush = 0;
  let successCount = 0;

  // Extensions supportées (PDF inclus, natif côté FileSearchStore)
  const supportedExts = new Set([
    "md",
    "txt",
    "json",
    "jsonl",
    "pdf",
    "ts",
    "tsx",
    "js",
    "jsx",
    "py",
    "rs",
    "go",
    "csv",
    "xml",
    "yml",
    "yaml",
    "html",
    "css",
    "sh",
    "toml",
  ]);

  for (const path of toUpload) {
    const filename = path.split("/").pop() || "";
    const ext = filename.split(".").pop()?.toLowerCase() || "";

    if (filename === ".gerber-slug") {
      console.log(`⚠️  Fichier de configuration ignoré : ${path}`);
      continue;
    }

    if (!supportedExts.has(ext)) {
      console.log(`⚠️  Fichier ignoré (extension non supportée) : ${path}`);
      continue;
    }

    console.log(`🚀 Indexation : ${path}`);
    try {
      const stats = fs.statSync(path);

      let op = await ai.fileSearchStores.uploadToFileSearchStore({
        file: path,
        fileSearchStoreName: storeName,
        config: {
          displayName: encodeDisplayName(path),
          customMetadata: buildCustomMetadata(path),
        },
      });
      op = await awaitOperation(op);

      bytesAddedInThisPush += stats.size;
      successCount++;
      console.log(`✅ Indexé : ${path}`);
    } catch (e: any) {
      console.error(`❌ Échec indexation ${path} : ${e.message || e}`);
    }
  }

  // --- ÉTAPE 4 : GITHUB STEP SUMMARY ---
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const toMb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(3);

    const report = `
### 📊 Sync Vault [${corpusName}] · ${githubRepo}

| Métrique | Valeur |
| :--- | :--- |
| Fichiers traités | ${toUpload.length} |
| Succès | ${successCount} |
| Suppressions | ${toDelete.length} |
| Volume indexé | ${toMb(bytesAddedInThisPush)} Mo |
| Store | \`${storeName}\` |

> [!TIP]
> RAG managé via FileSearchStore (embeddings persistants, chunking auto, PDF natifs). Pour récupérer le contenu brut d'un doc cité, on fetch depuis GitHub via le \`customMetadata.path\`.
    `;
    fs.appendFileSync(summaryPath, report);
  }
}

syncFiles().catch((err) => {
  console.error("🚨 Erreur critique lors de la synchronisation :", err);
  process.exit(1);
});
