import { GoogleGenAI } from "@google/genai";

if (!process.env.VAULT_EMBED_API_KEY) {
  throw new Error("🚨 VAULT_EMBED_API_KEY manquante.");
}

const ai = new GoogleGenAI({ apiKey: process.env.VAULT_EMBED_API_KEY });

const rawArgs = process.argv.slice(2);
let sourcesFilter: string[] = [];
let repoFilter: string | undefined;
const questionParts: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--sources" && rawArgs[i + 1]) {
    // Permet de passer plusieurs fichiers séparés par des virgules
    sourcesFilter = rawArgs[++i].split(",").map((s) => s.trim());
  } else if (rawArgs[i] === "--repo" && rawArgs[i + 1]) {
    repoFilter = rawArgs[++i];
  } else {
    questionParts.push(rawArgs[i]);
  }
}

const question = questionParts.join(" ");

// Sécurité anti-burn rate : on exige un filtre pour le Stuffing
if (!question || (sourcesFilter.length === 0 && !repoFilter)) {
  console.log(
    "Utilisation : bun run stuffing-query.ts 'Ta question' --sources 'fichier1.md,fichier2.md' [--repo 'Cruchot']",
  );
  console.log(
    "⚠️  Sécurité : Tu dois cibler au moins une source ou un repo pour éviter de surcharger le contexte.",
  );
  process.exit(1);
}

const parseDisplayName = (displayName?: string) => {
  if (!displayName?.startsWith("vault|")) return null;
  const parts = displayName.split("|");
  if (parts.length !== 4) return null;
  return { corpus: parts[1], repo: parts[2], path: parts[3] };
};

async function queryStuffing() {
  console.log(
    "🔬 [MODE MICROSCOPE] Chargement des fichiers cibles via l'API File...",
  );

  const pager = await ai.files.list();
  const fileParts: { fileData: { fileUri: string; mimeType: string } }[] = [];
  const loadedPaths: string[] = [];

  for await (const f of pager) {
    const meta = parseDisplayName(f.displayName);
    if (!meta) continue;

    // Filtre 1 : Le Repo (Optionnel)
    if (repoFilter && meta.repo !== repoFilter) continue;

    // Filtre 2 : Les Sources exactes (issues du script RAG)
    if (sourcesFilter.length > 0) {
      // On cherche si le chemin du fichier correspond à l'une des sources demandées
      const isMatch = sourcesFilter.some(
        (src) => meta.path.includes(src) || f.displayName?.includes(src),
      );
      if (!isMatch) continue;
    }

    if (f.uri && f.mimeType) {
      fileParts.push({ fileData: { fileUri: f.uri, mimeType: f.mimeType } });
      loadedPaths.push(`[${meta.repo}] ${meta.path}`);
    }
  }

  if (fileParts.length === 0) {
    console.log(
      "🤷 Aucun document ne correspond à ces sources. Vérifie les chemins.",
    );
    return;
  }

  console.log(
    `\n🧠 Injection massive de ${fileParts.length} document(s) dans la RAM de Gemini :`,
  );
  loadedPaths.forEach((p) => console.log(`   - ${p}`));
  console.log("\nAnalyse au mot près en cours...");

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        role: "user",
        parts: [
          ...fileParts,
          {
            text: `Tu es mon architecte technique.
Voici les documents bruts intégraux.
Réponds à la question suivante en te basant STRICTEMENT sur ces documents.
Si tu utilises une information, cite la source.

Question : ${question}`,
          },
        ],
      },
    ],
  });

  console.log("\n══════════════════════════════════\n");
  console.log(response.text);
  console.log("\n══════════════════════════════════");
}

queryStuffing().catch(console.error);
