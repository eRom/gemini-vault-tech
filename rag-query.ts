import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });
const corpusName = process.env.VAULT_CORPUS_NAME;

if (!corpusName) {
  throw new Error("🚨 VAULT_CORPUS_NAME manquant (ex: corpora/mon-projet).");
}

const question = process.argv.slice(2).join(" ");

if (!question) {
  console.log("Utilisation : bun run rag-query.ts 'Ta question'");
  process.exit(1);
}

async function queryRag() {
  console.log(
    `📡 [MODE RADAR] Scan vectoriel global (Corpus: ${corpusName})...`,
  );

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Tu es mon architecte technique.
Réponds à la question en cherchant STRICTEMENT dans ton outil de recherche de documents.
Cite TOUJOURS tes sources avec le nom exact du fichier (pour que je puisse l'utiliser plus tard).
Si tu ne trouves pas la réponse, ne l'invente pas.

Question : ${question}`,
          },
        ],
      },
    ],
    tools: [{ retrieval: { corpora: [corpusName] } }],
  });

  console.log("\n══════════════════════════════════\n");
  console.log(response.text);
  console.log("\n══════════════════════════════════");
  console.log(
    "💡 Utilise les sources trouvées avec stuffing-query.ts pour un deep-dive.",
  );
}

queryRag().catch(console.error);
