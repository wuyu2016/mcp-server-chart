import type { Request, Response, NextFunction } from "express";
import process from "node:process";
import { logger } from "./logger";

/**
 * Get the MCP API key from environment variables.
 * Returns undefined if not set, meaning auth is disabled.
 */
function getApiKey(): string | undefined {
  const key = process.env.MCP_API_KEY;
  return key && key !== "undefined" ? key : undefined;
}

/**
 * Express middleware that requires a valid API key on all requests.
 * When MCP_API_KEY is not set, all requests pass through (backward compatible).
 * When set, requests must include `Authorization: Bearer <key>`.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const apiKey = getApiKey();

  // No key configured — skip auth (backward compatible)
  if (!apiKey) {
    next();
    return;
  }

  const header = req.headers.authorization;

  if (!header) {
    logger.warn("Missing Authorization header");
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    logger.warn("Invalid Authorization header format");
    res.status(401).json({ error: "Invalid Authorization header format. Expected: Bearer <key>" });
    return;
  }

  if (token !== apiKey) {
    logger.warn("Invalid API key");
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  next();
}