use indexmap::{IndexMap, IndexSet};
use std::collections::{HashMap, HashSet, VecDeque};

use crate::functions::{CallReceiver, CallSite, FunctionAnalysis};
use crate::types::CallGraphMetrics;

pub struct CallGraphResult {
    pub fan_in_by_index: HashMap<usize, usize>,
    pub fan_out_by_index: HashMap<usize, usize>,
    pub recursive_indexes: HashSet<usize>,
    pub metrics: CallGraphMetrics,
}

pub fn measure_call_graph(
    analyses: &[FunctionAnalysis],
    language_name: &str,
    base_scopes_by_scope: &HashMap<String, Vec<String>>,
) -> CallGraphResult {
    let candidates_by_name = map_candidates_by_name(analyses);
    let mut fan_in_by_index: HashMap<usize, usize> = HashMap::new();
    let mut fan_out_by_index: HashMap<usize, usize> = HashMap::new();
    let mut graph: IndexMap<usize, IndexSet<usize>> = IndexMap::new();
    let mut call_count: u64 = 0;
    let mut all_callees: HashSet<&str> = HashSet::new();

    for analysis in analyses {
        call_count += analysis.call_count;
        for callee in &analysis.callees {
            all_callees.insert(callee);
        }

        let mut resolved_indexes: IndexSet<usize> = IndexSet::new();
        for site in &analysis.call_sites {
            if let Some(resolved) = resolve_call_site(
                site,
                analysis.scope_name.as_deref(),
                candidates_by_name.get(site.name.as_str()),
                language_name,
                base_scopes_by_scope,
            ) {
                resolved_indexes.insert(resolved);
            }
        }

        fan_out_by_index.insert(analysis.index, resolved_indexes.len());
        for callee_index in &resolved_indexes {
            *fan_in_by_index.entry(*callee_index).or_insert(0) += 1;
        }
        graph.insert(analysis.index, resolved_indexes);
    }

    let recursive_indexes = find_recursive_indexes(&graph);
    let internal_edge_count = graph.values().map(|callees| callees.len()).sum();
    let max_call_depth = measure_max_call_depth(&graph);

    CallGraphResult {
        metrics: CallGraphMetrics {
            call_count,
            unique_callee_count: all_callees.len(),
            // Occurrence-level internal call counts were removed as redundant/unactionable
            // (issue #22); internal_edge_count reports unique caller→callee edges.
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

struct CalleeCandidate<'a> {
    index: usize,
    callable_parameter_count: usize,
    callable_min_parameter_count: usize,
    unbounded_arity: bool,
    scope_name: Option<&'a str>,
}

fn map_candidates_by_name<'a>(
    analyses: &'a [FunctionAnalysis],
) -> HashMap<&'a str, Vec<CalleeCandidate<'a>>> {
    let mut candidates_by_name: HashMap<&str, Vec<CalleeCandidate<'_>>> = HashMap::new();
    for analysis in analyses {
        // Bodyless signatures stay in the function list for PMD-style aggregation, but they must
        // not make an implemented method's name ambiguous (an interface method and its
        // implementation share a name), which would drop the implementation's call-graph edges.
        if !analysis.has_implementation {
            continue;
        }
        // JS truthiness: a MISSING node yields an empty-string name, which is "no name" in TS.
        let Some(name) = analysis.name.as_deref().filter(|name| !name.is_empty()) else {
            continue;
        };
        candidates_by_name
            .entry(name)
            .or_default()
            .push(CalleeCandidate {
                index: analysis.index,
                callable_parameter_count: analysis.callable_parameter_count,
                callable_min_parameter_count: analysis.callable_min_parameter_count,
                unbounded_arity: analysis.unbounded_arity,
                scope_name: analysis.scope_name.as_deref(),
            });
    }
    candidates_by_name
}

/// Languages whose bare calls (`f()`) reach the enclosing class's methods, not only free functions.
const BARE_CALL_REACHES_METHODS_LANGUAGES: &[&str] = &["java", "ruby", "cpp"];

/// Resolves a call site to a function index; see resolveCallSite in metrics.ts (issue #19):
/// scope first (self-like calls search the caller's scope then its file-local base scopes,
/// nearest first), then arity (defaults widen the range only up to the declared count; only true
/// varargs accept unboundedly many).
fn resolve_call_site(
    site: &CallSite,
    caller_scope_name: Option<&str>,
    candidates: Option<&Vec<CalleeCandidate<'_>>>,
    language_name: &str,
    base_scopes_by_scope: &HashMap<String, Vec<String>>,
) -> Option<usize> {
    let candidates = candidates?;
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return candidates.first().map(|candidate| candidate.index);
    }

    let is_viable = |candidate: &CalleeCandidate<'_>| match site.argument_count {
        None => true,
        Some(argument_count) => {
            if candidate.unbounded_arity {
                argument_count >= candidate.callable_min_parameter_count
            } else {
                candidate.callable_min_parameter_count <= argument_count
                    && argument_count <= candidate.callable_parameter_count
            }
        }
    };

    let is_self_like_bare_call = site.receiver == CallReceiver::None
        && BARE_CALL_REACHES_METHODS_LANGUAGES.contains(&language_name)
        && caller_scope_name.is_some();
    if site.receiver == CallReceiver::SelfLike || is_self_like_bare_call {
        // Breadth-first over the caller's scope and its file-local base scopes: the nearest scope
        // with viable candidates decides, resolving only when it is unambiguous there.
        let mut saw_scoped_candidate = false;
        let mut visited_scopes: HashSet<Option<&str>> = HashSet::new();
        visited_scopes.insert(caller_scope_name);
        let mut scope_queue: VecDeque<Option<&str>> = VecDeque::new();
        scope_queue.push_back(caller_scope_name);
        while let Some(scope) = scope_queue.pop_front() {
            let in_scope: Vec<&CalleeCandidate<'_>> = candidates
                .iter()
                .filter(|candidate| candidate.scope_name == scope)
                .collect();
            if !in_scope.is_empty() {
                saw_scoped_candidate = true;
                let viable: Vec<&&CalleeCandidate<'_>> = in_scope
                    .iter()
                    .filter(|candidate| is_viable(candidate))
                    .collect();
                if !viable.is_empty() {
                    return if viable.len() == 1 {
                        viable.first().map(|candidate| candidate.index)
                    } else {
                        None
                    };
                }
            }
            if let Some(scope_name) = scope {
                for base in base_scopes_by_scope
                    .get(scope_name)
                    .map(|bases| bases.as_slice())
                    .unwrap_or_default()
                {
                    if visited_scopes.insert(Some(base.as_str())) {
                        scope_queue.push_back(Some(base.as_str()));
                    }
                }
            }
        }
        // A self call, or a bare call whose scope chain declares the name (committing the call to
        // the class even when no overload's arity fits), never falls back to free functions.
        if site.receiver == CallReceiver::SelfLike || saw_scoped_candidate {
            return None;
        }
    }

    let pool: Vec<&CalleeCandidate<'_>> = if site.receiver == CallReceiver::Other {
        candidates.iter().collect()
    } else {
        candidates
            .iter()
            .filter(|candidate| candidate.scope_name.is_none())
            .collect()
    };
    let viable: Vec<&&CalleeCandidate<'_>> = pool
        .iter()
        .filter(|candidate| is_viable(candidate))
        .collect();
    if viable.len() == 1 {
        viable.first().map(|candidate| candidate.index)
    } else {
        None
    }
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
