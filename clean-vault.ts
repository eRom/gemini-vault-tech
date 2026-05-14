import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const corpusName = process.env.VAULT_CORPUS_NAME;
const targetRepo = process.env.GITHUB_REPOSITORY;

const dryRun = !process.argv.includes("--confirm");

// Format displayName: "vault|{corpus}|{repo}|{path}"
const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

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

async function cleanVault() {
  if (!corpusName || !targetRepo) {
    throw new Error(
      "🚨 VAULT_CORPUS_NAME et GITHUB_REPOSITORY doivent être définis.",
    );
  }

  console.log(`🧹 Nettoyage du Vault pour le projet : [${targetRepo}]`);
  if (dryRun)
    console.log(
      "⚠️  Mode DRY-RUN actif. Ajoute '--confirm' pour exécuter la suppression.\n",
    );

  const filesToDelete: { name: string; path: string }[] = [];
  const docsToDelete: { name: string; path: string }[] = [];

  // --- 1. Scan de la Files API (Stuffing Store) ---
  console.log("🔍 Scan du File Store...");
  const filePager = await ai.files.list();
  for await (const f of filePager) {
    const meta = parseDisplayName(f.displayName);
    if (meta && meta.repo === targetRepo && meta.corpus === corpusName) {
      filesToDelete.push({ name: f.name!, path: meta.path });
    }
  }

  // --- 2. Scan du FileSearchStore (Vector RAG Store) ---
  console.log(`🔍 Scan du Vector Store (Store: ${corpusName})...`);
  const storeName = await findStore();
  if (!storeName) {
    console.log(`   ↳ Aucun store "${corpusName}" — rien à nettoyer côté RAG.`);
  } else {
    try {
      const docPager = await ai.fileSearchStores.documents.list({
        parent: storeName,
        config: { pageSize: 100 },
      });
      for await (const d of docPager) {
        const meta = parseDisplayName(d.displayName);
        if (meta && meta.repo === targetRepo && meta.corpus === corpusName) {
          docsToDelete.push({ name: d.name!, path: meta.path });
        }
      }
    } catch (e: any) {
      console.log(`⚠️  Lecture du store impossible : ${e.message}`);
    }
  }

  // --- 3. Bilan ---
  if (filesToDelete.length === 0 && docsToDelete.length === 0) {
    console.log("✨ Aucun fichier trouvé pour ce projet. Le Vault est propre.");
    return;
  }

  console.log(`\n🗑️  Cibles identifiées :`);
  console.log(`   ↳ ${filesToDelete.length} fichier(s) dans le File Store.`);
  console.log(`   ↳ ${docsToDelete.length} document(s) dans le Vector Store.`);

  if (dryRun) {
    console.log(
      "\n🛑 Fin du Dry-Run. Lance avec `bun run clean-vault.ts --confirm` pour détruire.",
    );
    return;
  }

  // --- 4. Exécution ---
  console.log("\n🚀 Exécution de la purge...");

  for (const f of filesToDelete) {
    try {
      await ai.files.delete({ name: f.name });
      console.log(`✅ [File] Supprimé : ${f.path}`);
    } catch (e: any) {
      console.error(`❌ [File] Échec sur ${f.path} :`, e.message);
    }
  }

  for (const d of docsToDelete) {
    try {
      await ai.fileSearchStores.documents.delete({ name: d.name });
      console.log(`✅ [RAG]  Supprimé : ${d.path}`);
    } catch (e: any) {
      console.error(`❌ [RAG]  Échec sur ${d.path} :`, e.message);
    }
  }

  console.log("\n✨ Nettoyage terminé avec succès.");
}

cleanVault().catch(console.error);
