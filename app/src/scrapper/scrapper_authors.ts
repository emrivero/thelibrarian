import fs from "node:fs/promises";
import path from "node:path";
import puppeteer, { Page } from "puppeteer";

const TARGET_URL = "https://ww3.lectulandia.co";
const OUTPUT_FILE = path.resolve("links.txt");

const LETTER_SELECT_SELECTOR = "#secautor select.abcSel";
const RESULTS_CONTAINER_SELECTOR = "#secautor";
const RESULT_LINKS_SELECTOR = "#secautor > div.taxs > ul  a";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type ScrapedLink = {
  letter: string;
  text: string;
  href: string;
};

async function waitForResultsToSettle(
  page: Page,
  timeoutMs = 5000,
): Promise<void> {
  // Espera corta para que se dispare el cambio
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));

  // Espera a que exista el contenedor
  await page.waitForSelector(RESULTS_CONTAINER_SELECTOR, {
    timeout: timeoutMs,
  });

  // Espera adicional para posibles renderizados AJAX
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 800)));
}

async function getLinksForLetter(
  page: Page,
  letter: string,
): Promise<ScrapedLink[]> {
  await page.select(LETTER_SELECT_SELECTOR, letter);

  await waitForResultsToSettle(page);

  const links = await page.$$eval(
    RESULT_LINKS_SELECTOR,
    (anchors, currentLetter) => {
      const items = anchors
        .map((a) => {
          const href = (a as HTMLAnchorElement).href?.trim() ?? "";
          const text = a.textContent?.trim() ?? "";
          return {
            letter: currentLetter as string,
            text,
            href,
          };
        })
        .filter((item) => item.href);

      // quitar duplicados
      const unique = new Map<
        string,
        { letter: string; text: string; href: string }
      >();
      for (const item of items) {
        unique.set(item.href, item);
      }

      return [...unique.values()];
    },
    letter,
  );

  return links;
}

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    headless: true,
    // Si usas Docker/Linux a veces ayuda esto:
    // args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();

    await page.setViewport({ width: 1440, height: 1200 });

    await page.goto(TARGET_URL, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    await page.waitForSelector(LETTER_SELECT_SELECTOR, { timeout: 15000 });

    const allLinks: ScrapedLink[] = [];

    for (const letter of LETTERS) {
      console.log(`Procesando letra ${letter}...`);

      try {
        const links = await getLinksForLetter(page, letter);
        console.log(`  ${links.length} enlaces`);

        allLinks.push(...links);
      } catch (error) {
        console.error(`  Error con la letra ${letter}:`, error);
      }
    }

    // deduplicado global
    const uniqueByHref = new Map<string, ScrapedLink>();
    for (const item of allLinks) {
      uniqueByHref.set(item.href, item);
    }

    const finalLinks = [...uniqueByHref.values()];

    const txt = finalLinks
      .map((item) => `[${item.letter}] ${item.text} -> ${item.href}`)
      .join("\n");

    await fs.writeFile(OUTPUT_FILE, txt, "utf8");

    console.log(`\nGuardados ${finalLinks.length} enlaces en: ${OUTPUT_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
