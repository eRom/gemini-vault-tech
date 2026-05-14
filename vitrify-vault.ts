import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const corpusName = process.env.VAULT_CORPUS_NAME;

// Le flag de sécurité
const dryRun = !process.argv.includes("--confirm");

async function vitrifyVault() {
  console.log(`☢️  PROCÉDURE DE VITRIFICATION (RESET TOTAL) ☢️`);

  if (dryRun) {
    console.log(
      "⚠️  MODE DRY-RUN : Simulation uniquement. Rien ne sera supprimé.",
    );
    console.log(
      "👉 Pour exécuter réellement : bun run vitrify-vault.ts --confirm\n",
    );
  } else {
    console.log("🔥 MODE DESTRUCTION ACTIVÉ.\n");
  }

  const filesToDelete: { name: string; displayName: string }[] = [];
  const docsToDelete: { name: string; displayName: string }[] = [];

  // --- 1. Râtissage de l'API File (Toutes les sources) ---
  console.log("🔍 Scan du File Store global...");
  const filePager = await ai.files.list();
  for await (const f of filePager) {
    // On prend tout, avec ou sans le tag "vault|"
    filesToDelete.push({
      name: f.name!,
      displayName: f.displayName || "(sans nom)",
    });
  }

  // --- 2. Râtissage de l'API Corpora (Vector RAG) ---
  if (corpusName) {
    console.log(`🔍 Scan du Vector Store (Corpus: ${corpusName})...`);
    try {
      const docPager = await ai.corpora.documents.list({
        corpus: corpusName,
        pageSize: 100,
      });
      for await (const d of docPager || []) {
        docsToDelete.push({
          name: d.name!,
          displayName: d.displayName || "(sans nom)",
        });
      }
    } catch (e: any) {
      console.log(`   ↳ (Corpus vide ou introuvable : ${e.message})`);
    }
  }

  // --- 3. Bilan ---
  console.log(`\n📊 Bilan des cibles :`);
  console.log(`   - Fichiers à détruire (Stuffing) : ${filesToDelete.length}`);
  console.log(`   - Documents à détruire (RAG)     : ${docsToDelete.length}`);

  if (filesToDelete.length === 0 && docsToDelete.length === 0) {
    console.log("\n✨ Le Vault est déjà totalement vierge.");
    return;
  }

  if (dryRun) {
    console.log("\n🛑 Opération annulée. Le Vault est intact.");
    return;
  }

  // --- 4. Exécution (Point de non-retour) ---
  console.log("\n🚀 Démarrage de l'annihilation...");

  for (const f of filesToDelete) {
    try {
      await ai.files.delete({ name: f.name });
      console.log(`✅ [File] Atomisé : ${f.displayName}`);
    } catch (e: any) {
      console.error(`❌ [File] Résistance sur ${f.displayName} : ${e.message}`);
    }
  }

  if (corpusName) {
    for (const d of docsToDelete) {
      try {
        await ai.corpora.documents.delete({
          corpus: corpusName,
          document: d.name,
        });
        console.log(`✅ [RAG]  Atomisé : ${d.displayName}`);
      } catch (e: any) {
        console.error(
          `❌ [RAG]  Résistance sur ${d.displayName} : ${e.message}`,
        );
      }
    }
  }

  console.log("\n✨ Vitrification terminée. Tu repars d'une feuille blanche.");
}

vitrifyVault().catch(console.error);
