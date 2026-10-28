//! How loaded the machine the engine runs on is: CPU, memory, the main disk,
//! GPUs and the busiest processes. Read by the web version's machine card
//! (`components/shell/MachineCell.tsx`), which asks every 2 s while it is open,
//! so a browser on a server sees that server, not the computer it runs on.
//!
//! CPU usage is a difference between two readings, so one `System` is kept for
//! the life of the engine: each call refreshes it and the answer is the load
//! since the previous call. The first call after start reads 0%.

use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sysinfo::{Disks, ProcessesToUpdate, System};

/// How many processes the card lists.
const TOP_PROCESSES: usize = 5;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineStats {
    pub hostname: String,
    /// e.g. "Linux 24.04 Ubuntu".
    pub os: String,
    /// e.g. "aarch64".
    pub arch: String,
    pub cpu_model: String,
    pub cpu_cores: usize,
    /// 0–100, all cores together.
    pub cpu_percent: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    /// The disk the engine's data lives on (the root on Linux, the system
    /// drive on Windows). `None` when no disk could be read.
    pub disk: Option<DiskStats>,
    /// Empty when the machine has no GPU this can read (no `nvidia-smi`).
    pub gpus: Vec<GpuStats>,
    pub uptime_secs: u64,
    /// Busiest by memory, largest first.
    pub processes: Vec<ProcessStats>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub mount: String,
    pub used: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    pub name: String,
    /// 0–100.
    pub percent: f32,
    pub memory_used: u64,
    pub memory_total: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStats {
    pub name: String,
    /// One core = 100, so a busy process on 4 cores can read up to 400.
    pub cpu_percent: f32,
    pub memory: u64,
}

fn system() -> &'static Mutex<System> {
    static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();
    SYSTEM.get_or_init(|| Mutex::new(System::new()))
}

/// Read the machine now. Blocking (it reads /proc or the Windows counters and
/// may run `nvidia-smi`), so callers run it off the async threads.
pub fn read() -> Result<MachineStats, String> {
    let mut sys = system()
        .lock()
        .map_err(|_| "machine reader is poisoned".to_string())?;
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let cpu_model = sys
        .cpus()
        .first()
        .map(|cpu| cpu.brand().trim().to_string())
        .filter(|brand| !brand.is_empty())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let mut processes: Vec<ProcessStats> = sys
        .processes()
        .values()
        .map(|process| ProcessStats {
            name: process.name().to_string_lossy().into_owned(),
            cpu_percent: process.cpu_usage(),
            memory: process.memory(),
        })
        .collect();
    processes.sort_by(|a, b| b.memory.cmp(&a.memory));
    processes.truncate(TOP_PROCESSES);

    Ok(MachineStats {
        hostname: System::host_name().unwrap_or_else(|| "unknown".to_string()),
        os: System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
        arch: std::env::consts::ARCH.to_string(),
        cpu_model,
        cpu_cores: sys.cpus().len(),
        cpu_percent: sys.global_cpu_usage(),
        memory_used: sys.used_memory(),
        memory_total: sys.total_memory(),
        disk: main_disk(),
        gpus: read_gpus(),
        uptime_secs: System::uptime(),
        processes,
    })
}

/// The disk holding the engine's data folder: the mount point that is the
/// longest prefix of it.
fn main_disk() -> Option<DiskStats> {
    let disks = Disks::new_with_refreshed_list();
    let data = crate::paths::root();
    disks
        .list()
        .iter()
        .filter(|disk| data.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| DiskStats {
            mount: disk.mount_point().to_string_lossy().into_owned(),
            used: disk.total_space().saturating_sub(disk.available_space()),
            total: disk.total_space(),
        })
}

/// `nvidia-smi` without a console window flashing up on Windows.
fn nvidia_smi() -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new("nvidia-smi");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// NVIDIA GPUs through `nvidia-smi`, when it is installed. Whether it exists
/// is checked once; a machine without it never spawns anything.
fn read_gpus() -> Vec<GpuStats> {
    static PRESENT: OnceLock<bool> = OnceLock::new();
    let present = *PRESENT.get_or_init(|| {
        nvidia_smi()
            .arg("-L")
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    });
    if !present {
        return Vec::new();
    }
    match nvidia_smi()
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
    {
        Ok(out) if out.status.success() => parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout)),
        Ok(out) => {
            crate::logging::log_warn(
                "machine",
                &format!("nvidia-smi failed: {}", String::from_utf8_lossy(&out.stderr).trim()),
            );
            Vec::new()
        }
        Err(error) => {
            crate::logging::log_warn("machine", &format!("nvidia-smi could not run: {error}"));
            Vec::new()
        }
    }
}

/// One line per GPU: `name, util %, used MiB, total MiB`.
fn parse_nvidia_smi(text: &str) -> Vec<GpuStats> {
    const MIB: u64 = 1024 * 1024;
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            let [name, percent, used, total] = fields.as_slice() else {
                return None;
            };
            Some(GpuStats {
                name: (*name).to_string(),
                percent: percent.parse().ok()?,
                memory_used: used.parse::<u64>().ok()? * MIB,
                memory_total: total.parse::<u64>().ok()? * MIB,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_this_machine() {
        let stats = read().expect("machine stats");
        assert!(stats.cpu_cores > 0);
        assert!(stats.memory_total > 0);
        assert!(stats.memory_used <= stats.memory_total);
        assert!(stats.processes.len() <= TOP_PROCESSES);
        assert!(stats
            .processes
            .windows(2)
            .all(|pair| pair[0].memory >= pair[1].memory));
    }

    #[test]
    fn parses_nvidia_smi_lines_and_skips_bad_ones() {
        let gpus = parse_nvidia_smi(
            "NVIDIA GeForce RTX 4090, 41, 7372, 24564\n\
             garbage line\n\
             NVIDIA A100-SXM4-80GB, 0, 1, 81920\n",
        );
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 4090");
        assert_eq!(gpus[0].percent, 41.0);
        assert_eq!(gpus[0].memory_used, 7372 * 1024 * 1024);
        assert_eq!(gpus[1].memory_total, 81920 * 1024 * 1024);
    }
}
