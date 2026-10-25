import express from "express";
import { createAuthRouter } from "./auth.js";
import { openAuthDatabase } from "./db.js";
import { createMarketplaceRouter } from "./marketplace.js";

const app = express();
const port = Number(process.env.PORT || 8787);
const origin = process.env.APP_ORIGIN?.trim() || "http://localhost:5173";
const database = openAuthDatabase();
const authRouter: express.Router = createAuthRouter(database);

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use((request, response, next) => {
  const requestOrigin = request.get("origin");
  if (requestOrigin && requestOrigin !== origin) {
    response.status(403).json({ error: "origin_not_allowed" });
    return;
  }
  if (requestOrigin === origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (request.method === "OPTIONS") {
    response.sendStatus(requestOrigin === origin ? 204 : 403);
    return;
  }
  next();
});
app.get("/", (_request, response) => response.json({
  service: "EventRent API",
  status: "ok",
  health: "/health",
}));
app.get("/health", (_request, response) => response.json({ ok: true }));
app.use("/auth", authRouter);
app.use("/api", createMarketplaceRouter(database));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof SyntaxError && "status" in error && (error as { status?: number }).status === 400) {
    response.status(400).json({ error: "invalid_json" });
    return;
  }
  console.error("Unhandled request error", error);
  response.status(500).json({ error: "internal_server_error" });
});

app.listen(port, () => {
  console.log(`EventRent wallet auth server listening on http://localhost:${port}`);
});
