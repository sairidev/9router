import { loadState, saveState, generateShortId } from "../shared/state.js";
import { spawnQuickTunnel, killCloudflared, isCloudflaredRunning, setUnexpectedExitHandler } from "./cloudflared.js";
import { clearPid } from "./pid.js";
import { waitForHealth, probeUrlAlive } from "./healthCheck.js";
import { WORKER_URL } from "./config.js";
import { getSettings, updateSettings } from "@/lib/localDb";

const svc = {
  cancelToken: { cancelled: false },
  spawnInProgress: false,
  lastRestartAt: 0,
  activeLocalPort: null,
};

export function getTunnelService() { return svc; }
export function isTunnelManuallyDisabled() { return svc.cancelToken.cancelled; }
export function isTunnelReconnecting() { return svc.spawnInProgress; }

let onUnexpectedExit = null;
export function setTunnelUnexpectedExitCallback(cb) { onUnexpectedExit = cb; }

async function registerTunnelUrl(shortId, tunnelUrl) {
  await fetch(`${WORKER_URL}/api/tunnel/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shortId, tunnelUrl })
  });
}

function throwIfCancelled(token) {
  if (token.cancelled) throw new Error("tunnel cancelled");
}

export async function enableTunnel(localPort = 20128) {
  console.log(`[Tunnel] enable start (port=${localPort})`);
  svc.cancelToken = { cancelled: false };
  svc.activeLocalPort = localPort;
  svc.spawnInProgress = true;
  const token = svc.cancelToken;

  try {
    if (isCloudflaredRunning()) {
      const existing = loadState();
      if (existing?.tunnelUrl && existing?.shortId) {
        const publicUrl = `https://r${existing.shortId}.abc-tunnel.us`;
        // Reuse only if BOTH direct + public URL alive (avoid stale socket after network change)
        const [directOk, publicOk] = await Promise.all([
          probeUrlAlive(existing.tunnelUrl),
          probeUrlAlive(publicUrl),
        ]);
        if (directOk && publicOk) {
          console.log(`[Tunnel] already running, reuse: ${existing.tunnelUrl}`);
          return { success: true, tunnelUrl: existing.tunnelUrl, shortId: existing.shortId, publicUrl, alreadyRunning: true };
        }
        // Self-probe means THIS container calling back out to its own tunnel URL over
        // the public internet and looping back in. That round trip can be blocked on
        // hosts with restricted egress (e.g. locked-down Pterodactyl nodes) even while
        // cloudflared itself is fine. In that case trust the PID over the probe instead
        // of tearing down and respawning a tunnel that already works.
        if (!directOk && !publicOk && isCloudflaredRunning()) {
          console.warn("[Tunnel] self-probe unreachable but cloudflared process is alive — reusing anyway");
          return { success: true, tunnelUrl: existing.tunnelUrl, shortId: existing.shortId, publicUrl, alreadyRunning: true };
        }
        console.log(`[Tunnel] stale (direct=${directOk} public=${publicOk}), respawn`);
      }
    }

    killCloudflared(localPort);
    console.log("[Tunnel] killed existing cloudflared");
    throwIfCancelled(token);

    const existing = loadState();
    const shortId = existing?.shortId || generateShortId();

    const onUrlUpdate = async (url) => {
      if (token.cancelled) return;
      console.log(`[Tunnel] url updated: ${url}`);
      await registerTunnelUrl(shortId, url);
      saveState({ shortId, tunnelUrl: url });
      await updateSettings({ tunnelEnabled: true, tunnelUrl: url });
    };

    // Register exit handler BEFORE spawn so it fires even on early exit
    setUnexpectedExitHandler(() => {
      console.warn("[Tunnel] cloudflared exited unexpectedly, scheduling respawn");
      if (onUnexpectedExit) onUnexpectedExit();
    });

    const { tunnelUrl } = await spawnQuickTunnel(localPort, onUrlUpdate);
    console.log(`[Tunnel] spawned: ${tunnelUrl}`);
    throwIfCancelled(token);

    const publicUrl = `https://r${shortId}.abc-tunnel.us`;
    await registerTunnelUrl(shortId, tunnelUrl);
    saveState({ shortId, tunnelUrl });
    await updateSettings({ tunnelEnabled: true, tunnelUrl });
    console.log(`[Tunnel] registered shortId=${shortId} publicUrl=${publicUrl}`);

    // Best-effort self-check only. cloudflared ALREADY reported this URL as live via
    // its own logs — that's the actual signal spawnQuickTunnel waited on, and it comes
    // straight from Cloudflare's edge registering the connection. This extra probe means
    // the container calls back out to its own public URL and loops back in, which can
    // fail on hosts with restricted egress (e.g. locked-down Pterodactyl nodes) even
    // when the tunnel is genuinely working. So: log it, but don't fail "enable tunnel"
    // over a check that isn't the source of truth. A real cancellation still propagates.
    try {
      await waitForHealth(tunnelUrl, token);
      console.log("[Tunnel] direct URL healthy");
    } catch (e) {
      if (e.message === "cancelled") throw e;
      console.warn(`[Tunnel] self-check failed (${e.message}) — continuing, cloudflared already reported the tunnel live`);
    }
    // Vanity/public URL (abc-tunnel.us) is a separate, third-party worker
    // layered on top purely for a nicer URL. It's best-effort: if that
    // service is slow/unreachable, don't fail the whole tunnel over it —
    // the user still has a working dashboard via the direct URL.
    if (!(await probeUrlAlive(publicUrl))) {
      console.warn("[Tunnel] public (vanity) URL not reachable, continuing via direct URL");
    } else {
      console.log("[Tunnel] public URL healthy");
    }

    console.log("[Tunnel] enable success");
    return { success: true, tunnelUrl, shortId, publicUrl };
  } catch (e) {
    // Suppress noise when spawn was deliberately killed (restart/disable superseded it)
    if (!/cloudflared killed|tunnel cancelled/.test(e.message)) {
      console.error(`[Tunnel] enable error: ${e.message}`);
    }
    throw e;
  } finally {
    svc.spawnInProgress = false;
  }
}

export async function disableTunnel() {
  console.log("[Tunnel] disable");
  // Abort any in-flight enable so it cannot resurrect state after we clear it
  svc.cancelToken.cancelled = true;
  setUnexpectedExitHandler(null);

  try { killCloudflared(svc.activeLocalPort); } catch (e) { console.warn(`[Tunnel] kill warn: ${e.message}`); }
  clearPid();

  const state = loadState();
  if (state) saveState({ shortId: state.shortId, tunnelUrl: null });

  await updateSettings({ tunnelEnabled: false, tunnelUrl: "" });
  // Force-clear flags so a subsequent enable is not blocked by a stuck spawnInProgress
  svc.spawnInProgress = false;
  svc.activeLocalPort = null;
  return { success: true };
}

export async function getTunnelStatus() {
  const settings = await getSettings();
  const settingsEnabled = settings.tunnelEnabled === true;
  const state = loadState();
  const shortId = state?.shortId || "";
  const publicUrl = shortId ? `https://r${shortId}.abc-tunnel.us` : "";
  const tunnelUrl = state?.tunnelUrl || "";

  // Lazy: skip PID probe entirely when user disabled tunnel
  const running = settingsEnabled ? isCloudflaredRunning() : false;

  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    tunnelUrl,
    shortId,
    publicUrl,
    running
  };
}
