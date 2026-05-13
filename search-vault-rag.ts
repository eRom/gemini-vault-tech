import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });

const rawArgs = process.argv.slice(2);
const question = rawArgs.join(" ");

if (!question) {
  console.log("Utilisation : bun run search-vault-rag.ts 'Ta question'");
  process.exit(1);
}

async function searchManagedRag() {
  // L'identifiant de ta base vectorielle (créée lors de l'ingestion)
  const corpusName = process.env.VAULT_CORPUS_NAME;

  if (!corpusName) {
    throw new Error(
      "🚨 VAULT_CORPUS_NAME manquant (ex: corpora/mon-projet). Requis pour le RAG managé.",
    );
  }

  console.log(
    `🔍 Interrogation du moteur vectoriel Google (Corpus: ${corpusName})...`,
  );

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Tu es mon assistant technique.
Réponds à la question suivante en cherchant STRICTEMENT dans le corpus fourni via tes outils.
Cite toujours tes sources avec le nom du fichier.
Si l'information n'est pas dans tes outils de recherche, dis-le clairement sans inventer.

Question : ${question}`,
          },
        ],
      },
    ],
    // 🔥 C'est ici que le Stuffing meurt :
    // On ne passe plus de fichiers dans 'contents', on donne juste l'accès au store.
    tools: [
      {
        retrieval: {
          corpora: [corpusName],
        },
      },
    ],
  });

  console.log("══════════════════════════════════\n");
  console.log(response.text);
  console.log("\n══════════════════════════════════");
}

searchManagedRag().catch(console.error);
