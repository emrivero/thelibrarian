import axios from "axios";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";

const INPUT_FILE = "missing_books.txt";
const OUTPUT_FILE = "final_links.txt";

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 15000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(
  url: string,
  maxRetries = MAX_RETRIES,
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`GET ${url} (intento ${attempt}/${maxRetries})`);

      const response = await axios.get<string>(url, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        },
      });

      return response.data;
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) {
        break;
      }

      const delay = BASE_DELAY_MS * attempt;
      console.warn(`Error en GET ${url}. Reintentando en ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

async function getFinalLinks(): Promise<void> {
  const fileContent = await fs.readFile(INPUT_FILE, "utf-8");
  const links = fileContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line);

  for (const link of links) {
    try {
      const url = new URL("https://ww3.lectulandia.co" + link);

      const html = await fetchWithRetry(url.href);
      const $ = cheerio.load(html);

      const finalLink = $("#downloadContainer a").first().attr("href")?.trim();

      if (!finalLink) {
        console.warn(`No se encontró enlace de descarga para ${link}`);
        continue;
      }

      await fs.appendFile(OUTPUT_FILE, `${finalLink}\n`, "utf-8");
      console.log(`OK: ${finalLink}`);

      await sleep(500);
    } catch (error) {
      console.error(`Error fetching ${link}:`, error);
    }
  }
}

getFinalLinks().catch((error) => {
  console.error("Error en getFinalLinks:", error);
});
