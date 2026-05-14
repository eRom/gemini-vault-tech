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

  // --- 1. Scan de l'API File (Stuffing Store) ---
  console.log("🔍 Scan du File Store...");
  const filePager = await ai.files.list();
  for await (const f of filePager) {
    const meta = parseDisplayName(f.displayName);
    if (meta && meta.repo === targetRepo && meta.corpus === corpusName) {
      filesToDelete.push({ name: f.name!, path: meta.path });
    }
  }

  // --- 2. Scan de l'API Corpora (Vector RAG Store) ---
  console.log("🔍 Scan du Vector Store (Corpora)...");
  try {
    const docPager = await ai.corpora.documents.list({
      corpus: corpusName,
      pageSize: 100,
    });
    for await (const d of docPager || []) {
      const meta = parseDisplayName(d.displayName);
      if (meta && meta.repo === targetRepo && meta.corpus === corpusName) {
        docsToDelete.push({ name: d.name!, path: meta.path });
      }
    }
  } catch (e: any) {
    console.log(`⚠️  Corpus introuvable ou vide : ${e.message}`);
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

  // Suppression côté Files
  for (const f of filesToDelete) {
    try {
      await ai.files.delete({ name: f.name });
      console.log(`✅ [File] Supprimé : ${f.path}`);
    } catch (e: any) {
      console.error(`❌ [File] Échec sur ${f.path} :`, e.message);
    }
  }

  // Suppression côté Corpora
  for (const d of docsToDelete) {
    try {
      await ai.corpora.documents.delete({
        corpus: corpusName,
        document: d.name,
      });
      console.log(`✅ [RAG]  Supprimé : ${d.path}`);
    } catch (e: any) {
      console.error(`❌ [RAG]  Échec sur ${d.path} :`, e.message);
    }
  }

  console.log("\n✨ Nettoyage terminé avec succès.");
}

cleanVault().catch(console.error);
