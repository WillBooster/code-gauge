use indexmap::{IndexMap, IndexSet};
use std::collections::{HashMap, HashSet};

use crate::functions::FunctionAnalysis;
use crate::types::CallGraphMetrics;

pub struct CallGraphResult {
    pub fan_in_by_index: HashMap<usize, usize>,
    pub fan_out_by_index: HashMap<usize, usize>,
    pub recursive_indexes: HashSet<usize>,
    pub metrics: CallGraphMetrics,
}

pub fn measure_call_graph(analyses: &[FunctionAnalysis]) -> CallGraphResult {
    let indexes_by_name = map_unique_function_indexes_by_name(analyses);
    let mut fan_in_by_index: HashMap<usize, usize> = HashMap::new();
    let mut fan_out_by_index: HashMap<usize, usize> = HashMap::new();
    let mut graph: IndexMap<usize, IndexSet<usize>> = IndexMap::new();
    let mut call_count: u64 = 0;
    let mut internal_call_count: usize = 0;
    let mut all_callees: HashSet<&str> = HashSet::new();

    for analysis in analyses {
        call_count += analysis.call_count;
        for callee in &analysis.callees {
            all_callees.insert(callee);
        }

        let internal_callee_names: Vec<&String> = analysis
            .callees
            .iter()
            .filter(|callee| indexes_by_name.contains_key(callee.as_str()))
            .collect();
        let mut internal_callee_indexes: IndexSet<usize> = IndexSet::new();
        for callee in &internal_callee_names {
            if let Some(callee_index) = indexes_by_name.get(callee.as_str()).copied() {
                internal_callee_indexes.insert(callee_index);
            }
        }

        fan_out_by_index.insert(analysis.index, internal_callee_names.len());
        internal_call_count += internal_callee_names.len();
        for callee_index in &internal_callee_indexes {
            *fan_in_by_index.entry(*callee_index).or_insert(0) += 1;
        }
        graph.insert(analysis.index, internal_callee_indexes);
    }

    let recursive_indexes = find_recursive_indexes(&graph);
    let internal_edge_count = graph.values().map(|callees| callees.len()).sum();
    let max_call_depth = measure_max_call_depth(&graph);

    CallGraphResult {
        metrics: CallGraphMetrics {
            call_count,
            unique_callee_count: all_callees.len(),
            internal_call_count,
            internal_edge_count,
            recursive_function_count: recursive_indexes.len(),
            max_fan_in: fan_in_by_index.values().copied().max().unwrap_or(0),
            max_fan_out: fan_out_by_index.values().copied().max().unwrap_or(0),
            max_call_depth,
        },
        fan_in_by_index,
        fan_out_by_index,
        recursive_indexes,
    }
}

/// Names mapping to exactly one function; ambiguous (repeated) names are dropped entirely, so
/// they neither resolve to an index nor count toward fan-out, matching the filtered TS map.
fn map_unique_function_indexes_by_name(analyses: &[FunctionAnalysis]) -> HashMap<&str, usize> {
    let mut indexes_by_name: HashMap<&str, Option<usize>> = HashMap::new();
    for analysis in analyses {
        // JS truthiness: a MISSING node yields an empty-string name, which is "no name" in TS.
        let Some(name) = analysis.name.as_deref().filter(|name| !name.is_empty()) else {
            continue;
        };

        match indexes_by_name.get_mut(name) {
            Some(existing) => *existing = None,
            None => {
                indexes_by_name.insert(name, Some(analysis.index));
            }
        }
    }
    indexes_by_name
        .into_iter()
        .filter_map(|(name, index)| index.map(|index| (name, index)))
        .collect()
}

fn find_recursive_indexes(graph: &IndexMap<usize, IndexSet<usize>>) -> HashSet<usize> {
    let mut recursive_indexes = HashSet::new();

    for index in graph.keys() {
        if can_reach(*index, *index, graph, &mut HashSet::new()) {
            recursive_indexes.insert(*index);
        }
    }

    recursive_indexes
}

fn can_reach(
    start: usize,
    target: usize,
    graph: &IndexMap<usize, IndexSet<usize>>,
    visited: &mut HashSet<usize>,
) -> bool {
    let Some(callees) = graph.get(&start) else {
        return false;
    };

    for callee in callees {
        if *callee == target {
            return true;
        }

        if visited.insert(*callee) && can_reach(*callee, target, graph, visited) {
            return true;
        }
    }

    false
}

fn measure_max_call_depth(graph: &IndexMap<usize, IndexSet<usize>>) -> usize {
    let mut depth_by_index: HashMap<usize, usize> = HashMap::new();
    let mut max_depth = 0;
    for index in graph.keys() {
        let (depth, _) =
            measure_call_depth(*index, graph, &mut HashSet::new(), &mut depth_by_index);
        max_depth = max_depth.max(depth);
    }
    max_depth
}

/// Longest-path DFS with memoization; results computed under an on-stack cycle cut are valid only
/// for that path, so tainted results are not memoized (see measureCallDepth in metrics.ts).
fn measure_call_depth(
    index: usize,
    graph: &IndexMap<usize, IndexSet<usize>>,
    path_indexes: &mut HashSet<usize>,
    depth_by_index: &mut HashMap<usize, usize>,
) -> (usize, bool) {
    if let Some(memoized) = depth_by_index.get(&index) {
        return (*memoized, false);
    }
    let Some(callees) = graph.get(&index) else {
        return (0, false);
    };
    if callees.is_empty() {
        return (0, false);
    }
    if path_indexes.contains(&index) {
        return (0, true);
    }

    path_indexes.insert(index);
    let mut max_depth = 0;
    let mut tainted = false;
    for callee in callees {
        let (depth, callee_tainted) =
            measure_call_depth(*callee, graph, path_indexes, depth_by_index);
        max_depth = max_depth.max(1 + depth);
        tainted = tainted || callee_tainted;
    }
    path_indexes.remove(&index);
    if !tainted {
        depth_by_index.insert(index, max_depth);
    }
    (max_depth, tainted)
}
