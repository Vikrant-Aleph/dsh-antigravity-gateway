# Antigravity Gateway

Use Google Antigravity models (Claude, Gemini, GPT-OSS) in DeepSeek Harness
through the Antigravity client wire protocol. Self-contained Google OAuth;
no Antigravity installation required.

## Why this gateway

The server's model catalog differs per account (plan, region, rollout).
This gateway follows your account's own live catalog and applies no
client-side retirement gate, so the offering matches what your account can
actually use in Antigravity. It coexists with `dsh-antigravity-auth`
(distinct provider routes) and can import its signed-in account read-only.

## Usage

1. Open **Settings → Antigravity Gateway** and click **Sign in with Google**
   (PKCE, loopback callback on 127.0.0.1:51121). Or click **Import from
   antigravity-auth** to reuse an existing dsh-antigravity-auth account
   (read-only import). Commands `/agw login` / `/agw import` work too.
2. Pick a model under the **Antigravity Gateway** provider, e.g.
   `claude-sonnet-5-5` (low/medium/high thinking efforts).
3. The **Models** tab checks availability against your account: it shows the
   plan tier, remaining quota (5-hour / weekly), available models, and
   unavailable ones with the upstream reason; only available models appear
   in the DSH picker. The **Account** tab shows login state; `/agw status`
   and `/agw models` do the same from the composer.

Models: Claude Opus/Sonnet 4.6 (Thinking) and 5.5, Gemini 3.8 Flash and
Gemini 4 Neon/Hydrogen/Carbon/Argon (incl. XHigh), GPT-OSS 120B Medium.
Routes with an announced removal carry a warning badge.

## Diagnostics

The `antigravity_gateway_log` tool reads/manages the plugin log
(read/stat/level/clear). Logs are bounded, rotated oldest-first, and
scrubbed of credentials and message content.

## Limitations

- Unofficial and experimental; Google may restrict accounts using
  third-party Antigravity clients. Personal use only.
- Text output only — no image generation, search grounding, or video.
- Account controls require a local Host (no WebServer, or bound to
  127.0.0.1); other binds fail closed.
- Model availability and limits follow the account's backend; pinned limits
  are community-capture observations.
- Coexists with dsh-antigravity-auth (distinct provider routes).
