import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const corpusName = process.env.VAULT_CORPUS_NAME;

if (!corpusName) {
  throw new Error("🚨 VAULT_CORPUS_NAME manquant.");
}

const rawArgs = process.argv.slice(2);
const jsonOutput = rawArgs.includes("--json");
const repoFilter = (() => {
  const idx = rawArgs.indexOf("--repo");
  return idx >= 0 ? rawArgs[idx + 1] : undefined;
})();
const question = rawArgs
  .filter((a, i, arr) => {
    if (a === "--json") return false;
    if (a === "--repo") return false;
    if (i > 0 && arr[i - 1] === "--repo") return false;
    return true;
  })
  .join(" ");

if (!question) {
  console.log("Utilisation : bun run rag-query.ts 'Ta question' [--repo owner/name] [--json]");
  process.exit(1);
}

const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

async function findStore(): Promise<string> {
  const pager = await ai.fileSearchStores.list({ config: { pageSize: 20 } });
  for await (const store of pager) {
    if (store.displayName === corpusName) {
      return store.name!;
    }
  }
  throw new Error(
    `🚨 Aucun FileSearchStore "${corpusName}" trouvé. Lance d'abord la sync.`,
  );
}

interface Source {
  repo?: string;
  path?: string;
  displayName?: string;
  documentName?: string;
  snippet?: string;
  confidence?: number;
}

function extractSources(response: any): Source[] {
  const chunks =
    response?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const supports =
    response?.candidates?.[0]?.groundingMetadata?.groundingSupports ?? [];

  // confidence max par chunk index
  const maxConfidence = new Map<number, number>();
  for (const sup of supports) {
    const indices: number[] = sup.groundingChunkIndices || [];
    const scores: number[] = sup.confidenceScores || [];
    indices.forEach((idx: number, i: number) => {
      const score = scores[i] ?? 0;
      maxConfidence.set(idx, Math.max(maxConfidence.get(idx) || 0, score));
    });
  }

  const sources: Source[] = [];
  chunks.forEach((chunk: any, idx: number) => {
    const ctx = chunk.retrievedContext;
    if (!ctx) return;

    let repo: string | undefined;
    let path: string | undefined;
    for (const m of ctx.customMetadata || []) {
      if (m.key === "repo") repo = m.stringValue;
      if (m.key === "path") path = m.stringValue;
    }
    if (!repo || !path) {
      const legacy = parseDisplayName(ctx.title);
      if (legacy) {
        repo = repo || legacy.repo;
        path = path || legacy.path;
      }
    }

    sources.push({
      repo,
      path,
      displayName: ctx.title,
      documentName: ctx.documentName,
      snippet: ctx.text?.slice(0, 240),
      confidence: maxConfidence.get(idx),
    });
  });

  // Dédupe par documentName en gardant la meilleure confidence
  const dedup = new Map<string, Source>();
  for (const s of sources) {
    const key = s.documentName || `${s.repo}|${s.path}`;
    const existing = dedup.get(key);
    if (!existing || (s.confidence || 0) > (existing.confidence || 0)) {
      dedup.set(key, s);
    }
  }
  return [...dedup.values()].sort(
    (a, b) => (b.confidence || 0) - (a.confidence || 0),
  );
}

async function queryRag() {
  if (!jsonOutput) {
    console.log(
      `📡 [MODE RADAR] Scan vectoriel (Store: ${corpusName}${repoFilter ? `, repo: ${repoFilter}` : ""})...`,
    );
  }

  const storeName = await findStore();

  const userInstructions = `Tu es mon architecte technique.
Réponds à la question en cherchant STRICTEMENT dans ton outil de recherche de documents.
Cite TOUJOURS tes sources avec le nom exact du fichier.
${repoFilter ? `Filtre tes recherches sur le repo : ${repoFilter}.` : ""}
Si tu ne trouves pas la réponse, ne l'invente pas.

Question : ${question}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: userInstructions }] }],
    config: {
      tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }],
    },
  });

  let sources = extractSources(response);
  if (repoFilter) {
    sources = sources.filter((s) => !s.repo || s.repo === repoFilter);
  }

  const answer = response.text || "";

  if (jsonOutput) {
    console.log(JSON.stringify({ question, answer, sources }, null, 2));
    return;
  }

  console.log("\n══════════════════════════════════\n");
  console.log(answer);
  console.log("\n══════════════════════════════════");
  if (sources.length > 0) {
    console.log(`\n📚 Sources (${sources.length}) :`);
    for (const s of sources) {
      const conf = s.confidence
        ? ` (${(s.confidence * 100).toFixed(0)}%)`
        : "";
      console.log(`   - [${s.repo || "?"}] ${s.path || s.displayName}${conf}`);
    }
  } else {
    console.log("\n🤷 Aucune source citée (réponse non-grounded).");
  }
  console.log(
    "\n💡 Ajoute --json pour piper vers un outil de fetch GitHub.",
  );
}

queryRag().catch(console.error);
