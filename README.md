# secret-vault

English | [繁體中文](README.zh-TW.md)

**Type an API key or password into Claude Code without the value ever reaching the model.**

When Claude needs a credential, it usually asks you to paste it into the chat, or prints `export API_KEY=...` for you to run somewhere else. `secret-vault` gives Claude a third way: it opens a masked input in your session, you type the value there, and Claude only hears back whether it was stored and where.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install secret-vault --marketplace allen-hsu/claude-code-secret-vault
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install secret-vault --marketplace allen-hsu/claude-code-secret-vault
```

## Use

- **Claude asks for it.** When a task needs a credential, Claude calls `mcp__secret-vault__request` with the variable name and a one-line hint, and the input opens. The bundled skill tells Claude to do this instead of asking you to paste the value.
- **You ask for it.** Type `/secret STRIPE_SECRET_KEY` to open the input yourself.

The input shows the value as dots, with its length. Pick where it goes, then press Enter to store it or Esc to cancel:

| Destination | Where the value lives | How Claude uses it |
| --- | --- | --- |
| `.env` file | `.env` in the session's working directory, quoted, one line per name | The program loads it by default, without the command naming the file (`docker compose` and `dotenv` both read `.env` in their directory) |
| This session | The Claude Code process's environment, until the session ends; nothing on disk | `$NAME` in a shell command; the shell expands it |
| Private store | The plugin's own store on this computer | No tool Claude has can read it |

"This session" works for the names in `ENV_ALLOWLIST` at the top of [`hooks/register.tsx`](hooks/register.tsx) (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `STRIPE_SECRET_KEY`). The plugin API only takes literal names there, so add a name to both that list and the `switch` below it. For any other name the option is not offered, and the input says why.

After it stores a value Claude asked for, the plugin tells Claude the outcome so it can carry on.

## What else it does

- **Blocks reading `.env`.** A Read, Edit, Write, Grep or Glob of a `.env` file is refused, and so is any shell command that names one, whatever the program (`cat`, `python`, `base64`, `source`...). Matching ignores case, since `.ENV` is the same file on macOS. That includes handing the file to a program with `--env-file .env`, because such programs can print what they load (`docker compose --env-file .env config` does). Templates (`.env.example`, `.env.sample`, `.env.template`) are allowed.
- **Takes plain variable names only.** A name must be letters, digits and underscores, not starting with a digit; anything else is refused before the input opens, so a name cannot write extra lines into `.env`.
- **Masks known values in tool output.** A value stored in this session, if it is 8 characters or longer, is replaced with `[secret-vault: 已遮蔽]` wherever it shows up in a tool's output, before Claude sees it.
- **Catches a paste into the wrong box.** While the secret input is open, anything you submit at the normal prompt is held back instead of being sent to Claude, and you are told to use the secret input. Slash commands still go through.

## Settings

`/config` has one row for this plugin, **輸入框位置** (input position):

| Value | Where the input opens | Typing |
| --- | --- | --- |
| `pane` (default) | A pane; in the fullscreen terminal it docks on the right | Starts in the input right away |
| `band` | A full-width bar just above the prompt | Click it or press `ctrl+x tab` first |

The pane asks for 80 columns. Claude Code decides the real width: at most 45% of the terminal, and a width you dragged it to wins. The layout follows whatever width it gets, stacking everything when narrow.

## What it does not protect against

This keeps secrets from slipping into the conversation by accident. It is not an encrypted vault, and it cannot stop a determined program:

- **`.env` is a plain text file.** Any program on your machine can read it.
- **The `.env` block matches the path as written.** A command that names the file is caught. One that reaches it without naming it (a symbolic link, a path assembled at run time, a script file that opens it) is not.
- **Masking is narrow.** It only replaces exact copies of a value, only values of 8 characters or more, and only values stored since Claude Code last started; the list of values to mask lives in memory.
- **Values stored for this session are environment variables.** A command such as `printenv` shows them. They are masked until Claude Code restarts, and not after.
- **The private store is not encrypted.** Claude's tools cannot reach it, but it is still data on your computer.

## How it works

One hooks module, [`hooks/register.tsx`](hooks/register.tsx):

- At session start it registers the `request` tool and the `/secret` command.
- The tool and the command open the input and return at once. The plugin never waits for you inside a hook, since hooks have a 10-second budget.
- A `ui.render` hook draws the input. Typed characters stay in the plugin's memory; the field only ever holds dots.
- A `tool.call` hook blocks `.env` reads and masks known values in every tool's result.
- A `prompt.submit` hook holds back the normal prompt while the input is open.

[`SKILL.md`](SKILL.md) is the skill that tells Claude when to use the tool.

## Develop

```
claude --plugin-dir .        # run a session with the plugin loaded from this folder
claude plugin validate .     # check the manifest and the hooks module
```

## License

MIT
