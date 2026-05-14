import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const targetRepo = process.env.GITHUB_REPOSITORY;
const corpusName = process.env.VAULT_CORPUS_NAME;

// Fallback : parse repo/path depuis displayName legacy
const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

const extractMeta = (doc: any) => {
  let repo: string | undefined;
  let path: string | undefined;
  let corpus: string | undefined;
  for (const m of doc.customMetadata || []) {
    if (m.key === "repo") repo = m.stringValue;
    if (m.key === "path") path = m.stringValue;
    if (m.key === "corpus") corpus = m.stringValue;
  }
  if (!repo || !path) {
    const legacy = parseDisplayName(doc.displayName);
    if (legacy) {
      repo = repo || legacy.repo;
      path = path || legacy.path;
      corpus = corpus || legacy.corpus;
    }
  }
  return { repo, path, corpus };
};

async function check() {
  console.log("🔍 Analyse du Vault RAG (FileSearchStores)...");
  if (targetRepo) console.log(`📌 Filtre repo : ${targetRepo}`);
  if (corpusName) console.log(`📌 Filtre corpus : ${corpusName}`);
  console.log("");

  const stores: { name: string; displayName: string }[] = [];
  const pager = await ai.fileSearchStores.list({ config: { pageSize: 100 } });
  for await (const s of pager) {
    if (corpusName && s.displayName !== corpusName) continue;
    stores.push({ name: s.name!, displayName: s.displayName || "(sans nom)" });
  }

  if (stores.length === 0) {
    console.log("🤷 Aucun FileSearchStore trouvé.");
    return;
  }

  let totalDocs = 0;
  let totalMatched = 0;

  for (const store of stores) {
    console.log(`📦 Store : ${store.displayName}  (${store.name})`);
    try {
      const docPager = await ai.fileSearchStores.documents.list({
        parent: store.name,
        config: { pageSize: 100 },
      });
      let storeMatched = 0;
      for await (const doc of docPager) {
        totalDocs++;
        const meta = extractMeta(doc);
        if (targetRepo && meta.repo !== targetRepo) continue;
        storeMatched++;
        totalMatched++;
        console.log(
          `   ↳ [${meta.repo || "?"}] ${meta.path || doc.displayName || doc.name}`,
        );
      }
      console.log(`   ↳ ${storeMatched} document(s) matché(s) dans ce store.\n`);
    } catch (e: any) {
      console.log(`   ⚠️  Lecture impossible : ${e.message}\n`);
    }
  }

  console.log(
    `✨ Total : ${totalMatched} document(s) matché(s) sur ${totalDocs} dans ${stores.length} store(s).`,
  );
}

check().catch(console.error);
