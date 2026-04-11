import { defineWebSocketHandler } from "nitro";
import { spawn, type IPty } from "zigpty";

type Session = { pty: IPty; statsTimer: NodeJS.Timeout };
const sessions = new WeakMap<object, Session>();

const STATS_INTERVAL_MS = 500;

export default defineWebSocketHandler({
  open(peer) {
    const url = new URL(peer.request.url);
    const cols = Number(url.searchParams.get("cols")) || 80;
    const rows = Number(url.searchParams.get("rows")) || 24;

    const pty = spawn(process.env.SHELL || "/bin/bash", [], {
      cols,
      rows,
      cwd: process.env.HOME,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    pty.onData((data) => peer.send(data));
    pty.onExit(({ exitCode }) => {
      peer.send(`\r\n[process exited with code ${exitCode}]\r\n`);
      const s = sessions.get(peer);
      if (s) clearInterval(s.statsTimer);
    });

    const statsTimer = setInterval(() => {
      const stats = pty.stats();
      if (stats) peer.send(JSON.stringify({ type: "stats", stats }));
    }, STATS_INTERVAL_MS);

    sessions.set(peer, { pty, statsTimer });
  },

  message(peer, message) {
    const session = sessions.get(peer);
    if (!session) return;
    const { pty } = session;

    const text = message.text();
    if (text.startsWith("{")) {
      try {
        const msg = JSON.parse(text);
        if (msg.type === "resize") {
          pty.resize(msg.cols, msg.rows);
          return;
        }
        if (msg.type === "input") {
          pty.write(msg.data);
          return;
        }
      } catch {}
    }
    pty.write(text);
  },

  close(peer) {
    const session = sessions.get(peer);
    if (session) {
      clearInterval(session.statsTimer);
      session.pty.kill();
      sessions.delete(peer);
    }
  },

  error(peer) {
    const session = sessions.get(peer);
    if (session) {
      clearInterval(session.statsTimer);
      session.pty.kill();
      sessions.delete(peer);
    }
  },
});
