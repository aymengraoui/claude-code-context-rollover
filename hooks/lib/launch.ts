/** Opening a command in a terminal of its own (copied from the Cockpit mod, so each mod stands alone). Pure: it only builds the commands. */

/** Windows paths start with a drive letter; that is enough to tell the platforms apart. */
export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:/.test(path)

/**
 * The commands to try, in order, to run `command` — `claude`, `claude --resume <id>` — in a
 * new terminal.
 *
 * Every entry is a plain argv, so nothing is shell-quoted and nothing is guessed about
 * the shell. The caller runs them until one exits cleanly, and copies the command to the
 * clipboard when none does — a terminal that is not there must not lose the click.
 */
export const launchCommands = (
  command: string,
  cwd: string,
  isWindows: boolean,
): readonly string[][] => {

  if (isWindows) {
    return [
      // Windows Terminal: a new tab in the window that is already open.
      ['wt.exe', '-w', '0', 'nt', '-d', cwd, 'powershell', '-NoExit', '-Command', command],
      // No Windows Terminal: a console window of its own.
      // `start /D` sets where it opens: a resumed session is found from its own directory.
      ['cmd.exe', '/c', 'start', '', '/D', cwd, 'cmd.exe', '/k', command],
    ]
  }

  return [
    // macOS: Terminal.app runs the command in a new window.
    ['osascript', '-e', `tell application "Terminal" to do script "cd ${cwd} && ${command}"`],
    // Linux: whatever the desktop nominated, then the usual suspects.
    ['x-terminal-emulator', '-e', 'sh', '-c', `cd ${cwd} && ${command}`],
    ['gnome-terminal', '--working-directory', cwd, '--', 'sh', '-c', command],
    ['konsole', '--workdir', cwd, '-e', 'sh', '-c', command],
  ]
}
