import express, { Request, Response } from "express";
import { Collection, MongoClient } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const MONGO_URL =
  process.env.MONGO_URL ??
  "mongodb://bookfinder:bookfinderpass@localhost:27017/books?authSource=admin";
const BOOKS_ROOTS = (
  process.env.BOOKS_ROOTS ?? "/media/emilio/1040B01740B0060E1/books"
)
  .split(";")
  .map((p) => p.trim())
  .filter(Boolean);

if (!MONGO_URL) {
  throw new Error("Missing MONGO_URL");
}

if (BOOKS_ROOTS.length === 0) {
  throw new Error("Missing BOOKS_ROOTS");
}

type BookDocument = {
  root: string;
  fullPath: string;
  relativePath: string;
  category: string;
  author: string;
  title: string;
  format: "pdf" | "mobi";
  authorNormalized: string;
  titleNormalized: string;
  searchable: string;
  updatedAt: Date;
};

const app = express();
app.use(express.json());

let booksCollection: Collection<BookDocument>;

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitAuthorAndTitle(
  filePath: string,
  root: string,
): {
  category: string;
  author: string;
  title: string;
  ext: "pdf" | "mobi";
} {
  const relative = path.relative(root, filePath);
  const parts = relative.split(path.sep);

  const category = parts[0] ?? "";
  const author = parts.length >= 3 ? (parts[1] ?? "") : "";
  const filename = parts[parts.length - 1] ?? "";
  const extWithDot = path.extname(filename).toLowerCase();
  const ext = extWithDot.replace(".", "") as "pdf" | "mobi";
  const title = path.basename(filename, extWithDot);

  return { category, author, title, ext };
}

async function walk(dir: string): Promise<string[]> {
  console.log("Walking directory:", dir);
  const output: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      output.push(...(await walk(fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (ext === ".pdf" || ext === ".mobi") {
      output.push(fullPath);
    }
  }

  return output;
}

async function ensureIndexes(): Promise<void> {
  await booksCollection.createIndex({ fullPath: 1 }, { unique: true });
  await booksCollection.createIndex({
    author: "text",
    title: "text",
    category: "text",
    fullPath: "text",
    format: "text",
  });
  await booksCollection.createIndex({ authorNormalized: 1 });
  await booksCollection.createIndex({ titleNormalized: 1 });
}

async function reindexBooks(): Promise<{ indexed: number }> {
  const allDocs: BookDocument[] = [];

  for (const root of BOOKS_ROOTS) {
    const files = await walk(root);

    for (const filePath of files) {
      const { category, author, title, ext } = splitAuthorAndTitle(
        filePath,
        root,
      );

      allDocs.push({
        root,
        fullPath: filePath,
        relativePath: path.relative(root, filePath),
        category,
        author,
        title,
        format: ext,
        authorNormalized: normalizeText(author),
        titleNormalized: normalizeText(title),
        searchable: [category, author, title, ext, filePath].join(" "),
        updatedAt: new Date(),
      });
    }
  }

  if (allDocs.length === 0) {
    return { indexed: 0 };
  }

  const operations = allDocs.map((doc) => ({
    updateOne: {
      filter: { fullPath: doc.fullPath },
      update: { $set: doc },
      upsert: true,
    },
  }));

  for (let i = 0; i < operations.length; i += 1000) {
    console.log(operations);
    await booksCollection.bulkWrite(operations.slice(i, i + 1000), {
      ordered: false,
    });
  }

  return { indexed: allDocs.length };
}

app.get("/", (_req: Request, res: Response) => {
  res.type("html").send(`
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Bookfinder</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 2rem; max-width: 1100px; }
    input { width: 100%; padding: 12px; font-size: 16px; box-sizing: border-box; }
    button { padding: 10px 14px; margin-top: 10px; margin-right: 8px; cursor: pointer; }
    .row { padding: 12px 0; border-bottom: 1px solid #ddd; }
    .meta { color: #666; font-size: 14px; }
    .actions a { margin-right: 12px; }
  </style>
</head>
<body>
  <h1>Bookfinder</h1>
  <p>Busca por autor, título, categoría, formato o ruta.</p>

  <form id="searchForm">
    <input id="q" type="text" placeholder="Ejemplo: César Aira, La villa, pdf..." />
    <button type="submit">Buscar</button>
    <button type="button" id="reindexBtn">Reindexar</button>
  </form>

  <p id="status"></p>
  <div id="results"></div>

  <script>
    const form = document.getElementById("searchForm");
    const qInput = document.getElementById("q");
    const results = document.getElementById("results");
    const status = document.getElementById("status");
    const reindexBtn = document.getElementById("reindexBtn");

    async function search(q) {
      status.textContent = "Buscando...";
      const response = await fetch("/api/search?q=" + encodeURIComponent(q));
      const data = await response.json();

      status.textContent = data.total + " resultado(s)";
      results.innerHTML = data.items.map(item => \`
        <div class="row">
          <div><strong>\${item.author || "Autor desconocido"}</strong> — \${item.title}</div>
          <div class="meta">
            \${item.category || "-"} · \${String(item.format).toUpperCase()}<br/>
            \${item.relativePath}
          </div>
          <div class="actions">
            <a href="/api/file?path=\${encodeURIComponent(item.fullPath)}" target="_blank">Abrir archivo</a>
          </div>
        </div>
      \`).join("");
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await search(qInput.value.trim());
    });

    reindexBtn.addEventListener("click", async () => {
      status.textContent = "Reindexando...";
      const response = await fetch("/api/reindex", { method: "POST" });
      const data = await response.json();
      status.textContent = "Reindexados: " + data.indexed;
    });
  </script>
</body>
</html>
  `);
});

app.get("/api/search", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Number(req.query.limit ?? 50), 200);

  if (!q) {
    const items = await booksCollection
      .find({}, { projection: { _id: 0 } })
      .sort({ author: 1, title: 1 })
      .limit(limit)
      .toArray();

    res.json({ total: items.length, items });
    return;
  }

  const normalized = normalizeText(q);

  const items = await booksCollection
    .find(
      {
        $or: [
          { $text: { $search: q } },
          { authorNormalized: { $regex: normalized, $options: "i" } },
          { titleNormalized: { $regex: normalized, $options: "i" } },
          { fullPath: { $regex: escapeRegex(q), $options: "i" } },
        ],
      },
      {
        projection: {
          _id: 0,
          score: { $meta: "textScore" },
          author: 1,
          title: 1,
          category: 1,
          format: 1,
          fullPath: 1,
          relativePath: 1,
        },
      },
    )
    .sort({ score: { $meta: "textScore" }, author: 1, title: 1 })
    .limit(limit)
    .toArray();

  res.json({ total: items.length, items });
});

app.post("/api/reindex", async (_req: Request, res: Response) => {
  const result = await reindexBooks();
  res.json(result);
});

app.get("/api/file", async (req: Request, res: Response) => {
  const requestedPath = String(req.query.path ?? "");

  if (!requestedPath) {
    res.status(400).send("Missing path");
    return;
  }

  const allowed = BOOKS_ROOTS.some((root) => requestedPath.startsWith(root));
  if (!allowed) {
    res.status(403).send("Forbidden");
    return;
  }

  res.sendFile(requestedPath);
});

async function start(): Promise<void> {
  const client = new MongoClient(MONGO_URL as string);
  await client.connect();

  const db = client.db("books");
  booksCollection = db.collection<BookDocument>("catalog");

  await ensureIndexes();
  await reindexBooks();

  app.listen(PORT, () => {
    console.log(`Bookfinder running on http://localhost:${PORT}`);
  });
}

start().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
