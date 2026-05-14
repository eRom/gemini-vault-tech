import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.VAULT_EMBED_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey)
  throw new Error("🚨 VAULT_EMBED_API_KEY ou GEMINI_API_KEY manquante.");

const ai = new GoogleGenAI({ apiKey });

// Filtres optionnels via env ou flags --corpus / --repo
const rawArgs = process.argv.slice(2);
let corpusFilter = process.env.VAULT_CORPUS_NAME;
let repoFilter = process.env.GITHUB_REPOSITORY;
const questionParts: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--corpus" && rawArgs[i + 1]) {
    corpusFilter = rawArgs[++i];
  } else if (rawArgs[i] === "--repo" && rawArgs[i + 1]) {
    repoFilter = rawArgs[++i];
  } else {
    questionParts.push(rawArgs[i]);
  }
}

const question = questionParts.join(" ");

if (!question) {
  console.log("Utilisation : bun run search-vault.ts 'Ta question'");
  console.log("Options     : --corpus <nom> --repo <owner/repo>");
  process.exit(1);
}

// Format displayName: "vault|{corpus}|{repo}|{path}"
const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

async function searchVault() {
  console.log("🔍 Récupération des fichiers du Vault...");
  if (corpusFilter) console.log(`   ↳ corpus : ${corpusFilter}`);
  if (repoFilter) console.log(`   ↳ repo   : ${repoFilter}`);

  const pager = await ai.files.list();
  const fileParts: { fileData: { fileUri: string; mimeType: string } }[] = [];
  const filePaths: string[] = [];

  for await (const f of pager) {
    const meta = parseDisplayName(f.displayName);

    if (meta) {
      if (corpusFilter && meta.corpus !== corpusFilter) continue;
      if (repoFilter && meta.repo !== repoFilter) continue;
      filePaths.push(meta.path);
    } else {
      // Fichier legacy (sans prefix vault|) : inclus seulement si aucun filtre actif
      if (corpusFilter || repoFilter) continue;
      filePaths.push(f.displayName || f.name || "unknown");
    }

    if (f.uri && f.mimeType) {
      fileParts.push({ fileData: { fileUri: f.uri, mimeType: f.mimeType } });
    }
  }

  if (fileParts.length === 0) {
    console.log(
      "🤷 Aucun fichier trouvé (vault vide ou filtres trop restrictifs).",
    );
    return;
  }

  console.log(`\n🧠 Gemini analyse ${fileParts.length} document(s) :`);
  filePaths.forEach((p) => console.log(`   - ${p}`));
  console.log();

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        role: "user",
        parts: [
          ...fileParts,
          {
            text: `Tu es mon assistant technique.
Voici les documents de mon projet (Vault).
Réponds à la question suivante en te basant STRICTEMENT sur ces documents.
Cite toujours le nom du fichier source entre crochets (ex: [.cave/architecture.md]).
Si l'information n'est pas dans les documents, dis-le clairement.

Question : ${question}`,
          },
        ],
      },
    ],
  });

  console.log("══════════════════════════════════\n");
  console.log(response.text);
  console.log("\n══════════════════════════════════");
}

searchVault().catch(console.error);
