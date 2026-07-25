/**
 * Agent Window — shell spawn configuration (adapter).
 *
 * Builds the executable, args and environment for a PTY session, with the same
 * polished prompt the IDE terminal uses (short path · shell version · OK/ERR
 * status). Kept standalone in the agent window so we don't import the IDE's
 * terminal component (and its side effects).
 *
 * ## Where the executable comes from
 *
 * From Rust's shell registry (`shell_interactive_config`), never from a literal
 * in this file. It used to hardcode `C:\Program Files\Git\bin\bash.exe` and a
 * bare `pwsh.exe`, so a user whose Git lived anywhere else got a terminal that
 * refused to start — while Settings → Shells sat next to it listing the
 * verified path it should have used. The registry also supplies the MSYS `PATH`
 * overlay that makes `ls`/`sed`/`uname` resolve inside Git Bash, which this file
 * never did.
 *
 * What stays here is presentation: the prompt initialisation. Rust returns the
 * interactive flags only and expects the caller to append its own — a
 * `-Command` string for PowerShell kinds, `PROMPT_COMMAND` in the environment
 * for POSIX ones.
 */

import { auroraInvoke } from "../../lib/runtime";

export type ShellProfile = "powershell" | "bash";

/** Shape returned by the Rust `shell_interactive_config` command. */
interface InteractiveShell {
  id: string;
  kind: string;
  label: string;
  exe: string;
  args: string[];
  env: Array<[string, string]>;
  isPosix: boolean;
}

export interface ShellSpawnConfig {
  exe: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

/** PowerShell init: a compact, color-aware prompt (path | pwshN | OK/ERR). */
function buildPowerShellInitCommand(): string {
  return [
    "$global:AuroraPromptVersion='1'",
    "function global:Aurora-ShortPath([string]$p,[int]$maxLen){",
    "  if(-not $p){ return '' }",
    "  if($maxLen -lt 20){ return (Split-Path -Leaf $p) }",
    "  $drive=''",
    "  $rest=$p",
    "  if($p -match '^[A-Za-z]:'){ $drive=$p.Substring(0,2); $rest=$p.Substring(2) }",
    "  $parts = ($rest -split '[\\\\/]+') | Where-Object { $_ -ne '' }",
    "  if($parts.Count -le 3){ return ($drive + '\\' + ($parts -join '\\')).TrimEnd('\\') }",
    "  $head = $parts[0]",
    "  $tail = ($parts | Select-Object -Last 2) -join '\\'",
    "  return ($drive + '\\' + $head + '\\...\\' + $tail).TrimEnd('\\')",
    "}",
    "function global:prompt{",
    "  $w=80; try{ $w=$Host.UI.RawUI.WindowSize.Width } catch {}",
    "  if($w -lt 40){ return '> ' }",
    "  $path=(Get-Location).Path",
    "  $short=Aurora-ShortPath $path ($w-28)",
    "  $ok= if($?){'OK'} else {'ERR'}",
    "  $ver= try{ $PSVersionTable.PSVersion.Major } catch { 0 }",
    "  $useColor=$false; try{ $useColor = [bool]$Host.UI.SupportsVirtualTerminal } catch {}",
    '  if(-not $useColor){ return "$short | pwsh$ver | $ok`n> " }',
    "  $esc=[char]27",
    '  $c="$esc[36m"; $y="$esc[33m"; $g="$esc[32m"; $r="$esc[31m"; $d="$esc[90m"; $x="$esc[0m"',
    "  $sc= if($ok -eq 'OK'){ $g } else { $r }",
    '  return "${c}${short}${x} ${d}|${x} ${y}pwsh${ver}${x} ${d}|${x} ${sc}${ok}${x}`n> "',
    "}",
    "try{ Set-PSReadLineOption -BellStyle None -ErrorAction SilentlyContinue } catch {}",
  ].join("; ");
}

/** Bash env: a matching color-aware PROMPT_COMMAND prompt. */
function buildBashEnv(): Record<string, string | undefined> {
  const promptCommand = [
    "__aurora_last=$?;",
    'if [ -z "$COLUMNS" ]; then __aurora_cols=80; else __aurora_cols=$COLUMNS; fi;',
    'if [ "$__aurora_cols" -lt 40 ]; then __aurora_min=1; else __aurora_min=0; fi;',
    "if command -v tput >/dev/null 2>&1; then __aurora_colors=$(tput colors 2>/dev/null || echo 0); else __aurora_colors=0; fi;",
    'if [ "$TERM" = "dumb" ] || [ -z "$TERM" ] || [ "$__aurora_colors" -lt 8 ]; then __aurora_color=0; else __aurora_color=1; fi;',
    'if [ "$__aurora_min" -eq 1 ]; then PS1="> "; else ',
    '  if [ "$__aurora_color" -eq 1 ]; then ',
    "    __a_c='\\[\\033[36m\\]'; __a_y='\\[\\033[33m\\]'; __a_g='\\[\\033[32m\\]'; __a_r='\\[\\033[31m\\]'; __a_d='\\[\\033[90m\\]'; __a_x='\\[\\033[0m\\]';",
    "  else __a_c=''; __a_y=''; __a_g=''; __a_r=''; __a_d=''; __a_x=''; fi;",
    '  if [ "$__aurora_last" -eq 0 ]; then __a_s="${__a_g}OK${__a_x}"; else __a_s="${__a_r}ERR${__a_x}"; fi;',
    '  PS1="${__a_c}\\w${__a_x} ${__a_d}|${__a_x} ${__a_y}bash${BASH_VERSINFO[0]}${__a_x} ${__a_d}|${__a_x} ${__a_s}\\n> ";',
    "fi",
  ].join(" ");

  return {
    TERM: "xterm-256color",
    PROMPT_DIRTRIM: "3",
    PROMPT_COMMAND: promptCommand,
  };
}

/**
 * Ask the registry for a verified shell, then attach Aurora's prompt.
 *
 * Returns `undefined` when nothing usable is registered — the caller reports
 * that rather than spawning a guess, because a guess is what produced the
 * "Couldn't start C:\Program Files\Git\bin\bash.exe" dead end.
 */
export async function getShellSpawnConfig(
  profile: ShellProfile,
): Promise<ShellSpawnConfig | undefined> {
  let resolved: InteractiveShell | null;
  try {
    resolved = await auroraInvoke<InteractiveShell | null>("shell_interactive_config", {
      requested: profile,
    });
  } catch {
    // A backend that cannot answer is the same situation as an empty registry:
    // we have no verified path, so we do not invent one.
    return undefined;
  }
  if (!resolved) return undefined;

  // The registry's own overlay first (the MSYS PATH that makes Git Bash's
  // userland reachable), then our prompt on top.
  const env: Record<string, string | undefined> = Object.fromEntries(resolved.env);

  if (resolved.isPosix) {
    return { exe: resolved.exe, args: resolved.args, env: { ...env, ...buildBashEnv() } };
  }

  // PowerShell kinds: `interactive_args` ends before `-Command` precisely so
  // the caller can append its initialisation here.
  return {
    exe: resolved.exe,
    args: [...resolved.args, "-Command", buildPowerShellInitCommand()],
    env: Object.keys(env).length > 0 ? env : undefined,
  };
}
