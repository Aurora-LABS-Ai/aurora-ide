//! Which parts of a workspace depend on which other parts.
//!
//! Everything else in `code_index` answers questions about one symbol. This
//! answers the question above it: how is the project actually wired, and where
//! does it depend on itself in a circle. That view only became possible once
//! imports carried their module specifier — before that the index knew a file
//! mentioned a name, not where the name came from.
//!
//! **Cycles are reported small or not at all.** A directory-level graph of a
//! real application collapses into one enormous mutually-dependent blob (168
//! directories, one cycle spanning ~70 of them — measured on a real Electron
//! app with another tool). "These 70 directories form a cycle" is not a finding
//! anyone can act on. A two-directory cycle is.

use super::store::CodeIndex;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Cycles longer than this are summarised by size instead of listed. Past a
/// handful of directories the reader cannot hold the loop in their head, and
/// the useful action ("break this edge") no longer has an obvious target.
const MAX_REPORTED_CYCLE: usize = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub name: String,
    /// How many other groups import from this one.
    pub fan_in: usize,
    /// How many other groups this one imports from.
    pub fan_out: usize,
    pub files: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cycle {
    pub members: Vec<String>,
    /// Set when the loop was too large to list — see `MAX_REPORTED_CYCLE`.
    pub summarized_size: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct ModuleGraph {
    pub nodes: Vec<Node>,
    /// `(from, to, edge count)` — how many distinct imports cross the boundary.
    pub edges: Vec<(String, String, usize)>,
    pub cycles: Vec<Cycle>,
}

/// How paths are collapsed into groups.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Granularity {
    /// One node per file.
    File,
    /// One node per directory — the orientation view.
    Dir,
    /// One node per TOP-LEVEL area under the root (`src/apps`, `src-tauri`).
    Area,
}

impl Granularity {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "file" => Some(Self::File),
            "dir" | "directory" => Some(Self::Dir),
            "area" | "module" => Some(Self::Area),
            _ => None,
        }
    }

    fn group_of<'a>(self, path: &'a str) -> &'a str {
        match self {
            Self::File => path,
            Self::Dir => match path.rfind('/') {
                Some(i) => &path[..i],
                None => ".",
            },
            // Two segments, so `src/apps` and `src/kernel` stay distinct while
            // `src/apps/agent/services/runtime` folds into `src/apps`. One
            // segment would put an entire `src/` tree in a single node.
            Self::Area => {
                let mut cut = None;
                for (i, c) in path.char_indices() {
                    if c == '/' {
                        if cut.is_some() {
                            return &path[..i];
                        }
                        cut = Some(i);
                    }
                }
                match cut {
                    Some(i) => &path[..i],
                    None => ".",
                }
            }
        }
    }
}

/// Build the dependency graph from the index's resolved imports.
pub fn build(idx: &CodeIndex, granularity: Granularity) -> ModuleGraph {
    // Distinct (from file, to file) pairs. An import repeated for five names
    // is one dependency, not five — counting names would make a barrel file
    // look like the most coupled thing in the repository.
    let mut file_edges: BTreeSet<(u32, u32)> = BTreeSet::new();
    for imp in &idx.imports {
        if let Some(target) = idx.resolve_module(imp.file, &imp.module) {
            if target != imp.file {
                file_edges.insert((imp.file, target));
            }
        }
    }

    let mut counts: BTreeMap<(String, String), usize> = BTreeMap::new();
    for (from, to) in &file_edges {
        let a = granularity.group_of(idx.file_path(*from)).to_string();
        let b = granularity.group_of(idx.file_path(*to)).to_string();
        if a == b {
            continue; // internal cohesion is not a dependency
        }
        *counts.entry((a, b)).or_default() += 1;
    }

    let mut files_per_group: BTreeMap<String, usize> = BTreeMap::new();
    for f in &idx.files {
        *files_per_group
            .entry(granularity.group_of(&f.path).to_string())
            .or_default() += 1;
    }

    let mut fan_in: HashMap<&str, usize> = HashMap::new();
    let mut fan_out: HashMap<&str, usize> = HashMap::new();
    for (from, to) in counts.keys() {
        *fan_out.entry(from.as_str()).or_default() += 1;
        *fan_in.entry(to.as_str()).or_default() += 1;
    }

    let mut nodes: Vec<Node> = files_per_group
        .iter()
        .map(|(name, files)| Node {
            name: name.clone(),
            fan_in: fan_in.get(name.as_str()).copied().unwrap_or(0),
            fan_out: fan_out.get(name.as_str()).copied().unwrap_or(0),
            files: *files,
        })
        .collect();
    // Most depended-upon first: that is the reading order for "what is load
    // bearing here".
    nodes.sort_by(|a, b| {
        b.fan_in
            .cmp(&a.fan_in)
            .then(b.fan_out.cmp(&a.fan_out))
            .then(a.name.cmp(&b.name))
    });

    let edges: Vec<(String, String, usize)> = counts
        .iter()
        .map(|((a, b), n)| (a.clone(), b.clone(), *n))
        .collect();
    let cycles = find_cycles(&counts);

    ModuleGraph {
        nodes,
        edges,
        cycles,
    }
}

/// Tarjan's strongly-connected components over the group graph.
///
/// Iterative rather than recursive: a file-granularity graph of a large
/// workspace is thousands of nodes deep in the worst case, and blowing the
/// stack inside a tool call would take the whole turn down.
fn find_cycles(counts: &BTreeMap<(String, String), usize>) -> Vec<Cycle> {
    let mut adjacency: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (from, to) in counts.keys() {
        adjacency
            .entry(from.as_str())
            .or_default()
            .push(to.as_str());
        adjacency.entry(to.as_str()).or_default();
    }

    let names: Vec<&str> = adjacency.keys().copied().collect();
    let index_of: HashMap<&str, usize> = names.iter().enumerate().map(|(i, n)| (*n, i)).collect();
    let neighbours: Vec<Vec<usize>> = names
        .iter()
        .map(|n| {
            adjacency[n]
                .iter()
                .filter_map(|t| index_of.get(t).copied())
                .collect()
        })
        .collect();

    let n = names.len();
    let mut index = vec![usize::MAX; n];
    let mut low = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut next_index = 0usize;
    let mut out: Vec<Cycle> = Vec::new();

    for root in 0..n {
        if index[root] != usize::MAX {
            continue;
        }
        // (node, position in its neighbour list)
        let mut work: Vec<(usize, usize)> = vec![(root, 0)];
        while let Some((v, pi)) = work.pop() {
            if pi == 0 {
                index[v] = next_index;
                low[v] = next_index;
                next_index += 1;
                stack.push(v);
                on_stack[v] = true;
            }
            let mut recursed = false;
            for (i, &w) in neighbours[v].iter().enumerate().skip(pi) {
                if index[w] == usize::MAX {
                    work.push((v, i + 1));
                    work.push((w, 0));
                    recursed = true;
                    break;
                } else if on_stack[w] {
                    low[v] = low[v].min(index[w]);
                }
            }
            if recursed {
                continue;
            }
            if low[v] == index[v] {
                let mut members = Vec::new();
                while let Some(w) = stack.pop() {
                    on_stack[w] = false;
                    members.push(names[w].to_string());
                    if w == v {
                        break;
                    }
                }
                if members.len() > 1 {
                    members.sort();
                    let size = members.len();
                    out.push(if size > MAX_REPORTED_CYCLE {
                        Cycle {
                            members: members.into_iter().take(MAX_REPORTED_CYCLE).collect(),
                            summarized_size: Some(size),
                        }
                    } else {
                        Cycle {
                            members,
                            summarized_size: None,
                        }
                    });
                }
            }
            if let Some(&(parent, _)) = work.last() {
                low[parent] = low[parent].min(low[v]);
            }
        }
    }

    // Smallest first — a two-node cycle is the one someone can actually fix.
    out.sort_by(|a, b| {
        a.members
            .len()
            .cmp(&b.members.len())
            .then(a.members.cmp(&b.members))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn build_index(files: &[(&str, &str)]) -> (tempfile::TempDir, CodeIndex) {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in files {
            let p = dir.path().join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        let idx = CodeIndex::build(dir.path()).unwrap();
        (dir, idx)
    }

    #[test]
    fn dependencies_roll_up_to_directories_with_fan_in_and_fan_out() {
        let (_d, idx) = build_index(&[
            ("src/core/engine.ts", "export class Engine {}\n"),
            (
                "src/ui/panel.ts",
                "import { Engine } from '../core/engine';\nexport const p = new Engine();\n",
            ),
            (
                "src/api/route.ts",
                "import { Engine } from '../core/engine';\nexport const r = new Engine();\n",
            ),
        ]);
        let g = build(&idx, Granularity::Dir);

        let core = g.nodes.iter().find(|n| n.name == "src/core").expect("core");
        assert_eq!(core.fan_in, 2, "two directories import it: {:?}", g.nodes);
        assert_eq!(core.fan_out, 0, "it imports nothing");
        let ui = g.nodes.iter().find(|n| n.name == "src/ui").unwrap();
        assert_eq!(ui.fan_out, 1);
        assert_eq!(
            g.nodes[0].name, "src/core",
            "most depended-upon reads first"
        );
    }

    /// The reported failure, reproduced at the layer that produced it: an
    /// Electron workspace wired entirely with `require()` came back from
    /// `modules` as `dependencies: 0` across eight directories, every one
    /// reporting `fanIn: 0, fanOut: 0`. The extractor read no CommonJS, so the
    /// graph had nothing to roll up.
    ///
    /// The file shapes below are the ones from that workspace: `gui` requires
    /// `../core/engine`, and `core` requires its own siblings.
    #[test]
    fn a_commonjs_project_is_wired_like_any_other() {
        let (_d, idx) = build_index(&[
            ("core/paths.js", "module.exports = { root: '/' };\n"),
            (
                "core/session.js",
                "const paths = require('./paths');\nclass Session {}\nmodule.exports = { Session };\n",
            ),
            (
                "core/engine.js",
                "const { Session } = require('./session');\nconst profiles = require('./profiles');\nclass Engine {}\nmodule.exports = { Engine };\n",
            ),
            ("core/profiles.js", "module.exports = {};\n"),
            (
                "gui/main.js",
                "const { Engine } = require('../core/engine');\nnew Engine();\n",
            ),
        ]);
        let g = build(&idx, Granularity::Dir);

        let core = g.nodes.iter().find(|n| n.name == "core").expect("core");
        assert!(
            core.fan_in > 0,
            "gui requires core, so core is depended upon: {:?}",
            g.nodes
        );
        let gui = g.nodes.iter().find(|n| n.name == "gui").expect("gui");
        assert_eq!(gui.fan_out, 1, "gui depends on core: {:?}", g.nodes);
        assert!(
            g.edges
                .iter()
                .any(|(from, to, _)| from == "gui" && to == "core"),
            "the gui -> core edge the report named is missing: {:?}",
            g.edges
        );
    }

    /// A Next.js workspace with no `src/` directory is wired like any other.
    ///
    /// `create-next-app` writes `"paths": { "@/*": ["./*"] }` when the sources
    /// sit at the project root, and the resolver guessed `src/*` — Aurora's own
    /// layout. Every import in such a project is `@/…`, so every edge was
    /// dropped and `code op:modules` answered `dependencies: 0` across all
    /// eight directories. That reads as "this code is not wired together"
    /// rather than as a miss, which is why it went unnoticed until a live run
    /// on 2026-09-04 questioned it out loud.
    ///
    /// The file shapes are that workspace's: `app/page.tsx` pulls in sections
    /// and the data layer, a section pulls in `lib` and `types`.
    #[test]
    fn a_next_project_rooted_without_src_is_wired_through_its_alias() {
        let (_d, idx) = build_index(&[
            ("types/index.ts", "export type Product = { id: string };\n"),
            ("lib/data.ts", "export const products = [];\n"),
            (
                "lib/data-access.ts",
                "import { products } from '@/lib/data';\nexport const all = () => products;\n",
            ),
            (
                "components/sections/hero.tsx",
                "import type { Product } from '@/types';\nexport const Hero = () => null;\n",
            ),
            (
                "app/page.tsx",
                "import { Hero } from '@/components/sections/hero';\n\
                 import { all } from '@/lib/data-access';\n\
                 export default function Page() { return null; }\n",
            ),
        ]);
        let g = build(&idx, Granularity::Dir);

        for (from, to) in [
            ("app", "components/sections"),
            ("app", "lib"),
            ("components/sections", "types"),
        ] {
            assert!(
                g.edges.iter().any(|(f, t, _)| f == from && t == to),
                "{from} -> {to} is missing; the `@/` alias resolved nowhere: {:?}",
                g.edges
            );
        }
    }

    /// The `src/*` reading still works — it is tried first, and a project that
    /// keeps its sources there must not start matching root-relative paths that
    /// happen to share a tail.
    #[test]
    fn an_alias_rooted_at_src_still_resolves_there() {
        let (_d, idx) = build_index(&[
            ("src/lib/data.ts", "export const products = [];\n"),
            (
                "src/app/page.tsx",
                "import { products } from '@/lib/data';\nexport default function P() { return null; }\n",
            ),
        ]);
        let g = build(&idx, Granularity::Dir);
        assert!(
            g.edges
                .iter()
                .any(|(f, t, _)| f == "src/app" && t == "src/lib"),
            "the src-rooted alias regressed: {:?}",
            g.edges
        );
    }

    #[test]
    fn side_effect_imports_are_dependencies_even_without_a_local_binding() {
        let (_d, idx) = build_index(&[
            ("src/core/setup.ts", "export const ready = true;\n"),
            (
                "src/app/main.ts",
                "import '../core/setup';\nexport const app = true;\n",
            ),
        ]);
        let g = build(&idx, Granularity::Dir);
        assert!(
            g.edges
                .iter()
                .any(|(from, to, count)| from == "src/app" && to == "src/core" && *count == 1),
            "a side-effect import must still create an edge: {:?}",
            g.edges
        );
    }

    #[test]
    fn dart_parts_are_one_library_not_a_dependency_cycle() {
        let (_dir, idx) = build_index(&[
            (
                "lib/library.dart",
                "library model.library;\npart 'post.dart';\n",
            ),
            ("lib/post.dart", "part of model.library;\nclass Post {}\n"),
            (
                "app/use.dart",
                "import '../lib/library.dart';\nPost? post;\n",
            ),
        ]);
        let graph = build(&idx, Granularity::File);

        assert!(
            graph.edges.iter().any(|(from, to, count)| {
                from == "app/use.dart" && to == "lib/library.dart" && *count == 1
            }),
            "the real library import remains visible: {:?}",
            graph.edges
        );
        assert!(
            graph.edges.iter().all(|(from, to, _)| {
                !(from == "lib/library.dart" && to == "lib/post.dart")
                    && !(from == "lib/post.dart" && to == "lib/library.dart")
            }),
            "part/part-of is membership, not a pair of module edges: {:?}",
            graph.edges
        );
        assert!(graph.cycles.is_empty(), "{:?}", graph.cycles);
    }

    #[test]
    fn a_two_directory_loop_is_reported_in_full() {
        let (_d, idx) = build_index(&[
            (
                "src/a/one.ts",
                "import { Two } from '../b/two';\nexport class One { go() { return Two; } }\n",
            ),
            (
                "src/b/two.ts",
                "import { One } from '../a/one';\nexport class Two { go() { return One; } }\n",
            ),
        ]);
        let g = build(&idx, Granularity::Dir);
        assert_eq!(g.cycles.len(), 1, "{:?}", g.cycles);
        assert_eq!(g.cycles[0].members, vec!["src/a", "src/b"]);
        assert!(
            g.cycles[0].summarized_size.is_none(),
            "small enough to list"
        );
    }

    #[test]
    fn a_huge_tangle_is_summarised_rather_than_listed() {
        // The failure this exists to avoid: a real application produced ONE
        // cycle spanning ~70 directories. Printing all of them is not a
        // finding, it is a wall of text that reads as "everything is broken".
        let mut files: Vec<(String, String)> = Vec::new();
        let n = 10;
        for i in 0..n {
            let next = (i + 1) % n;
            files.push((
                format!("src/d{i}/m.ts"),
                format!(
                    "import {{ S{next} }} from '../d{next}/m';\nexport class S{i} {{ go() {{ return S{next}; }} }}\n"
                ),
            ));
        }
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let (_d, idx) = build_index(&refs);

        let g = build(&idx, Granularity::Dir);
        let cycle = g.cycles.first().expect("a cycle");
        assert_eq!(cycle.summarized_size, Some(n), "{cycle:?}");
        assert!(
            cycle.members.len() <= MAX_REPORTED_CYCLE,
            "must not list all {n}: {cycle:?}"
        );
    }

    #[test]
    fn a_file_importing_five_names_from_one_module_is_one_dependency() {
        // Counting imported NAMES would rank barrel files as the most coupled
        // thing in a codebase, which is backwards — they are the least.
        let (_d, idx) = build_index(&[
            (
                "src/core/types.ts",
                "export type A = 1;\nexport type B = 2;\nexport type C = 3;\n",
            ),
            (
                "src/ui/use.ts",
                "import { A, B, C } from '../core/types';\nexport type U = A | B | C;\n",
            ),
        ]);
        let g = build(&idx, Granularity::Dir);
        let edge = g
            .edges
            .iter()
            .find(|(a, b, _)| a == "src/ui" && b == "src/core")
            .expect("the edge");
        assert_eq!(edge.2, 1, "one file-to-file dependency, not three names");
    }

    #[test]
    fn area_granularity_keeps_top_level_areas_apart() {
        let (_d, idx) = build_index(&[
            ("src/kernel/deep/nested/util.ts", "export function u() {}\n"),
            (
                "src/apps/agent/services/go.ts",
                "import { u } from '../../../kernel/deep/nested/util';\nexport const g = u;\n",
            ),
        ]);
        let g = build(&idx, Granularity::Area);
        let names: Vec<&str> = g.nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"src/kernel"), "{names:?}");
        assert!(names.contains(&"src/apps"), "{names:?}");
    }

    /// Measurement harness — see the sibling harnesses in `store`/`repo_map`.
    #[test]
    #[ignore = "needs AURORA_INDEX_ROOT pointing at a real workspace"]
    fn module_graph_over_a_real_workspace() {
        let root = std::env::var("AURORA_INDEX_ROOT").expect("set AURORA_INDEX_ROOT");
        let idx = CodeIndex::build(Path::new(&root)).unwrap();
        for g in [Granularity::Area, Granularity::Dir] {
            let graph = build(&idx, g);
            println!(
                "\n== {:?}: {} nodes, {} edges, {} cycle(s) ==",
                g,
                graph.nodes.len(),
                graph.edges.len(),
                graph.cycles.len()
            );
            for n in graph.nodes.iter().take(12) {
                println!(
                    "  in {:>4}  out {:>4}  {:>4} files  {}",
                    n.fan_in, n.fan_out, n.files, n.name
                );
            }
            for c in graph.cycles.iter().take(5) {
                match c.summarized_size {
                    Some(size) => println!("  cycle of {size}: {} …", c.members.join(" -> ")),
                    None => println!("  cycle: {}", c.members.join(" -> ")),
                }
            }
        }
    }
}
