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

  // --- ÉTAPE 1 : ANALYSE DE L'EXISTANT + FILTRAGE PAR REPO/CORPUS ---
  const existingFiles = new Map<string, string>();
  let totalVaultSizeBytes = 0;
  let pageToken: string | undefined;

  console.log(`🔍 Analyse du Vault [${corpusName}] pour le repo [${githubRepo}]...`);
  do {
    const response = await ai.files.list({ pageSize: 100, pageToken });
    for (const file of response.files || []) {
      const size = Number(file.sizeBytes || 0);
      
      const fileRepo = file.customMetadata?.find((m) => m.key === "github_repo")?.stringValue;
      const fileCorpus = file.customMetadata?.find((m) => m.key === "vault_corpus")?.stringValue;
      const filePath = file.customMetadata?.find((m) => m.key === "github_path")?.stringValue;

      // On ne comptabilise et on ne gère que les fichiers appartenant à ce repo et ce corpus
      if (fileRepo === githubRepo && fileCorpus === corpusName) {
        totalVaultSizeBytes += size;
        if (filePath) {
          existingFiles.set(filePath, file.name);
        }
      }
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  // --- ÉTAPE 2 : MUTATIONS (DELETE / UPLOAD) ---
  let bytesAddedInThisPush = 0;

  for (const path of toDelete) {
    const geminiFileName = existingFiles.get(path);
    if (geminiFileName) {
      console.log(`💥 Suppression de l'ancienne version : ${path}`);
      try {
        await ai.files.delete({ name: geminiFileName });
      } catch (e) {
        console.error(`❌ Échec de la suppression pour ${path}:`, e);
      }
    }
  }

  for (const path of toUpload) {
    console.log(`🚀 Upload en cours : ${path}`);
    try {
      const stats = fs.statSync(path);
      const ext = path.split(".").pop()?.toLowerCase();

      // Mapping des MIME types supportés pour un stockage long terme (Texte & PDF)
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

      const mimeType = mimeTypes[ext || ""];

      if (!mimeType) {
        console.log(`⚠️  Fichier ignoré (format non supporté ou binaire) : ${path}`);
        continue;
      }

      const uploadRes = await ai.files.upload({
        file: path,
        mimeType: mimeType,
        displayName: path.split("/").pop(),
      });

      await ai.files.update({
        name: uploadRes.name,
        customMetadata: [
          { key: "github_path", stringValue: path },
          { key: "github_repo", stringValue: githubRepo },
          { key: "vault_corpus", stringValue: corpusName }
        ],
      });

      bytesAddedInThisPush += stats.size;
      console.log(`✅ Succès : ${path} indexé sous ${uploadRes.name} (${mimeType})`);
    } catch (e) {
      console.error(`❌ Erreur d'upload sur ${path}:`, e);
    }
  }

  // --- ÉTAPE 3 : GÉNÉRATION DU RAPPORT GITHUB STEP SUMMARY ---
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
| | Volume transféré | ${toMb(bytesAddedInThisPush)} Mo |
| **Repo dans le Vault** | **Volume Occupé** | **${toMb(totalVaultSizeBytes)} Mo** |
| | **Coût Stockage Est.** | **~${monthlyCost} $ / mois** |

> [!TIP]
> Ce rapport ne comptabilise que les fichiers liés au repo actuel et au corpus spécifié.
    `;
    fs.appendFileSync(summaryPath, report);
  }
}

syncFiles().catch((err) => {
  console.error("🚨 Erreur critique lors de la synchronisation :", err);
  process.exit(1);
});
