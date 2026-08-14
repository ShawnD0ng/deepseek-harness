import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/**
 * One interactive TUI conversation under a real PTY: type a prompt, watch the
 * mock reply stream into the alternate screen, then exit with /exit and
 * assert the terminal sequences restored the screen.
 */
const POSIX_TUI_PTY_DRIVER = String.raw`
import errno, fcntl, json, os, pty, select, struct, sys, termios, time
node, launch_args_json, launch_env_json, cwd, timeout_seconds = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(launch_args_json)], env)

# The fresh pty has no window size; give the TUI a real 100x30 grid.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

marker = b"tui pty reply marker"
output = bytearray()
deadline = time.monotonic() + float(timeout_seconds)
sent_prompt = False
sent_exit = False
status = None
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if chunk:
                output.extend(chunk)
        if not sent_prompt and b"\x1b[?1049h" in output and b"ask the agent" in output:
            os.write(fd, b"hi there\r")
            sent_prompt = True
        if sent_prompt and not sent_exit and marker in output:
            os.write(fd, b"/exit\r")
            sent_exit = True
        waited, candidate = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            status = candidate
            break
except BaseException as error:
    sys.stdout.buffer.write(output)
    sys.stderr.write(f"tui pty driver crashed: {error!r}\n")
    sys.exit(126)

if status is None:
    os.kill(pid, 9)
    _, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
if not sent_prompt:
    sys.stderr.write("tui pty: the TUI never showed its prompt\n")
    sys.exit(124)
if not sent_exit:
    sys.stderr.write("tui pty: the mock reply never arrived\n")
    sys.exit(124)
if os.waitstatus_to_exitcode(status) != 0:
    sys.stderr.write(f"tui pty: expected exit 0, got {os.waitstatus_to_exitcode(status)}\n")
    sys.exit(125)
`

async function runTuiPtySmoke(apiKey: string, baseURL: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-pty-'))
  try {
    const launch = resolveExampleLaunch({
      srcBin: dshBinScript,
      configArgs: ['tui'],
      tsconfigPath,
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        DEEPSEEK_API_KEY: apiKey,
        DEEPSEEK_BASE_URL: baseURL,
        DSH_TELEMETRY_DISABLED: '1',
        // The test runner may run under TERM=dumb; the TUI refuses that.
        TERM: 'xterm-256color',
      },
    })
    // The watch-only HMR fallback the launcher mounts needs the Node internal
    // ESM loader; --expose-internals supplies it without the platform-native
    // require-builtin binding, so the smoke runs on every POSIX host.
    launch.args.unshift('--expose-internals')
    const timeoutMs = 45_000
    const result = await execa('python3', [
      '-c',
      POSIX_TUI_PTY_DRIVER,
      launch.command,
      JSON.stringify(launch.args),
      JSON.stringify(launch.env),
      cwd,
      String(timeoutMs / 1_000),
    ], {
      stdin: 'ignore',
      timeout: timeoutMs + 10_000,
      killSignal: 'SIGKILL',
      reject: false,
      stripFinalNewline: false,
    })
    if (result.timedOut) {
      throw new Error(`dsh tui PTY driver did not exit. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    if (result.failed) {
      throw new Error(`dsh tui PTY driver exited ${String(result.exitCode)}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    return result.stdout
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32')('dsh tui (real Loader tree in a PTY)', () => {
  it('runs one interactive turn and restores the terminal on /exit', async () => {
    const apiKey = 'tui-pty-key'
    const server = await startMockLlmServer({
      sequence: ['success'],
      apiKey,
      successText: 'tui pty reply marker',
    })
    try {
      const output = await runTuiPtySmoke(apiKey, server.baseURL)
      expect(output).toContain('❯')
      expect(output).toContain('hi there')
      expect(output).toContain('tui pty reply marker')
      expect(output).toContain('\x1b[?1049h') // alternate screen entered
      expect(output).toContain('\x1b[1049l') // and left again on exit
      expect(output).not.toContain('dsh:')
      expect(server.requests.length).toBeGreaterThan(0)
      expect(JSON.stringify(server.requests.map(request => request.body))).toContain('hi there')
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
