import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const corpusName = process.env.VAULT_CORPUS_NAME;
const targetRepo = process.env.GITHUB_REPOSITORY;
const dryRun = !process.argv.includes("--confirm");

const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

const extractMeta = (doc: any) => {
  let repo: string | undefined;
  let path: string | undefined;
  for (const m of doc.customMetadata || []) {
    if (m.key === "repo") repo = m.stringValue;
    if (m.key === "path") path = m.stringValue;
  }
  if (!repo || !path) {
    const legacy = parseDisplayName(doc.displayName);
    if (legacy) {
      repo = repo || legacy.repo;
      path = path || legacy.path;
    }
  }
  return { repo, path };
};

async function findStore(displayName: string): Promise<string | null> {
  const pager = await ai.fileSearchStores.list({ config: { pageSize: 100 } });
  for await (const s of pager) {
    if (s.displayName === displayName) return s.name!;
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

  const storeName = await findStore(corpusName);
  if (!storeName) {
    console.log(`✨ Aucun store "${corpusName}" — rien à nettoyer.`);
    return;
  }

  const docsToDelete: { name: string; path: string }[] = [];

  console.log(`🔍 Scan du store ${corpusName}...`);
  try {
    const docPager = await ai.fileSearchStores.documents.list({
      parent: storeName,
      config: { pageSize: 100 },
    });
    for await (const d of docPager) {
      const meta = extractMeta(d);
      if (meta.repo === targetRepo && meta.path) {
        docsToDelete.push({ name: d.name!, path: meta.path });
      }
    }
  } catch (e: any) {
    console.log(`⚠️  Lecture du store impossible : ${e.message}`);
    return;
  }

  if (docsToDelete.length === 0) {
    console.log("✨ Aucun document trouvé pour ce projet. Le Vault est propre.");
    return;
  }

  console.log(`\n🗑️  Cibles : ${docsToDelete.length} document(s) à supprimer.`);

  if (dryRun) {
    docsToDelete.slice(0, 10).forEach((d) => console.log(`   - ${d.path}`));
    if (docsToDelete.length > 10)
      console.log(`   ... et ${docsToDelete.length - 10} autres`);
    console.log(
      "\n🛑 Fin du Dry-Run. Lance avec `bun run clean-vault.ts --confirm` pour détruire.",
    );
    return;
  }

  console.log("\n🚀 Exécution de la purge...");
  for (const d of docsToDelete) {
    try {
      await ai.fileSearchStores.documents.delete({ name: d.name });
      console.log(`✅ Supprimé : ${d.path}`);
    } catch (e: any) {
      console.error(`❌ Échec sur ${d.path} : ${e.message}`);
    }
  }

  console.log("\n✨ Nettoyage terminé.");
}

cleanVault().catch(console.error);
