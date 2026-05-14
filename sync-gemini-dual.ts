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

// Format: "vault|{corpus}|{repo}|{path}"
const encodeDisplayName = (path: string) =>
  `vault|${corpusName}|${githubRepo}|${path}`;

const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

// Trouve ou crée le FileSearchStore pour ce corpus (un store = un corpus)
async function getOrCreateStore(): Promise<string> {
  const pager = await ai.fileSearchStores.list({ config: { pageSize: 100 } });
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

// Polling d'une opération longue (LRO)
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

  // --- ÉTAPE 0 : RÉSOLUTION DU FILE SEARCH STORE ---
  const storeName = await getOrCreateStore();
  console.log(`📦 Store actif : ${storeName}`);

  // --- ÉTAPE 1 : ANALYSE DES DEUX BASES (FILES + STORE) ---
  const existingFiles = new Map<string, string>();
  const existingDocs = new Map<string, string>();
  let totalVaultSizeBytes = 0;

  console.log(
    `🔍 Analyse du Vault et du Store [${corpusName}] pour le repo [${githubRepo}]...`,
  );

  // 1A. Analyse Files API (Stuffing)
  const filePager = await ai.files.list();
  for await (const file of filePager) {
    const meta = parseDisplayName(file.displayName);
    if (meta && meta.repo === githubRepo && meta.corpus === corpusName) {
      totalVaultSizeBytes += Number(file.sizeBytes || 0);
      existingFiles.set(meta.path, file.name!);
    }
  }

  // 1B. Analyse FileSearchStore (RAG managé)
  try {
    const docPager = await ai.fileSearchStores.documents.list({
      parent: storeName,
      config: { pageSize: 100 },
    });
    for await (const doc of docPager) {
      const meta = parseDisplayName(doc.displayName);
      if (meta && meta.repo === githubRepo && meta.corpus === corpusName) {
        existingDocs.set(meta.path, doc.name!);
      }
    }
  } catch (e: any) {
    console.log(
      `⚠️  Impossible de lister les documents du store. Erreur ignorée : ${e.message}`,
    );
  }

  // --- ÉTAPE 2 : MUTATIONS (DELETE) ---
  for (const path of toDelete) {
    console.log(`💥 Suppression de l'ancienne version : ${path}`);

    const fileId = existingFiles.get(path);
    if (fileId) {
      try {
        await ai.files.delete({ name: fileId });
      } catch (e) {
        /* ignore */
      }
    }

    const docId = existingDocs.get(path);
    if (docId) {
      try {
        await ai.fileSearchStores.documents.delete({ name: docId });
      } catch (e) {
        /* ignore */
      }
    }
  }

  // --- ÉTAPE 3 : MUTATIONS (DUAL-WRITE : FILES + FILE SEARCH STORE) ---
  let bytesAddedInThisPush = 0;

  for (const path of toUpload) {
    console.log(`🚀 Traitement en cours : ${path}`);
    try {
      const stats = fs.statSync(path);
      const filename = path.split("/").pop();
      const ext = filename?.split(".").pop()?.toLowerCase() || "";

      if (filename === ".gerber-slug") {
        console.log(`⚠️  Fichier de configuration ignoré : ${path}`);
        continue;
      }

      const mimeTypes: Record<string, string> = {
        md: "text/markdown",
        txt: "text/plain",
        json: "application/json",
        jsonl: "application/json",
        pdf: "application/pdf",
        ts: "text/plain",
        js: "text/plain",
        py: "text/plain",
        rs: "text/plain",
        csv: "text/csv",
        xml: "text/xml",
        yml: "text/plain",
        yaml: "text/plain",
      };

      const mimeType = mimeTypes[ext];
      if (!mimeType) {
        console.log(`⚠️  Fichier ignoré (format non supporté) : ${path}`);
        continue;
      }

      const encodedName = encodeDisplayName(path);

      // 3A. Files API (Stuffing brut, microscope)
      const uploadRes = await ai.files.upload({
        file: path,
        config: { mimeType, displayName: encodedName },
      });
      bytesAddedInThisPush += stats.size;

      // 3B. FileSearchStore (RAG managé, chunking + vectorisation auto, PDF natifs)
      let op = await ai.fileSearchStores.uploadToFileSearchStore({
        file: path,
        fileSearchStoreName: storeName,
        config: { displayName: encodedName },
      });
      op = await awaitOperation(op);

      console.log(
        `✅ Succès : ${path} (Files: ${uploadRes.name} | RAG: indexé)`,
      );
    } catch (e) {
      console.error(`❌ Erreur globale sur ${path}:`, e);
    }
  }

  // --- ÉTAPE 4 : GITHUB STEP SUMMARY ---
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const toMb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(3);
    const monthlyCost = (
      (totalVaultSizeBytes / (1024 * 1024 * 1024)) *
      0.1
    ).toFixed(4);

    const report = `
### 📊 Suivi du Vault [${corpusName}] - ${githubRepo}

| Section | Détails | Valeur |
| :--- | :--- | :--- |
| **Push Actuel** | Fichiers traités | ${toUpload.length} |
| | Volume transféré (Files API) | ${toMb(bytesAddedInThisPush)} Mo |
| **Repo dans le Vault** | **Volume Files API** | **${toMb(totalVaultSizeBytes)} Mo** |
| | **Coût Stockage Est.** | **~${monthlyCost} $ / mois** |

> [!TIP]
> **Architecture Hybride :** Files API (Stuffing/microscope) + FileSearchStore (RAG managé, chunking auto, PDF natifs).
    `;
    fs.appendFileSync(summaryPath, report);
  }
}

syncFiles().catch((err) => {
  console.error("🚨 Erreur critique lors de la synchronisation :", err);
  process.exit(1);
});
