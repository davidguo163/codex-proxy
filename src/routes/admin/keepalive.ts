/**
 * Admin routes for account keepalive scheduler.
 *
 * GET  /admin/keepalive-status  — current scheduler state + last results
 * POST /admin/keepalive-config  — update account_keepalive config in local.yaml
 * POST /admin/keepalive-run     — trigger an immediate run
 */

import { Hono } from "hono";
import { getConfig, getLocalConfigPath, reloadAllConfigs } from "../../config.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";
import type { KeepaliveScheduler } from "../../auth/keepalive-scheduler.js";

export function createKeepaliveRoutes(scheduler: KeepaliveScheduler): Hono {
  const app = new Hono();

  // Auth guard helper — mirrors pattern in settings.ts
  function checkAuth(authHeader: string | undefined): boolean {
    const key = getConfig().server.proxy_api_key;
    if (!key) return true;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    return token === key;
  }

  app.get("/admin/keepalive-status", (c) => {
    return c.json(scheduler.getStatus());
  });

  app.post("/admin/keepalive-config", async (c) => {
    if (!checkAuth(c.req.header("Authorization"))) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    const body = await c.req.json() as {
      enabled?: boolean;
      mode?: string;
      fixed_times?: string[];
      interval_minutes?: number | null;
      concurrency?: number;
      per_account_delay_ms?: number;
    };

    // Validate mode
    if (body.mode !== undefined && body.mode !== "fixed_times" && body.mode !== "interval") {
      c.status(400);
      return c.json({ error: "mode must be 'fixed_times' or 'interval'" });
    }

    // Validate fixed_times format
    if (body.fixed_times !== undefined) {
      if (!Array.isArray(body.fixed_times)) {
        c.status(400);
        return c.json({ error: "fixed_times must be an array" });
      }
      const bad = body.fixed_times.find((t) => !/^\d{2}:\d{2}$/.test(t));
      if (bad) {
        c.status(400);
        return c.json({ error: `Invalid time format: "${bad}". Use HH:mm` });
      }
    }

    // Validate interval_minutes
    if (body.interval_minutes !== undefined && body.interval_minutes !== null) {
      if (!Number.isInteger(body.interval_minutes) || body.interval_minutes <= 0) {
        c.status(400);
        return c.json({ error: "interval_minutes must be a positive integer" });
      }
    }

    // Validate concurrency
    if (body.concurrency !== undefined) {
      if (!Number.isInteger(body.concurrency) || body.concurrency < 1 || body.concurrency > 20) {
        c.status(400);
        return c.json({ error: "concurrency must be an integer between 1 and 20" });
      }
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.account_keepalive) data.account_keepalive = {};
      const ka = data.account_keepalive as Record<string, unknown>;
      if (body.enabled !== undefined) ka.enabled = body.enabled;
      if (body.mode !== undefined) ka.mode = body.mode;
      if (body.fixed_times !== undefined) ka.fixed_times = body.fixed_times;
      if (body.interval_minutes !== undefined) ka.interval_minutes = body.interval_minutes;
      if (body.concurrency !== undefined) ka.concurrency = body.concurrency;
      if (body.per_account_delay_ms !== undefined) ka.per_account_delay_ms = body.per_account_delay_ms;
    });
    reloadAllConfigs();

    // Restart scheduler with new config
    scheduler.stop();
    scheduler.start();

    return c.json({ success: true, config: getConfig().account_keepalive });
  });

  app.post("/admin/keepalive-run", async (c) => {
    if (!checkAuth(c.req.header("Authorization"))) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    const results = await scheduler.runNow();
    return c.json({ success: true, results });
  });

  return app;
}
