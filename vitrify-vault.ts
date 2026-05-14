import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });

// Flag de sécurité
const dryRun = !process.argv.includes("--confirm");
// Mode encore plus radical : supprimer aussi les FileSearchStores eux-mêmes
const wipeStores = process.argv.includes("--wipe-stores");

async function vitrifyVault() {
  console.log(`☢️  PROCÉDURE DE VITRIFICATION (RESET TOTAL) ☢️`);

  if (dryRun) {
    console.log("⚠️  MODE DRY-RUN : Simulation uniquement.");
    console.log("👉 Pour exécuter : bun run vitrify-vault.ts --confirm");
    console.log("👉 Pour supprimer aussi les stores : --confirm --wipe-stores\n");
  } else {
    console.log("🔥 MODE DESTRUCTION ACTIVÉ.");
    if (wipeStores)
      console.log("💀 Stores eux-mêmes inclus dans la destruction.\n");
    else console.log("");
  }

  const stores: { name: string; displayName: string }[] = [];
  const docsToDelete: {
    name: string;
    displayName: string;
    storeName: string;
  }[] = [];

  console.log("🔍 Scan des FileSearchStores...");
  try {
    const storePager = await ai.fileSearchStores.list({
      config: { pageSize: 100 },
    });
    for await (const s of storePager) {
      stores.push({
        name: s.name!,
        displayName: s.displayName || "(sans nom)",
      });
      try {
        const docPager = await ai.fileSearchStores.documents.list({
          parent: s.name!,
          config: { pageSize: 100 },
        });
        for await (const d of docPager) {
          docsToDelete.push({
            name: d.name!,
            displayName: d.displayName || "(sans nom)",
            storeName: s.displayName || s.name!,
          });
        }
      } catch (e: any) {
        console.log(`   ↳ Store ${s.displayName} illisible : ${e.message}`);
      }
    }
  } catch (e: any) {
    console.log(`   ↳ Scan stores échoué : ${e.message}`);
  }

  console.log(`\n📊 Bilan des cibles :`);
  console.log(`   - Documents à détruire (RAG) : ${docsToDelete.length}`);
  console.log(`   - Stores détectés            : ${stores.length}`);
  if (wipeStores)
    console.log(`   - Stores à supprimer         : ${stores.length}`);

  if (
    docsToDelete.length === 0 &&
    (!wipeStores || stores.length === 0)
  ) {
    console.log("\n✨ Le Vault est déjà totalement vierge.");
    return;
  }

  if (dryRun) {
    console.log("\n🛑 Opération annulée. Le Vault est intact.");
    return;
  }

  console.log("\n🚀 Démarrage de l'annihilation...");

  for (const d of docsToDelete) {
    try {
      await ai.fileSearchStores.documents.delete({ name: d.name });
      console.log(`✅ [RAG]  Atomisé : [${d.storeName}] ${d.displayName}`);
    } catch (e: any) {
      console.error(`❌ [RAG]  Résistance sur ${d.displayName} : ${e.message}`);
    }
  }

  if (wipeStores) {
    for (const s of stores) {
      try {
        await ai.fileSearchStores.delete({ name: s.name });
        console.log(`✅ [Store] Atomisé : ${s.displayName}`);
      } catch (e: any) {
        console.error(
          `❌ [Store] Résistance sur ${s.displayName} : ${e.message}`,
        );
      }
    }
  }

  console.log("\n✨ Vitrification terminée. Tu repars d'une feuille blanche.");
}

vitrifyVault().catch(console.error);
