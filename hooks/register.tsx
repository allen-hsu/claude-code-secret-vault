import type { Register } from 'claude-code'

/* ────────────────────────────────────────────────────────────────
   secret-vault — 在 Claude Code 裡私下輸入機密，值不進模型 context

   兩條鐵律（都是踩過才知道的）：
   1. hook 的預算是寫死的 10 秒（HookBudget.ms），而且等自己的 Promise
      時時鐘不會停 —— 只有等 next() 或等 $ 呼叫才會停。所以「等使用者
      打字」永遠不能發生在 hook 裡：開視窗、立刻回傳。
   2. $.ui.focus 偷不到鍵盤。唯一能在開啟時就拿到鍵盤的是
      $.ui.open({ focus: true })，也就是 Pane。
   ──────────────────────────────────────────────────────────────── */

/** 'pane' = 自動聚焦，但全螢幕寬視窗下會靠右停靠。
 *  'band' = 永遠貼在 prompt 正上方，但你得先按 ctrl+x tab 或點一下才能打字。
 *  由設定 `position` 決定（/config 裡的「輸入框位置」），每次載入時讀一次。 */
let SITE: 'pane' | 'band' = 'pane'

/** $.env.set 的名稱必須是「字串字面量」（載入前的靜態掃描會查）。
 *  想讓某個變數能注入 process env，就同時加進這裡和下面的 switch。 */
const ENV_ALLOWLIST = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'STRIPE_SECRET_KEY',
] as const

async function setProcessEnv($: any, name: string, value: string): Promise<boolean> {
  switch (name) {
    case 'OPENAI_API_KEY':     await $.env.set('OPENAI_API_KEY', value);     return true
    case 'ANTHROPIC_API_KEY':  await $.env.set('ANTHROPIC_API_KEY', value);  return true
    case 'GITHUB_TOKEN':       await $.env.set('GITHUB_TOKEN', value);       return true
    case 'STRIPE_SECRET_KEY':  await $.env.set('STRIPE_SECRET_KEY', value);  return true
    default: return false
  }
}

const PANE = 'secret-vault'
const ENV_FILE = '.env'
const MASK = '•'
/** 比這短的值不遮蔽，免得短字串在輸出裡到處誤傷。 */
const REDACT_MIN = 8

type Dest = 'env-file' | 'process-env' | 'store'

/** 選項名稱短，說明另外畫在選單下面（窄的停靠視窗裡一行放不下兩者）。 */
const DESTS: { value: Dest; label: string; detail: string }[] = [
  { value: 'env-file',    label: `${ENV_FILE} 檔`,     detail: '寫進專案目錄，永久保存' },
  { value: 'process-env', label: '本次 session', detail: '只放在記憶體，關掉就消失，不寫磁碟' },
  { value: 'store',       label: '私有保管庫',   detail: 'Claude 的任何工具都讀不到' },
]

/** 遮罩最多畫幾顆點。再長就停在這裡，字數另外標，免得撐爆版面。 */
const DOTS_MAX = 24
const maskOf = (len: number) => MASK.repeat(Math.min(len, DOTS_MAX))

type Pending = {
  name: string
  hint: string
  dest: Dest
  buf: string
  /** 由模型的工具呼叫開啟的 → 存好之後自動把它叫回來繼續。 */
  resumeModel: boolean
}

/** 待輸入的那一筆。同時只會有一個。 */
let pending: Pending | null = null

/** 已知的機密值，用來從工具輸出裡遮蔽。只存在記憶體。 */
const known = new Set<string>()

/* ─── 儲存 ───────────────────────────────────────────────────── */

async function writeEnvFile($: any, cwd: string, name: string, value: string) {
  const path = `${cwd}/${ENV_FILE}`
  let lines: string[] = []
  if (await $.fs.exists(path)) {
    const text: string = await $.fs.read(path)
    lines = text.split('\n')
  }
  const quoted = `${name}='${value.replace(/'/g, `'\\''`)}'`
  const at = lines.findIndex((l) => l.trimStart().startsWith(`${name}=`))
  if (at >= 0) lines[at] = quoted
  else {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    lines.push(quoted)
  }
  await $.fs.write(path, `${lines.join('\n')}\n`)
  return path
}

async function store($: any, p: Pending): Promise<string> {
  const value = p.buf
  if (value.length >= REDACT_MIN) known.add(value)

  if (p.dest === 'process-env') {
    const ok = await setProcessEnv($, p.name, value)
    if (!ok) {
      return `${p.name} 不在 ENV_ALLOWLIST 裡，沒有寫入 process env（$.env.set 的名稱必須是字面量）。改選 ${ENV_FILE}，或把它加進 hooks/register.tsx 的 ENV_ALLOWLIST。`
    }
    return `${p.name} 已設進 process env（只在這個 session 有效，磁碟上不留痕）。`
  }

  if (p.dest === 'store') {
    await $.store.set(`secret:${p.name}`, value)
    return `${p.name} 已存進 secret-vault 的私有 store。Claude 沒有任何工具能讀到它。`
  }

  const cwd: string = await $.session.cwd()
  const path = await writeEnvFile($, cwd, p.name, value)
  const home = await $.env.get('HOME')
  const odd = home !== undefined && cwd === home ? '  ⚠ 這是你的家目錄，多半不是你要的位置。' : ''
  return `${p.name} 已寫入 ${path}。讀取該檔的工具呼叫會被這個 mod 擋下。${odd}`
}

/* ─── 遮蔽 ───────────────────────────────────────────────────── */

function scrub(node: unknown): { value: unknown; hit: boolean } {
  let hit = false
  const walk = (n: unknown): unknown => {
    if (typeof n === 'string') {
      let out = n
      for (const secret of known) {
        if (out.includes(secret)) {
          out = out.split(secret).join('[secret-vault: 已遮蔽]')
          hit = true
        }
      }
      return out
    }
    if (Array.isArray(n)) return n.map(walk)
    if (n && typeof n === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(n)) out[k] = walk(v)
      return out
    }
    return n
  }
  return { value: walk(node), hit }
}

/** 指令裡的 `.env` 看起來像不像一個「檔案路徑」。
 *
 *  前面刻意不收 `$`，否則 `$.env.get('HOME')` 這種程式碼會被誤判成讀檔
 *  —— 這不是假想，是寫這個 mod 時真的被自己擋下來過一次。 */
const ENV_PATH = /(?:^|[\s"'`(=:;|&<>])(?:[~.\w/-]*\/)?\.env(?:\.[\w-]+)?(?=$|[\s"'`)\];|&<>])/gi

/** 只放假值的範本檔（.env.example、.env.sample、.env.template）不含機密，不擋。 */
const ENV_TEMPLATE = /\.env\.(example|sample|template)$/i

/** 把 .env 交給程式自己讀的寫法（`--env-file .env`、`env_file: .env`）：
 *  值不會印出來，README 也建議這樣用，所以不算「提到」。 */
const ENV_HANDOFF = /(--env-file[=\s]+|env_file:\s*)(?:[~.\w/-]*\/)?\.env(?:\.[\w-]+)?/gi

/** 指令裡有沒有提到「不是範本」的 .env 路徑（不分大小寫：macOS 的檔案系統
 *  預設不分，`.ENV` 就是 `.env`）。 */
function mentionsSecretEnvPath(command: string): boolean {
  const cmd = command.replace(ENV_HANDOFF, ' ')
  for (const m of cmd.matchAll(ENV_PATH)) {
    const path = m[0].replace(/^[\s"'`(=:;|&]/, '')
    if (!ENV_TEMPLATE.test(path)) return true
  }
  return false
}

/** 拿掉 heredoc 的內文（只留 `<<EOF` 那一行）。內文是要寫出去的文字，
 *  例如 PR 說明裡提到 .env.local，不是在讀檔；重導向的目標還在第一行，照樣會檢查。 */
function withoutHeredocBodies(cmd: string): string {
  return cmd.replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)[\s\S]*?\n[\t ]*\3(?=\n|$)/g, '$1')
}

/** 這個工具呼叫是不是在摸 .env？ */
function touchesEnvFile(tool: string, input: any): boolean {
  const asText = (v: unknown) => (typeof v === 'string' ? v : '')
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const file = asText(input?.file_path)
    return /(^|\/)\.env(\.|$)/i.test(file) && !ENV_TEMPLATE.test(file)
  }
  if (tool === 'Bash') {
    // 不管是哪個程式：提到就擋。只擋 cat、grep 這類名單，python、base64、
    // source 一換就繞過了。
    return mentionsSecretEnvPath(withoutHeredocBodies(asText(input?.command)))
  }
  if (tool === 'Grep' || tool === 'Glob') {
    return /\.env/i.test(asText(input?.path)) || /\.env/i.test(asText(input?.glob)) || /\.env/i.test(asText(input?.pattern))
  }
  return false
}

/* ─── 開視窗（不等待！） ─────────────────────────────────────── */

/** 名稱來自模型或使用者，會原樣寫進 .env 的一行：只收一般的變數名稱，
 *  否則名稱裡的換行或 `=` 就能替 .env 多寫出別的行。 */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function openPrompt($: any, name: string, hint: string, resumeModel: boolean): string {
  if (!NAME.test(name)) {
    return `「${name.slice(0, 40)}」不是有效的變數名稱：只能用英文字母、數字和底線，而且不能以數字開頭。沒有開啟輸入視窗。`
  }
  if (pending) return `已經有一個機密輸入視窗開著（${pending.name}），請先完成或取消它。`
  pending = { name, hint, dest: 'env-file', buf: '', resumeModel }
  if (SITE === 'pane') {
    $.ui.open({
      id: PANE,
      title: `secret · ${name}`,
      focus: true,
      closeOnEscape: true,
      holdToasts: true,
      rows: 10,
      // 停靠時最寬只給終端機的 45%；要大一點，窄版面才不用每次都拖。
      columns: 80,
    }).catch(() => { pending = null })   // -p / headless 沒有畫面可開
  } else {
    $.ui.invalidate('ui.render')
  }
  return SITE === 'pane'
    ? `已開啟 ${name} 的輸入視窗。`
    : `已在輸入框上方開啟 ${name} 的輸入列：先點一下它（或按 ctrl+x tab）再輸入。`
}

async function finish($: any, p: Pending) {
  let outcome: string
  try {
    outcome = await store($, p)
  } catch (err) {
    outcome = `儲存失敗：${err instanceof Error ? err.message : String(err)}`
  }
  pending = null
  if (SITE === 'pane') await $.ui.close({ id: PANE })
  else $.ui.invalidate('ui.render')
  $.ui.toast(outcome, { timeoutMs: 6000 })
  // 對話流裡的永久紀錄：toast 幾秒就沒了，這行留著。
  // $.ui.log 畫成系統通知，而且「not sent to the model」—— 你看得到，模型看不到。
  $.ui.log(`secret-vault · ${outcome}`)
  if (p.resumeModel) $.prompt.submit({ text: `[secret-vault] ${outcome} 請接著做剛才被中斷的事。` }).catch(() => {})
}

function cancel($: any, p: Pending) {
  pending = null
  if (SITE === 'band') $.ui.invalidate('ui.render')
  $.ui.toast(`已取消 ${p.name}，沒有任何值被儲存。`)
  $.ui.log(`secret-vault · 已取消 ${p.name}，沒有任何值被儲存。`)
  if (p.resumeModel) $.prompt.submit({ text: `[secret-vault] 我取消了 ${p.name} 的輸入。別再問一次，改用不需要它的做法，或等我主動給。` }).catch(() => {})
}

/* ─── 註冊 ───────────────────────────────────────────────────── */

export const register: Register = (on, options) => {
  SITE = options.position === 'band' ? 'band' : 'pane'

  /* 1 ─ 開場：宣告模型可呼叫的工具，以及你手動用的 /secret */
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'request',
      description:
        'Ask the human to privately type a secret (API key, token, password) into a dialog. ' +
        'Use this INSTEAD of printing a shell script for them to run elsewhere. ' +
        'Returns immediately: the human types at their own pace and a new message will tell you the outcome. ' +
        'The value itself is never returned to you.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The variable name, e.g. STRIPE_SECRET_KEY' },
          hint: { type: 'string', description: 'One line telling the human what this is for' },
        },
        required: ['name'],
      },
    })
    await $.command.register({
      name: 'secret',
      description: '私下輸入一個機密值，不進模型 context',
      argumentHint: '<NAME>',
    })
    return next(e)
  })

  /* 2 ─ 模型呼叫工具 → 開視窗 → 立刻回傳（絕不 await 使用者） */
  on('tool.call', { tool: 'mcp__secret-vault__request' }, ($, e) => {
    const input = e as any
    const name = String(input.name ?? '').trim() || 'SECRET'
    const opened = openPrompt($, name, String(input.hint ?? ''), true)
    return {
      result:
        `${opened} 現在停下來，不要追問這個值。使用者輸入完之後你會收到一則新訊息告訴你結果。` +
        `在那之前不要嘗試讀取、猜測或要求這個機密。`,
    }
  })

  /* 3 ─ /secret NAME */
  on('command.run', { command: 'secret' }, ($, e) => {
    const name = String((e as any).args ?? '').trim() || 'SECRET'
    return { text: openPrompt($, name, '', false) }
  })

  /* 4 ─ 視窗本體 */
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (SITE !== 'pane' || e.surface === 'mobile' || !pending) return next(e)
    return body($, e, pending, await placeOf($))
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (SITE !== 'band' || !pending || (e.props as any).hasSurvey) return next(e)
    return body($, e, pending, await placeOf($))
  })

  /* 4b ─ 保險：機密輸入還開著時，一般輸入框送出的內容一律攔下。
         輸入列沒拿到鍵盤時（band 本來就不會自動拿到；pane 的 focus 也可能被拒），
         貼上的值會落進一般輸入框 —— 這裡確保它按了 Enter 也不會送給模型。
         斜線指令照常放行（/secret、/config 這類不是機密）。 */
  on('prompt.submit', ($, e, next) => {
    const input = e as any
    if (!pending || input.origin !== undefined || String(input.text ?? '').trimStart().startsWith('/')) return next(e)
    return {
      drop: `secret-vault：${pending.name} 的機密輸入列還開著，剛才這段已攔下、沒有送給模型。請點上方的 🔒 輸入列再輸入，或取消它。`,
    }
  })

  /* 5 ─ 使用者按 Esc 關掉 pane */
  on('ui.close', { id: PANE }, ($, e, next) => {
    if (pending) cancel($, pending)
    return next(e)
  })

  /* 6 ─ 守門：擋住讀 .env，並從工具輸出裡遮蔽已知的機密
         （同一個事件只能有一個無 matcher 的 hook，所以兩件事合在這裡） */
  on('tool.call', async ($, e, next) => {
    if (touchesEnvFile(e.tool, e as any)) {
      return { deny: `secret-vault 擋下了對 ${ENV_FILE} 的讀取。需要值的話，直接在指令裡用環境變數引用它。` }
    }
    const r: any = await next(e)
    if (!r || r.deny !== undefined || known.size === 0) return r
    const { value, hit } = scrub(r.result)
    if (!hit) return r
    // 丟掉 core 的 ref：留著它 core 會照原文重建訊息，遮蔽就白做了
    return { result: value, context: r.context }
  })
}

/* ─── 畫面 ───────────────────────────────────────────────────── */

/** .env 會寫到哪裡，畫面上要寫出來；在家目錄時要警告。 */
async function placeOf($: any): Promise<{ envPath: string; isHome: boolean }> {
  const cwd: string = await $.session.cwd()
  const home: string | undefined = await $.env.get('HOME')
  const short = home !== undefined && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  return { envPath: `${short === '' ? '~' : short}/${ENV_FILE}`, isHome: home !== undefined && cwd === home }
}

/** 視窗寬度不由我們決定：停靠在右側時最寬只有終端機的 45%，使用者拖過的寬度
 *  還會蓋掉 open 時要的 columns。所以版面跟著實際寬度走：窄就全部直排、換行，
 *  寬才讓欄位名稱和內容並排。 */
const WIDE = 44

function body($: any, e: any, p: Pending, place: { envPath: string; isHome: boolean }) {
  const { Box, Text, Input, Select, Button } = $.ui.resolve(e)
  const width: number = e.props?.bodyColumns ?? e.viewport?.columns ?? 64
  const isWide = width >= WIDE
  const n = p.buf.length
  const weak = n > 0 && n < REDACT_MIN

  // process env 只能寫允許清單裡的名稱：不能用就不列，而且先說，不要等打完才失敗。
  const canEnv = (ENV_ALLOWLIST as readonly string[]).includes(p.name)
  const options = DESTS.filter((d) => d.value !== 'process-env' || canEnv)
  const dest = options.some((d) => d.value === p.dest) ? p.dest : 'env-file'
  const chosen = DESTS.find((d) => d.value === dest) ?? DESTS[0]
  const detail = dest === 'env-file' ? `${place.envPath}，永久保存` : (chosen?.detail ?? '')

  const count =
    n === 0 ? (
      <Text dimColor>貼上或輸入</Text>
    ) : weak ? (
      <Text color="warning">{`${n} 字元 · 太短，輸出裡不會被遮蔽`}</Text>
    ) : (
      <Text dimColor>{`${n} 字元`}</Text>
    )

  const field = (label: string, content: any) =>
    isWide ? (
      <Box flexDirection="row" columnGap={1}>
        <Box width={5} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>{content}</Box>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text dimColor>{label}</Text>
        {content}
      </Box>
    )

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      rowGap={SITE === 'band' ? 0 : 1}
      {...(SITE === 'band' ? { borderStyle: 'round', borderColor: 'claude' } : {})}
    >
      <Box flexDirection="column">
        <Text bold color="claude" wrap="wrap">{`🔒 ${p.name}`}</Text>
        {p.hint !== '' ? <Text wrap="wrap">{p.hint}</Text> : undefined}
      </Box>

      {field(
        '值',
        <Box flexDirection="column">
          <Input
            key="value"
            value={maskOf(p.buf.length)}
            placeholder="貼上或輸入"
            submitLabel="儲存"
            autoFocus
            onInput={(v: string) => {
              const q = pending
              if (!q) return
              const mask = maskOf(q.buf.length)
              if (v.length > mask.length && v.startsWith(mask)) {
                q.buf += v.slice(mask.length)
              } else if (v.length < mask.length) {
                // 按「少了幾顆點」刪，而不是截到 v.length ——
                // 遮罩截斷後兩者會不一樣，截到 v.length 會把長值砍掉。
                q.buf = q.buf.slice(0, q.buf.length - (mask.length - v.length))
              } else if (v !== mask) {
                q.buf = v
              }
              $.ui.invalidate('ui.render')
            }}
            onSubmit={() => {
              const q = pending
              if (!q) return
              if (q.buf.length === 0) { $.ui.toast('還沒輸入任何內容'); return }
              q.dest = dest
              void finish($, q)
            }}
          />
          {n > 0 ? count : undefined}
        </Box>,
      )}

      {field(
        '存到',
        <Box flexDirection="column">
          <Select
            key="dest"
            value={dest}
            options={options.map((d) => ({ value: d.value, label: d.label }))}
            onSelect={(v: string) => {
              if (pending) pending.dest = v as Dest
              $.ui.invalidate('ui.render')
            }}
          />
          <Text dimColor wrap="wrap">{detail}</Text>
          {dest === 'env-file' && place.isHome ? (
            <Text color="warning" wrap="wrap">⚠ 現在在家目錄，多半不是你要的專案</Text>
          ) : undefined}
          {canEnv ? undefined : (
            <Text dimColor wrap="wrap">{`「本次 session」只支援 ${ENV_ALLOWLIST.join('、')}`}</Text>
          )}
        </Box>,
      )}

      {/* 提示只寫真的會動的鍵：輸入框有焦點時，可列印的鍵都被它吃掉；
          Esc 會關掉視窗（open 時設了 closeOnEscape），等於取消。 */}
      {SITE === 'band' ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text color="claude" wrap="wrap">▶ 先點這一列或按 ctrl+x tab 再輸入</Text>
          <Text wrap="wrap">
            <Text bold>Enter</Text>
            <Text dimColor> 儲存</Text>
          </Text>
          <Button key="cancel" plain dimColor onPress={() => { if (pending) cancel($, pending) }}>取消</Button>
          <Text dimColor wrap="wrap">這個值不會傳給模型</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text wrap="wrap">
            <Text bold>Enter</Text>
            <Text dimColor> 儲存 · </Text>
            <Text bold>Esc</Text>
            <Text dimColor> 取消</Text>
          </Text>
          <Text dimColor wrap="wrap">這個值不會傳給模型</Text>
        </Box>
      )}
    </Box>
  )
}
