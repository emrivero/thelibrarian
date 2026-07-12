import axios from "axios";
import * as cheerio from "cheerio";
import { Collection, MongoClient } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

let booksCollection: Collection<BookDocument>;
const INPUT_FILE = path.resolve("links.txt");

const MONGO_URL =
  process.env.MONGO_URL ??
  "mongodb://bookfinder:bookfinderpass@localhost:27017/books?authSource=admin";

async function start(): Promise<void> {
  const client = new MongoClient(MONGO_URL as string);
  await client.connect();

  const db = client.db("books");
  booksCollection = db.collection<BookDocument>("catalog");

  const fileContent = await fs.readFile(INPUT_FILE, "utf-8");
  const links = fileContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line);

  for (const link of links) {
    try {
      const url = new URL(link);
      const response = await axios.get(url.href);

      const $ = cheerio.load(response.data);

      const author = $("header.page-header h1.page-title span")
        .first()
        .text()
        .trim();

      const textTitles = $("div.books-grid article.card a.title")
        .map((_, el) => [$(el).text().replace(/\s+/g, " ").trim()])
        .get();

      const hrefs = $("div.books-grid article.card a.title")
        .map((_, el) => [$(el).attr("href")?.trim() ?? ""])
        .get();

      const titles: string[][] = textTitles.map((title, index) => {
        const href = hrefs[index] || "";
        return [title, href];
      });

      console.log({ author, titles });
      for (const [title, href] of titles) {
        const book = await booksCollection.findOne({
          authorNormalized: author
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
            .trim(),
          titleNormalized: title
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
            .trim(),
        });
        if (!book) {
          await fs.appendFile("missing_books.txt", `${href}\n`);
        }
      }
    } catch (error) {
      console.error(`Error fetching ${link}:`, error);
    }
    await sleep(1000); // Espera 1 segundo entre cada solicitud para no saturar el servidor
  }

  await client.close();
}

start().catch((error) => {
  console.error("Error en el proceso:", error);
  process.exit(1);
});
