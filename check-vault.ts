import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const targetRepo = process.env.GITHUB_REPOSITORY;
// Nécessaire pour scanner le RAG (car l'API Corpora a besoin de cet ID)
const corpusName = process.env.VAULT_CORPUS_NAME;

// Format displayName: "vault|{corpus}|{repo}|{path}"
const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

// Interface pour stocker l'état consolidé d'un fichier
interface VaultEntry {
  corpus: string;
  repo: string;
  path: string;
  fileId?: string;
  docId?: string;
}

async function check() {
  console.log("🔍 Analyse de ton Vault hybride Gemini...");
  if (targetRepo) console.log(`📌 Filtre actif sur le repo : ${targetRepo}`);
  if (!corpusName)
    console.log(
      `⚠️  VAULT_CORPUS_NAME non défini : l'analyse du Vector Store (RAG) sera ignorée.`,
    );
  console.log("");

  const entries = new Map<string, VaultEntry>();
  const legacyFiles: { name: string; displayName: string }[] = [];

  // --- 1. Scan de l'API File (Stuffing Store) ---
  const filePager = await ai.files.list();
  for await (const f of filePager) {
    const meta = parseDisplayName(f.displayName);

    if (meta) {
      if (targetRepo && meta.repo !== targetRepo) continue;

      const key = `${meta.corpus}|${meta.repo}|${meta.path}`;
      if (!entries.has(key)) entries.set(key, { ...meta });

      entries.get(key)!.fileId = f.name;
    } else {
      // Les fichiers legacy n'ont pas la structure "vault|"
      // On ne les affiche que si on ne filtre pas par repo spécifique
      if (!targetRepo) {
        legacyFiles.push({
          name: f.name!,
          displayName: f.displayName || "(sans nom)",
        });
      }
    }
  }

  // --- 2. Scan de l'API Corpora (Vector RAG Store) ---
  if (corpusName) {
    try {
      const docPager = await ai.corpora.documents.list({
        corpus: corpusName,
        pageSize: 100,
      });
      for await (const d of docPager || []) {
        const meta = parseDisplayName(d.displayName);

        if (meta) {
          if (targetRepo && meta.repo !== targetRepo) continue;

          const key = `${meta.corpus}|${meta.repo}|${meta.path}`;
          if (!entries.has(key)) entries.set(key, { ...meta });

          entries.get(key)!.docId = d.name;
        }
      }
    } catch (e: any) {
      console.log(
        `⚠️  Impossible de lire le Corpus RAG (${corpusName}) : ${e.message}\n`,
      );
    }
  }

  // --- 3. Affichage consolidé ---
  let count = 0;

  for (const [key, entry] of entries) {
    count++;
    console.log(`📄 [${entry.corpus}] ${entry.path}`);
    console.log(`   ↳ Repo   : ${entry.repo}`);

    // Status File Store
    const fileStatus = entry.fileId
      ? `✅ Actif (${entry.fileId})`
      : `❌ Absent`;
    console.log(`   ↳ File   : ${fileStatus}`);

    // Status Vector Store (RAG)
    const ragStatus = entry.docId ? `✅ Actif (${entry.docId})` : `❌ Absent`;
    console.log(`   ↳ RAG    : ${ragStatus}\n`);
  }

  for (const leg of legacyFiles) {
    count++;
    console.log(`📄 [legacy] ${leg.displayName}`);
    console.log(`   ↳ File   : ✅ Actif (${leg.name})`);
    console.log(`   ↳ RAG    : ❌ Non applicable\n`);
  }

  console.log(
    `✨ Total : ${count} éléments uniques trouvés dans le(s) système(s).`,
  );
}

check().catch(console.error);
