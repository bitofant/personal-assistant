# Remote access: Mac → server over HTTPS

Status: bind address **built** (`server.host`); HTTPS access **planned, not built**. The Mac currently reaches the server through a manual SSH tunnel (`ssh -N -L 4200:localhost:4200 <devbox>` → `http://localhost:4200`, see `osx/CHECKLIST.md` step 4). That's fine for the first Mac session. The daemon (`pa run`, roadmap item 8) needs something permanent: it runs unattended from launchd, on any network, and nobody is around to open a tunnel.

## Requirements

- **HTTPS with a publicly trusted cert.** `pa` only accepts `https://`, or `http://` to loopback (`parseServerURL`). It uses `URLSession` with default trust, so there's no pinning and no custom CA. A self-signed cert would need a CA installed on the (work) Mac, so it's out.
- **Works unattended.** No per-session login, no browser-based SSO step in front of `/api/device/*`. The device authenticates with its bearer token only.
- **Transcripts stay private.** They're work meetings, so plaintext should only exist on the Mac and the dev box. Prefer end-to-end TLS/WireGuard over a CDN that terminates TLS.
- **Minimal attack surface.** The server has no login rate limiting and allows open signup (accounts start disabled), so it isn't hardened for the public internet yet.
- **Uploads up to 20 MB** (server body limit) must pass through the proxy.
- **Offline is OK.** The daemon's upload queue (planned) retries until the server is reachable, so "reachable only from some networks" delays uploads but doesn't lose data.

## Current state of the dev box (checked 2026-09-26)

- **Bind address:** before `server.host` existed, `server.listen(PORT)` bound every interface, so plain HTTP (passwords, cookies, device tokens) was reachable from the LAN. It now defaults to `127.0.0.1`. See [Bind address](#bind-address-built).
- Ports 80/443 already belong to the `webserver_nginx` Docker container (`~/src/webserver`). It has a Let's Encrypt wildcard cert for `*.riuna.com` / `*.riuna.de` (DNS-01 via the Cloudflare API, auto-renewed by certbot) and reverse-proxies other apps via `host.docker.internal` (= Docker host gateway, `172.17.0.1`).
- `cloudflared` runs as a system service (Cloudflare Tunnel) and publishes some of those nginx vhosts to the internet (e.g. `agents.riuna.com` → agent-remote on :4000).
- Tailscale and Caddy aren't installed.
- Sibling services: agent-remote on `*:4000` (all interfaces), another service on `127.0.0.1:4100`.

## Options

| | Reach from | Who sees plaintext | Cert | Server binds | Extra software | Verdict |
|---|---|---|---|---|---|---|
| **A. Tailscale `serve`** | anywhere (tailnet only) | Mac + dev box | `*.ts.net` LE cert, auto | `127.0.0.1` | Tailscale on box + Mac | **Recommended**, if the work Mac allows Tailscale |
| **B. Existing nginx, LAN-only hostname** | home LAN only | Mac + dev box | existing `*.riuna.com` wildcard | `172.17.0.1` (docker0) | none | **Fallback**: zero new software, uploads wait until you're home |
| C. Existing nginx + Cloudflare Tunnel (public) | anywhere (internet) | + Cloudflare | existing | `172.17.0.1` | none | Not now: Cloudflare terminates TLS on work transcripts, and the server isn't hardened for the internet |
| D. Caddy | depends | depends | Caddy ACME | `127.0.0.1` | Caddy | Rejected: :443 is already nginx's, and nginx already has a renewing wildcard cert. Caddy would only duplicate that |
| E. Permanent SSH tunnel (`autossh` LaunchAgent) | wherever sshd is reachable | Mac + dev box | none (http over loopback) | `127.0.0.1` | autossh + SSH key on Mac | Stopgap only: a second daemon to babysit, and a silent tunnel failure looks like "server down" |

### A. Tailscale `serve` (recommended)

A private WireGuard network. `tailscale serve` terminates HTTPS on the dev box with a real Let's Encrypt cert for `<host>.<tailnet>.ts.net` and proxies to the loopback port. Nothing is exposed to the LAN or the internet (`serve`, **not** `funnel`, which is public).

- Pros: works from office, home and hotel. End-to-end encrypted (Tailscale's coordination server never sees traffic). The server can bind `127.0.0.1`. Certs renew automatically.
- Cons / open questions:
  - **The work Mac may forbid it** (MDM, corporate VPN conflicts, policy). Check this first; it decides between A and B.
  - Unverified: whether `serve` sets `X-Forwarded-Proto: https`. Without it `isHttps()` is false and the session cookie loses its `Secure` flag. That's harmless over the tailnet, but check with `curl -v` and add the flag if needed.
  - Unverified: whether `serve` on :443 collides with Docker's DNAT of :443 to nginx (Docker's rule matches every local address, `tailscale0` included). If it does, use `--https=8443` and `https://<host>.<tailnet>.ts.net:8443`.
- Steps (dev box):
  1. Install Tailscale, run `sudo tailscale up`, and enable MagicDNS + HTTPS certificates in the admin console.
  2. Bind the server to `127.0.0.1` (see [Bind address](#bind-address-built)).
  3. Run `sudo tailscale serve --bg --https=443 http://127.0.0.1:4200`. The config persists across reboots in tailscaled state; check it with `tailscale serve status`.
- Steps (Mac): install Tailscale, log in to the same tailnet, then open `https://<host>.<tailnet>.ts.net/api/health`.

### B. Existing nginx, LAN-only hostname (fallback)

Add a vhost `pa.riuna.com` to `~/src/webserver/nginx/conf.d/`, using the wildcard cert that's already there. Resolve it to the LAN IP (DNS-only A record → `192.168.5.53`, or a local DNS override). Don't add a Cloudflare Tunnel route for it.

- Pros: nothing new to install on the work Mac. Real cert. TLS terminates on the dev box.
- Cons: uploads only happen on the home LAN. Some routers drop DNS answers that point at private IPs (DNS-rebind protection), in which case you need a local override. A public DNS record also reveals the internal IP (minor).
- Gotchas:
  - nginx runs in Docker, so it **can't reach `127.0.0.1` on the host**. The server must bind the docker0 address `172.17.0.1`, which is reachable from containers but not from the LAN (same trick as `laya.conf`). If Docker isn't up yet at boot, `listen` fails with `EADDRNOTAVAIL`; systemd's `Restart=always` retries until it's up.
  - **`client_max_body_size 25m;` is required.** nginx's default of 1 MB would reject long transcripts with 413.
  - Add a `geo` allowlist for `192.168.5.0/24` (like `openclaw-allowlist.conf`) so the vhost refuses non-LAN clients even if :443 is reachable from outside.
  - Set `X-Forwarded-Proto $scheme` (the other vhosts already do) so the session cookie gets `Secure`.
- Sketch:
  ```nginx
  geo $pa_allowed { default 0; 192.168.5.0/24 1; }
  server {
      listen 443 ssl http2;
      server_name pa.riuna.com;
      ssl_certificate     /etc/letsencrypt/live/riuna.com/fullchain.pem;
      ssl_certificate_key /etc/letsencrypt/live/riuna.com/privkey.pem;
      include /etc/nginx/conf.d/ssl-params.conf;
      client_max_body_size 25m;
      if ($pa_allowed = 0) { return 403; }
      location / {
          proxy_pass http://host.docker.internal:4200;
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto $scheme;
      }
  }
  ```
  Reload with `docker exec webserver_nginx nginx -s reload`.

### C. Cloudflare Tunnel (public), for later

This is option B plus a tunnel route. It would work from anywhere with no software on the Mac, but:
- Cloudflare decrypts every upload (work meeting content).
- Login/signup/pair would be on the internet. That first needs login rate limiting, and ideally signup off or behind Cloudflare Access for the web UI paths, leaving `/api/device/*` and `/api/devices/pair` open (bearer auth; Access can't be used by an unattended daemon without service-token headers in `pa`).

Revisit if A is impossible and home-LAN-only uploads turn out too slow in practice.

## Bind address (built)

- `config.json` `server.host` (default `127.0.0.1`) is passed to `server.listen(port, host)`. It must be an IP literal: a hostname like `localhost` could resolve to `::1` or `127.0.0.1`, which makes the bind ambiguous. `parseConfig` rejects hostnames and `[brackets]`.
  - `127.0.0.1`: SSH tunnel (current), option A, option E.
  - `172.17.0.1`: options B/C (nginx in Docker, via `host.docker.internal`).
  - `0.0.0.0`: explicit opt-in only; the server logs a warning at startup.
- Needs a restart. A running server that sees a changed host/port on config reload logs "restart to apply". If the address doesn't exist (yet), the server logs it and exits; systemd `Restart=always` retries, which covers docker0 not being up at boot.
- `isHttps()` trusts `X-Forwarded-Proto` from any client. That's fine now that only local proxies can connect, and nothing else trusts forwarded headers.
- Verified live (scratch server, 2026-09-26):
  - `127.0.0.1` answers on loopback but not on the LAN or docker0.
  - `172.17.0.1` answers only on docker0, and `webserver_nginx` reaches it via `host.docker.internal`.
  - `0.0.0.0` answers everywhere and logs the warning.
  - `localhost` fails config validation; `10.99.99.99` gives `EADDRNOTAVAIL` and exits.
- After deploying: `ss -ltn | grep 4200` must show `127.0.0.1:4200` (not `*:4200`). If you open the web UI from another machine over the LAN, that stops working; use a tunnel or proxy.

## Moving the Mac off the SSH tunnel

1. Restart the service so `server.host` takes effect (defaults to `127.0.0.1`), and verify with `ss` as above.
2. Set up option A (or B), then check from the Mac: `curl https://<server>/api/health`.
3. Re-pair: `pa pair https://<server> <account>`. A different server URL means a new token and a new device. Approve the code in the web UI, then `pa status`.
4. Revoke the old `localhost` device in the web UI (Devices).
5. Upload test: `pa transcribe --upload` on an existing capture.
6. Update `osx/CHECKLIST.md` step 4 and the `pa run` / `install.sh` docs with the permanent URL. The LaunchAgent itself needs nothing network-specific: the URL lives in app-support `config.json`, the token in the Keychain.

## Verification checklist

- [ ] `ss -ltn` shows the server on loopback (or docker0) only
- [ ] LAN host → `http://<devbox>:4200` refused
- [ ] Mac → `https://<server>/api/health` OK with no cert warning
- [ ] Web login over HTTPS → `Set-Cookie` has `Secure`
- [ ] Uploading a ~15 MB transcript succeeds (no 413 from the proxy)
- [ ] After a dev-box reboot, the Mac reaches the server again without manual steps
