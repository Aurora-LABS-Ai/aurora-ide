/**
 * Agent Window — shell spawn configuration (adapter).
 *
 * Picks the executable, args and environment for a PTY session per platform and
 * profile, with the same polished prompt the IDE terminal uses (short path ·
 * shell version · OK/ERR status). Kept standalone in the agent window so we
 * don't import the IDE's terminal component (and its side effects).
 */

export type ShellProfile = "powershell" | "bash";

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

export function getShellSpawnConfig(
  profile: ShellProfile,
  platform: string,
): ShellSpawnConfig {
  if (profile === "bash") {
    if (platform === "windows") {
      return {
        exe: "C:\\Program Files\\Git\\bin\\bash.exe",
        args: ["--noprofile", "--norc", "-i"],
        env: buildBashEnv(),
      };
    }
    return { exe: "/bin/bash", args: ["--noprofile", "--norc", "-i"], env: buildBashEnv() };
  }

  if (platform === "windows") {
    return {
      exe: "pwsh.exe",
      args: ["-NoLogo", "-NoExit", "-Command", buildPowerShellInitCommand()],
    };
  }

  return { exe: "/bin/bash", args: ["--noprofile", "--norc", "-i"], env: buildBashEnv() };
}

/** Windows PowerShell 5 fallback when `pwsh.exe` (PS7) isn't installed. */
export function powershellFallbackConfig(): ShellSpawnConfig {
  return {
    exe: "powershell.exe",
    args: ["-NoLogo", "-NoExit", "-Command", buildPowerShellInitCommand()],
  };
}
