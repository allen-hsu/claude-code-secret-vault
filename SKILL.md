---
name: secret-vault
description: Use when the user needs to supply a secret value — an API key, token, password, connection string, or any credential. Instead of writing a shell script for them to run elsewhere and paste into, call mcp__secret-vault__request so they can type it into a private dialog whose contents never reach you. Trigger phrases include "I need to set an API key", "where do I put my token", "set up credentials", "add the secret", or any moment you were about to print `export SOMETHING=...` for the user to fill in.
---

# secret-vault

Never ask the user to paste a credential into the conversation, and never hand
them a script to run in another terminal just to set one. Call the tool:

    mcp__secret-vault__request { name: "STRIPE_SECRET_KEY", hint: "for the checkout test" }

A dialog opens in their session. They type the value; it is masked on screen and
never enters your context. You receive only a sentence saying whether it was
stored and where.

The user can also open the dialog themselves with `/secret <NAME>`.

## After it is stored

You do not know the value and cannot read it back. Work with it by reference:

- Stored in `process env` — use `$NAME` in a Bash command; the shell expands it.
- Stored in `.env` — let the program load it by default, without naming the file
  in the command (`docker compose` and `dotenv` read `.env` in their directory).
  Any command that names `.env`, and any Read or Grep of it, is blocked.
- Stored in the plugin's private store — nothing you run can reach it.

If a secret value ever does appear in a tool's output, it is replaced with
`[secret-vault: 已遮蔽]` before you see it. Do not try to work around this.
