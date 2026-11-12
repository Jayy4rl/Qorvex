/**
 * Filesystem locations, resolved from this file rather than the working
 * directory, so the service, scripts and tests behave the same whether they
 * run from the repository root (`npm run demo`) or from `backend/`
 * (`npm run demo -w @qorvex/backend`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** backend/ */
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The repository root (holds .env, data/, contracts/ and frontend/). */
export const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");

/** Resolve a path given in configuration: absolute paths stay as they are, relative ones are relative to the repository root. */
export function fromRepoRoot(p: string): string {
  return path.resolve(REPO_ROOT, p);
}

export const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
export const FIXTURES_DIR = path.join(BACKEND_ROOT, "fixtures");
export const WEB_DIST_DIR = path.join(REPO_ROOT, "frontend", "dist");
