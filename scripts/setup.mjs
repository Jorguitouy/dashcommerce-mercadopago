#!/usr/bin/env node
/**
 * dashcommerce-mercadopago — interactive install helper.
 *
 * Verifies prerequisites, installs the package, patches astro.config.mjs
 * (dashcommerce() → dashcommerceWithMercadoPago()), and prints the remaining
 * manual steps (credentials + webhook URL).
 *
 * Usage:
 *   bunx dashcommerce-mercadopago-setup        (from your DashCommerce app root)
 *   node scripts/setup.mjs                    (from this repo)
 *
 * Idempotent: safe to re-run. Never touches secrets — credentials are
 * configured in the DashCommerce admin UI, never via CLI flags.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};
const ok = (m) => console.log(`${C.green}✓${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const fail = (m) => console.log(`${C.red}✗${C.reset} ${m}`);
const step = (m) => console.log(`\n${C.bold}${C.cyan}== ${m}${C.reset}`);

let warnings = 0;

// ---------------------------------------------------------------------------
step("1/4 — Checking prerequisites");

// Node / Bun
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) {
  ok(`Node ${process.versions.node}`);
} else {
  warn(`Node ${process.versions.node} — this package requires Node >= 20 (or Bun >= 1.2)`);
  warnings++;
}

// astro.config.mjs present?
const configCandidates = ["astro.config.mjs", "astro.config.ts", "astro.config.js"];
const configPath = configCandidates.find((f) => existsSync(path.resolve(f)));
if (!configPath) {
  fail(`No astro.config.* found in ${process.cwd()}`);
  console.log(`  ${C.dim}Run this script from your DashCommerce app root${C.reset}`);
  process.exit(1);
}
ok(`Found ${configPath}`);

// package.json present + has @dashcommerce/core?
if (!existsSync("package.json")) {
  fail("No package.json — run this from your DashCommerce app root");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
if (deps["@dashcommerce/core"]) {
  ok(`@dashcommerce/core ${deps["@dashcommerce/core"]}`);
} else {
  fail("@dashcommerce/core not found — this is not a DashCommerce app");
  process.exit(1);
}
if (deps.emdash) ok(`emdash ${deps.emdash}`);

// ---------------------------------------------------------------------------
step("2/4 — Installing dashcommerce-mercadopago");

const pm = existsSync("bun.lockb") || existsSync("bun.lock") ? "bun" : "npm";
try {
  execSync(`${pm} ${pm === "bun" ? "add" : "install"} dashcommerce-mercadopago`, {
    stdio: "inherit",
  });
  ok(`Installed with ${pm}`);
} catch {
  fail(`Install failed with ${pm}. Try manually: ${pm} ${pm === "bun" ? "add" : "install"} dashcommerce-mercadopago`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
step("3/4 — Patching astro.config");

const cfg = readFileSync(configPath, "utf8");
const alreadyPatched = /dashcommerceWithMercadoPago/.test(cfg);

if (alreadyPatched) {
  ok("Already using dashcommerceWithMercadoPago() — nothing to do");
} else {
  let patched = cfg;

  // Add the import after the last existing import line.
  const importLine = `import { dashcommerceWithMercadoPago } from "dashcommerce-mercadopago";`;
  if (!patched.includes(importLine)) {
    const lastImport = patched.lastIndexOf(`from "`);
    const lineEnd = patched.indexOf("\n", lastImport);
    patched =
      patched.slice(0, lineEnd + 1) + importLine + "\n" + patched.slice(lineEnd + 1);
  }

  // Swap the plugin registration.
  if (/plugins:\s*\[\s*dashcommerce\(\s*\)\s*,?\s*\]/.test(patched)) {
    patched = patched.replace(
      /plugins:\s*\[\s*dashcommerce\(\s*\)\s*,?\s*\]/,
      "plugins: [dashcommerceWithMercadoPago()]",
    );
    ok("Replaced dashcommerce() with dashcommerceWithMercadoPago()");
  } else if (/dashcommerce\(\s*id\s*:\s*["'][^"']+["']\s*\)/.test(patched)) {
    patched = patched.replace(
      /dashcommerce\(\s*id\s*:\s*(["'][^"']+["'])\s*\)/,
      "dashcommerceWithMercadoPago({ id: $1 })",
    );
    ok("Replaced dashcommerce({id:…}) with dashcommerceWithMercadoPago({id:…})");
  } else {
    warn(`Could not auto-detect the dashcommerce() registration in ${configPath}.`);
    console.log(`  ${C.dim}Patch it manually:${C.reset}`);
    console.log(`  ${C.dim}  import { dashcommerceWithMercadoPago } from "dashcommerce-mercadopago";${C.reset}`);
    console.log(`  ${C.dim}  plugins: [dashcommerceWithMercadoPago()],${C.reset}`);
    warnings++;
  }

  if (patched !== cfg) {
    writeFileSync(configPath, patched);
    ok(`Saved ${configPath}`);
  }
}

// ---------------------------------------------------------------------------
step("4/4 — Remaining manual steps");

console.log(`
${C.bold}Credentials (DashCommerce admin):${C.reset}
  1. Create an app at https://www.mercadopago.com/developers/panel/app
     and copy the Access Token (TEST-… for sandbox, APP_USR-… for production).
  2. In your DashCommerce admin → Settings → Payment Provider → Mercado Pago:
       - Access token:   <your token>
       - Webhook secret: <random string, min 8 chars>
  3. In your MP application settings, set the webhook URL to:
       https://YOUR-DOMAIN/_emdash/api/plugins/dashcommerce/checkout/webhook-mercadopago
     and use the same secret string as the webhook signature secret.
  4. Switch the active provider: admin → Settings → paymentProvider → mercadopago.
     (Stripe stays configured — you can switch back any time.)

${C.bold}Verify:${C.reset}
  ${C.dim}bun run dev, add an item to the cart, and open checkout.${C.reset}
  ${C.dim}With TEST- credentials you land on MP's sandbox checkout.${C.reset}
`);

if (warnings > 0) {
  warn(`${warnings} warning(s) — review the output above.`);
} else {
  ok("All checks passed. Mercado Pago is ready to configure.");
}
