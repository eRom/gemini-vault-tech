import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const targetRepo = process.env.GITHUB_REPOSITORY;

// Format displayName: "vault|{corpus}|{repo}|{path}"
const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

async function check() {
  console.log("🔍 Analyse de ton Vault global Gemini...");
  if (targetRepo) {
    console.log(`📌 Filtre actif sur le repo : ${targetRepo}\n`);
  }

  let count = 0;
  const pager = await ai.files.list();

  for await (const f of pager) {
    const meta = parseDisplayName(f.displayName);

    if (targetRepo && meta?.repo !== targetRepo) continue;

    count++;
    if (meta) {
      console.log(`📄 [${meta.corpus}] ${meta.path}`);
      console.log(`   ↳ Repo   : ${meta.repo}`);
      console.log(`   ↳ ID     : ${f.name}\n`);
    } else {
      // Fichier sans metadata vault (uploadé avant la migration)
      console.log(`📄 [legacy] ${f.displayName}`);
      console.log(`   ↳ ID     : ${f.name}\n`);
    }
  }

  console.log(`✨ Total : ${count} fichiers trouvés.`);
}

check().catch(console.error);
