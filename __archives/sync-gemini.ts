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

  console.log(`🔍 Analyse du Vault [${corpusName}] pour le repo [${githubRepo}]...`);
  const pager = await ai.files.list();
  for await (const file of pager) {
    const meta = parseDisplayName(file.displayName);
    if (meta && meta.repo === githubRepo && meta.corpus === corpusName) {
      totalVaultSizeBytes += Number(file.sizeBytes || 0);
      existingFiles.set(meta.path, file.name!);
    }
  }

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
      const filename = path.split("/").pop();
      const ext = filename?.split(".").pop()?.toLowerCase();

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

      const mimeType = mimeTypes[ext || ""];

      if (!mimeType) {
        console.log(`⚠️  Fichier ignoré (format non supporté ou binaire) : ${path}`);
        continue;
      }

      const uploadRes = await ai.files.upload({
        file: path,
        config: {
          mimeType: mimeType,
          displayName: encodeDisplayName(path),
        },
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
