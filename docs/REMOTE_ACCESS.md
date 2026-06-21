# Remote access — reach your fleet from your phone, anywhere

You run FOREMAN on your computer. You want to monitor and steer it from your phone while you're
out. This guide gets you there **securely and self-hosted** — no dependency on anyone else to
host a service for you.

> **Read this first.** FOREMAN launches coding agents that **execute shell commands**. The
> dashboard is, in effect, a **remote-code-execution control panel** for your machine. Treat its
> URL and token like SSH access. That single fact drives every recommendation below.

---

## TL;DR

```bash
# one-time: install Tailscale (free, personal use) on your computer AND your phone, then:
tailscale up

# then, any time you want remote access:
foreman serve            # in one terminal (the daemon)
foreman tunnel           # in another — prints an HTTPS URL + a QR code
```

Scan the QR with your phone (while it's signed into your Tailscale account) and you're in — over
real HTTPS, on a **private network only you can see**. Stop sharing with `foreman tunnel --off`.

---

## Why Tailscale is the default (and recommended) path

[Tailscale](https://tailscale.com) builds a private, encrypted WireGuard mesh (a "tailnet")
between *your* devices. Your phone and computer join the same tailnet and can reach each other
directly — even when the phone is on cellular across the country — but **nothing else on the
internet can**.

`foreman tunnel` runs `tailscale serve`, which:

- proxies `https://your-machine.your-tailnet.ts.net` → `http://127.0.0.1:7777` (the daemon stays
  loopback-bound; Tailscale terminates TLS),
- provisions a **real Let's Encrypt certificate automatically** (no cert files, no renewals),
- is reachable **only by devices on your tailnet** — it is never exposed to the public internet.

That checks every box: works from anywhere, real HTTPS (which also unlocks installing the PWA and
Web Push on your phone), zero cert management, and **self-hosted** — you run the daemon; Tailscale
is just the network. Want zero third parties at all? Tailscale's control plane can be self-hosted
with [Headscale](https://github.com/juanfont/headscale) — the same `tailscale serve` flow applies.

It's **free** for personal use (the Personal plan covers far more devices than you'll need).

### Step by step

1. **Install Tailscale** on your computer and your phone: <https://tailscale.com/download>. Sign
   both into the *same* account.
2. On the computer: `tailscale up` (once).
3. Enable HTTPS certs for your tailnet once, in the admin console: **DNS → HTTPS Certificates →
   Enable**. (Tailscale will prompt/he­lp the first time `serve` needs a cert.)
4. Run the daemon and the tunnel:
   ```bash
   foreman serve
   foreman tunnel
   ```
5. **Scan the QR** on your phone. It opens `https://your-machine…ts.net/?token=…`, stores the token
   locally, and scrubs it from the address bar. You're signed in.
6. Optional but recommended behind a proxy: set `dashboard.trust_proxy: true` in `foreman.yaml`
   (or `FOREMAN_TRUST_PROXY=true`) so request logging/IP is correct.

Stop exposing it any time with `foreman tunnel --off`.

### Multiple computers

This is the natural Tailscale model and needs no extra work: each machine is its own tailnet node
with its own name, so you get **one HTTPS URL per computer** — `macbook.tailnet.ts.net`,
`desktop.tailnet.ts.net`, etc. Run a FOREMAN daemon on each and `foreman tunnel` on each.

> A *single unified dashboard across machines* (one screen federating several daemons) is a bigger
> feature and isn't built yet — for now it's one URL per computer, which covers the common case.

---

## Why public HTTPS access is OFF by default

It would be easy to ship a "get a public URL" button. We deliberately don't, because of what
FOREMAN *is*:

- The dashboard can **dispatch jobs**, and jobs run **arbitrary shell commands** via the coding
  agent. Access to the panel ≈ access to a shell on your machine.
- Authentication is a **single static bearer token**. That's fine on a private mesh (where the
  network itself is the wall), but for something reachable by the whole internet it's weak: no
  rate-limiting on guesses beyond the token's entropy, no second factor, no per-request identity,
  and if the token ever leaks (a screenshot, a log, a shared URL) it's game over.
- A private tailnet means an attacker has to first be **on your network** — a far stronger
  position than "knows a URL." Defense in depth costs you nothing here.

So the safe, ergonomic, self-hosted default is a **private overlay (Tailscale)**, never a public
endpoint. `foreman tunnel --funnel` exists but refuses to run without an explicit
`--yes-expose-publicly`, and even then we recommend against it without an auth layer in front.

---

## If you *really* want a public URL (do this yourself, carefully)

Sometimes you need a genuinely public URL (sharing with someone not on your tailnet, a webhook,
etc.). Then **put a real authentication layer in front of FOREMAN** — don't rely on the bearer
token alone. Two good self-hosted options:

### Option A — Cloudflare Tunnel + Cloudflare Access (recommended for public)

A public HTTPS URL with **no open ports**, gated behind a login you control (email OTP or SSO).

```bash
# install cloudflared, authenticate, then:
cloudflared tunnel --url http://127.0.0.1:7777
```

For a stable hostname, create a named tunnel mapped to a domain you own, then add a **Cloudflare
Access** policy (Zero Trust → Access → Applications) that requires *your* email to load the app.
Now reaching FOREMAN requires passing Cloudflare's login **before** the request ever hits the
daemon. Set `dashboard.trust_proxy: true`.

### Option B — Caddy + your own domain + dynamic DNS (zero third-party network)

Fully independent: a reverse proxy you run, your domain, your cert.

```caddyfile
# Caddyfile — Caddy auto-provisions a Let's Encrypt cert
foreman.yourdomain.com {
    # add an auth layer in front of an RCE panel — e.g. basic auth:
    basicauth { youruser JDJ... }   # caddy hash-password
    reverse_proxy 127.0.0.1:7777
}
```

Point `foreman.yourdomain.com` at your home IP (use dynamic DNS if it changes), forward port 443
to the Caddy host, and set `dashboard.trust_proxy: true`. This exposes an RCE panel to the public
internet behind exactly the auth you configure — so configure real auth, keep `FOREMAN_TOKEN`
strong, and rotate it if you ever suspect a leak (`foreman secret set FOREMAN_TOKEN`, then restart).

> ⚠️ CGNAT (common on home/cellular ISPs) blocks inbound port-forwarding — another reason the
> Tailscale path is easier: it needs no inbound ports at all.

---

## Hardening checklist (any remote setup)

- Keep the daemon **loopback-bound** (`dashboard.bind: 127.0.0.1`) and let the proxy reach it —
  never bind `0.0.0.0` on an untrusted network.
- Set `dashboard.trust_proxy: true` when (and only when) a trusted proxy sits in front.
- Treat `FOREMAN_TOKEN` like an SSH key. Rotate it if exposed.
- Prefer the **private tailnet** over any public endpoint. Public = add real auth in front.
- Use **strict** policy profiles for jobs you might approve from a phone, where it's easy to
  fat-finger an "allow."
