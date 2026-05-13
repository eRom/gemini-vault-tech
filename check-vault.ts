import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
// On récupère le repo actuel pour filtrer l'affichage (optionnel)
const targetRepo = process.env.GITHUB_REPOSITORY;

async function check() {
  console.log("🔍 Analyse de ton Vault global Gemini...");
  if (targetRepo) {
    console.log(`📌 Filtre actif sur le repo : ${targetRepo}\n`);
  }

  let pageToken: string | undefined;
  let count = 0;

  do {
    const response = await ai.files.list({ pageSize: 100, pageToken });
    const files = response.files || [];

    for (const f of files) {
      const repo = f.customMetadata?.find((m) => m.key === "github_repo")?.stringValue;
      const corpus = f.customMetadata?.find((m) => m.key === "vault_corpus")?.stringValue;
      const path = f.customMetadata?.find((m) => m.key === "github_path")?.stringValue;

      // Si GITHUB_REPOSITORY est défini, on ne montre que les fichiers de ce repo
      if (targetRepo && repo !== targetRepo) continue;

      count++;
      console.log(`📄 [${corpus || 'no-corpus'}] ${f.displayName}`);
      console.log(`   ↳ Repo   : ${repo || 'inconnu'}`);
      console.log(`   ↳ Path   : ${path || 'aucun'}`);
      console.log(`   ↳ ID     : ${f.name}\n`);
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  console.log(`✨ Total : ${count} fichiers trouvés.`);
}

check().catch(console.error);
