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

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

/**
 * Which shell a terminal session runs.
 *
 * These are the registry's own kind ids (`src-tauri/src/shell/kinds.rs`), so
 * anything Settings → Tools › Shells lists can be opened here. It used to be
 * `"powershell" | "bash"` — two literals — which is why the terminal could only
 * ever open Windows PowerShell 5.1 or Git Bash, however many shells the scan
 * had found. `"powershell"` in particular meant PowerShell 7 back when 5.1 was
 * not registered; once the scan started finding 5.1 the same request silently
 * began resolving to it.
 */
export type ShellProfile = "pwsh" | "powershell" | "bash" | "zsh" | "sh" | "cmd";

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

/**
 * PowerShell init: a compact, color-aware prompt (path | pwshN | OK/ERR) —
 * installed ONLY if the user's own profile did not define one.
 *
 * This runs after `$PROFILE`, so defining `prompt` unconditionally overwrote
 * whatever the user had set — oh-my-posh, starship, a hand-written theme — and
 * every Aurora terminal looked like Aurora rather than like their shell. A
 * terminal emulator hosts a shell; it does not impersonate one.
 *
 * The test is the stock definition: PowerShell's built-in prompt is the one
 * containing `PS $($executionContext...`. If that is what is installed, nobody
 * has expressed a preference and Aurora's is an improvement on it. If it is
 * anything else, it is the user's and we leave it alone.
 */
function buildPowerShellInitCommand(): string {
  return [
    "$global:AuroraPromptVersion='2'",
    "$global:AuroraStockPrompt=$false",
    "try{",
    "  $__p=(Get-Command prompt -ErrorAction SilentlyContinue).Definition",
    "  $global:AuroraStockPrompt = [string]::IsNullOrWhiteSpace($__p) -or $__p -match 'executionContext\\.SessionState\\.Path\\.CurrentLocation'",
    "} catch { $global:AuroraStockPrompt=$true }",
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
    "if($global:AuroraStockPrompt){",
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
    "}",
    "try{ Set-PSReadLineOption -BellStyle None -ErrorAction SilentlyContinue } catch {}",
  ].join("; ");
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
    // No prompt injection. bash and zsh read their own rc files, so the user's
    // PS1 is already there — overwriting it with `PROMPT_COMMAND` was the same
    // costume the PowerShell prompt wore. TERM is not decoration: without it a
    // shell cannot know it is talking to an xterm.
    return {
      exe: resolved.exe,
      args: resolved.args,
      env: { TERM: "xterm-256color", ...env },
    };
  }

  // `cmd.exe` takes NO initialisation. It was falling into the PowerShell
  // branch below purely because `isPosix` is false for it, so every Command
  // Prompt session was launched as
  //   cmd.exe -Command "$global:AuroraPromptVersion='2'; function global:prompt{…}"
  // which cmd cannot parse — it printed its usage error and exited instantly,
  // leaving a terminal that swallowed every keystroke.
  if (resolved.kind === "cmd") {
    return {
      exe: resolved.exe,
      args: resolved.args,
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }

  // PowerShell kinds: `interactive_args` ends before `-Command` precisely so
  // the caller can append its initialisation here.
  return {
    exe: resolved.exe,
    args: [...resolved.args, "-Command", buildPowerShellInitCommand()],
    env: Object.keys(env).length > 0 ? env : undefined,
  };
}
