import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const dryRun = !process.argv.includes("--confirm");

async function cleanLegacy() {
  console.log(`🔍 Recherche des fichiers legacy (sans format vault|...)...`);
  if (dryRun) console.log("⚠️  Mode dry-run — passe --confirm pour supprimer réellement\n");

  const pager = await ai.files.list();
  const toDelete: { name: string; displayName: string }[] = [];

  for await (const f of pager) {
    if (!f.displayName?.startsWith("vault|")) {
      toDelete.push({ name: f.name!, displayName: f.displayName || "(sans nom)" });
    }
  }

  if (toDelete.length === 0) {
    console.log("✨ Aucun fichier legacy trouvé.");
    return;
  }

  console.log(`🗑️  ${toDelete.length} fichier(s) legacy à supprimer :\n`);
  for (const f of toDelete) {
    console.log(`   ${f.displayName}  (${f.name})`);
  }

  if (dryRun) {
    console.log(`\n→ Relance avec --confirm pour supprimer.`);
    return;
  }

  console.log("\n🚀 Suppression en cours...");
  for (const f of toDelete) {
    try {
      await ai.files.delete({ name: f.name });
      console.log(`✅ Supprimé : ${f.displayName}`);
    } catch (e: any) {
      console.error(`❌ Échec : ${f.displayName} — ${e?.message}`);
    }
  }
  console.log("\n✨ Nettoyage terminé.");
}

cleanLegacy().catch(console.error);
