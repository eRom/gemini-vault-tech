import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const targetRepo = process.env.GITHUB_REPOSITORY;
// Nécessaire pour scanner le RAG (un FileSearchStore = un corpus)
const corpusName = process.env.VAULT_CORPUS_NAME;

// Format displayName: "vault|{corpus}|{repo}|{path}"
const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

// État consolidé d'un fichier (présent dans Files API et/ou FileSearchStore)
interface VaultEntry {
  corpus: string;
  repo: string;
  path: string;
  fileId?: string;
  docId?: string;
}

// Cherche le FileSearchStore par displayName (sans le créer)
async function findStore(): Promise<string | null> {
  if (!corpusName) return null;
  const pager = await ai.fileSearchStores.list({ config: { pageSize: 100 } });
  for await (const store of pager) {
    if (store.displayName === corpusName) {
      return store.name!;
    }
  }
  return null;
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

  // --- 1. Scan de la Files API (Stuffing Store) ---
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
      if (!targetRepo) {
        legacyFiles.push({
          name: f.name!,
          displayName: f.displayName || "(sans nom)",
        });
      }
    }
  }

  // --- 2. Scan du FileSearchStore (Vector RAG Store) ---
  if (corpusName) {
    const storeName = await findStore();
    if (!storeName) {
      console.log(
        `⚠️  Aucun FileSearchStore avec le displayName "${corpusName}" trouvé.\n`,
      );
    } else {
      try {
        const docPager = await ai.fileSearchStores.documents.list({
          parent: storeName,
          config: { pageSize: 100 },
        });
        for await (const d of docPager) {
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
          `⚠️  Impossible de lire le FileSearchStore (${corpusName}) : ${e.message}\n`,
        );
      }
    }
  }

  // --- 3. Affichage consolidé ---
  let count = 0;

  for (const [, entry] of entries) {
    count++;
    console.log(`📄 [${entry.corpus}] ${entry.path}`);
    console.log(`   ↳ Repo   : ${entry.repo}`);

    const fileStatus = entry.fileId
      ? `✅ Actif (${entry.fileId})`
      : `❌ Absent`;
    console.log(`   ↳ File   : ${fileStatus}`);

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
