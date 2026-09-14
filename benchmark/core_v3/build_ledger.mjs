// One-off generator for ledger.json, run once, not part of any task.
// Commit SHAs and defect line/quote data pulled from `gh pr view`/`gh api
// .../comments` output on GroophyLifefor/heap-analysis (PRs 21-50, Phase B).

const commits = {
  21: {
    base: "531f98d69c1f7e261e1061d6c63d24c17507f269",
    commits: ["ed5a4004510b82ce79b8d8e363f2eb71986e831d"],
    merge: "7cd1941436197449ac74bccd815c7340853a5764",
  },
  22: {
    base: "7cd1941436197449ac74bccd815c7340853a5764",
    commits: [
      "408416c9f2349c9b1a9ac2f628b38486caac0bab",
      "8293c10ce4775d011d991a509e393581c36bd19b",
    ],
    merge: "02bb601ef3b05d4d8e93551d242246ab6901b143",
  },
  23: {
    base: "02bb601ef3b05d4d8e93551d242246ab6901b143",
    commits: ["785c04138e7053d166b496099a9b81da18132e2f"],
    merge: "c42b9abd97b5aa01c2705b1cbabf42bbfa0d02a1",
  },
  24: {
    base: "c42b9abd97b5aa01c2705b1cbabf42bbfa0d02a1",
    commits: [
      "ec8a6a3179f6843b30230438514e63048e4892e1",
      "cbbc3f9fa3c5e3f146ea88b88a5818275085e9b9",
    ],
    merge: "61f3e09259b25a9a46e9197874a1fb1a29c83584",
  },
  25: {
    base: "61f3e09259b25a9a46e9197874a1fb1a29c83584",
    commits: ["fd0036ab878491276111d9899b00c739348afe29"],
    merge: "5376b82bb25fe41870d61ab26e2630e5f8716d9a",
  },
  26: {
    base: "5376b82bb25fe41870d61ab26e2630e5f8716d9a",
    commits: [
      "6855ea3f8a08a395a42140199d94bb1464646e47",
      "56a004f3db845e73e8637f6ece56313a21838b8a",
    ],
    merge: "1ee9702f6176423241c0d92e3fcef6d9072fc38b",
  },
  27: {
    base: "1ee9702f6176423241c0d92e3fcef6d9072fc38b",
    commits: [
      "215124899f0fb68f59c4b68e3694ecbb0c88c12e",
      "2d3ffcd5710b4ccf2fa16734560c45bcc631e1e1",
    ],
    merge: "bf3b8560f28d8dc7cf127f39ee63f8b694cc8735",
  },
  28: {
    base: "bf3b8560f28d8dc7cf127f39ee63f8b694cc8735",
    commits: ["d03aca79f41128a87aef9f131d7fc4708ca16e5b"],
    merge: "223f1b24f331b6f185e467b28842b9ed547572e8",
  },
  29: {
    base: "223f1b24f331b6f185e467b28842b9ed547572e8",
    commits: ["1d60a3ffbb94bbe0726e367f98ecaf8ca44bba87"],
    merge: "7a8a4ac0c47f42cd4c4ca4ce9478862acdf57588",
  },
  30: {
    base: "7a8a4ac0c47f42cd4c4ca4ce9478862acdf57588",
    commits: [
      "a9ca9880d7fa1150631671e5fa7fe3bd3c13ff15",
      "71f1510772b833d74d42e3c537fd496dc59e75e1",
    ],
    merge: "1cdf350bc19e4e3c387713189bf0172869638930",
  },
  31: {
    base: "1cdf350bc19e4e3c387713189bf0172869638930",
    commits: ["acea06e48aa3f17067baa5f029ee7840dad9022e"],
    merge: "2e1de1f8b8f45463061f2e1c3a7c31fe09fa9e9d",
  },
  32: {
    base: "2e1de1f8b8f45463061f2e1c3a7c31fe09fa9e9d",
    commits: ["97f1de336d464de5536955608225bc2e87f70158"],
    merge: "a7f55f9081497e83ad622b88a06e590f3d1b3e26",
  },
  33: {
    base: "a7f55f9081497e83ad622b88a06e590f3d1b3e26",
    commits: [
      "c17e0fa1736b3eecddafe0b69fd30d07a61efcce",
      "97b03589b56c15c812918f7179d20e93ccee2c03",
    ],
    merge: "163eaf31826564a58f45a6c68f31994644cebcf2",
  },
  34: {
    base: "163eaf31826564a58f45a6c68f31994644cebcf2",
    commits: [
      "9a05e778f1ba0ce7e9ac5de41a7b92b9bbb1fd16",
      "44f0c370bc01def1d08644ce5d304f9e3efa8794",
    ],
    merge: "30a847a9d91707f83c88d95c7613d88099c27f6c",
  },
  35: {
    base: "30a847a9d91707f83c88d95c7613d88099c27f6c",
    commits: [
      "048c85b67934cb1b5c746b2c13371bf3a846f487",
      "6494170f62d999f02625fd982b2b65ba077fb043",
    ],
    merge: "eeb8599ea854c4096d305e5df6d2b3167eeebe41",
  },
  36: {
    base: "eeb8599ea854c4096d305e5df6d2b3167eeebe41",
    commits: [
      "f371db33a7e872de12d0ec5fcd1ab709658ea87d",
      "eaf9cdd278c5a6c7ba46627c7ea71285ac9088a5",
    ],
    merge: "36233d0e1dda49e23473a2793ed47b7c5c52de60",
  },
  37: {
    base: "36233d0e1dda49e23473a2793ed47b7c5c52de60",
    commits: [
      "29254b5615e3fde3f765feb7a51e4fc1d9bf904d",
      "1db66d12f752653d019cfc9ad6ec313142bb9707",
    ],
    merge: "990c7d7633c89c096651790774fe84ef7830e7ce",
  },
  38: {
    base: "990c7d7633c89c096651790774fe84ef7830e7ce",
    commits: ["facdd6f8e2196320d00901bb89b08c18f5591ec7"],
    merge: "dcd9bfdbd03a80e31b99e15a6afc3186a52f96d1",
  },
  39: {
    base: "dcd9bfdbd03a80e31b99e15a6afc3186a52f96d1",
    commits: ["7e045bc205b69c2c27767ebc6ffa9d7e748338e1"],
    merge: "0d0e34d4f4aef3065dc167782f95bb30ca497991",
  },
  40: {
    base: "0d0e34d4f4aef3065dc167782f95bb30ca497991",
    commits: [
      "7c099e6c43b1668f9b59642f88776aeebbbb9146",
      "ba4b6d8b985f3227cedffbb0a4e6b25d7ae73de3",
    ],
    merge: "f11e361445f8d1bc9696404a9cefd14e771d24e4",
  },
  41: {
    base: "f11e361445f8d1bc9696404a9cefd14e771d24e4",
    commits: ["9edf2b6849e8845f1f3b02c8451007114249d9b7"],
    merge: "3432d1c818b357eef3b9154498e7275f9dc58c99",
  },
  42: {
    base: "3432d1c818b357eef3b9154498e7275f9dc58c99",
    commits: ["a28cb2b1969994d01359022d62b917e59718fe7a"],
    merge: "f9a71b9fbd98d27a21240f0867b6b12813cd9e49",
  },
  43: {
    base: "f9a71b9fbd98d27a21240f0867b6b12813cd9e49",
    commits: [
      "1b3476e3c1725c1d9d08b961c672b7ed614ea408",
      "e4cfc4825bf4133062e0e44485edd54d3373d869",
    ],
    merge: "04e814868dca47750d879a8d6aee1e490fe9ec8f",
  },
  44: {
    base: "04e814868dca47750d879a8d6aee1e490fe9ec8f",
    commits: ["9ccba2837a085603a2b7df13aa1af49672227283"],
    merge: "15524b019f4731d048c058c3717313f0de2dcbe0",
  },
  45: {
    base: "15524b019f4731d048c058c3717313f0de2dcbe0",
    commits: ["c247500413c6604b3cee4e28bdb20ecc16d29702"],
    merge: "f9ce05360d4f73713aeca405cee7dbfe30ac849f",
  },
  46: {
    base: "daa838ddc00bb142188e51e7bfa043799e8b6dde",
    commits: ["5258f34c5ad2572be282fc9a0f9ae6bdadecaa07"],
    merge: "71cd48f8ba2fadbc3c9de7733479d4c7e2523eb6",
  },
  47: {
    base: "71cd48f8ba2fadbc3c9de7733479d4c7e2523eb6",
    commits: [
      "f93026ff388bcd2e7177d11680c60c808106b31c",
      "d1fb57c51a7404dc68c03b6509620f68a3ef8db5",
    ],
    merge: "bfc733de4138b99f188ba25491c3e4af0d781c34",
  },
  48: {
    base: "bfc733de4138b99f188ba25491c3e4af0d781c34",
    commits: [
      "773439d9cd17440ca372714e6db48b7bfaf0317f",
      "e12e7d88ead2555d270d99d2add2405c3ad788f0",
    ],
    merge: "10ddfecb6b12258e243dac007ab0e0a9cc6fa5cb",
  },
  49: {
    base: "92f1ca745a494b4f07fff83c9bfc63ce2b4641cf",
    commits: [
      "c03f154d20ed5c18166ab8917b37c620edc4a050",
      "e5c7f8be8c85a32a776a5d04d9764b33a4d4e9fe",
    ],
    merge: "cc76c284c99e06e1d7535d416c5e3171d35554f9",
  },
  50: {
    base: "cc76c284c99e06e1d7535d416c5e3171d35554f9",
    commits: ["b1819acd0b566a62cef789ce2f75c0edfeb761f7"],
    merge: "6a6db9f4b6830a1312ae7e9037aaaa1468d4171a",
  },
};

const defects = {
  22: {
    id: "D7",
    path: "src/graph/dominator.js",
    line: 41,
    axis: "repo_wide",
    class: "predecessor/successor confusion",
    quote:
      "the predecessor list is filled with snapshot.edgesOf(b) (b's outgoing edges, successors) instead of snapshot.referrersOf(b) (b's incoming edges, real predecessors)",
    why:
      "silently, no crash or hang: every non-root idom stays unset (-1) since the wrong list is consulted; on the tiny fixture idom comes out [0,-1,-1] instead of [0,0,1]",
  },
  24: {
    id: "D8",
    path: "src/graph/dominator_children.js",
    line: 47,
    axis: "diff_local",
    class: "off-by-one bounds check",
    quote:
      "the bounds check uses `i > count` instead of `i >= count`, so the index one past the last valid child is accepted instead of rejected",
    why:
      "childAt(children, 0, count) silently returns a real-looking but wrong nodeIndex (reads into the next node's own children slice) instead of throwing",
  },
  26: {
    id: "D9",
    path: "src/report/retained_by_constructor.js",
    line: 18,
    axis: "convention",
    class: "byte/KB unit mixup",
    quote:
      "totalRetained is accumulated as `Math.round(retained[nodeIndex] / 1024)` (KB) instead of raw bytes, violating CONTRIBUTING.md #3",
    why:
      "any object retaining under ~512 bytes (most small objects) rounds straight to 0, so it silently disappears from the report as totalRetained: 0",
  },
  27: {
    id: "D10",
    path: "src/graph/gc_path.js",
    line: 41,
    axis: "diff_local",
    class: "reversed output order",
    quote:
      "the path array is built walking from nodeIndex back to root and never reversed, so it comes out node-first/root-last, contradicting its own doc comment",
    why:
      "shortestPathToRoot(snap, 2) on the tiny fixture returns [2, 1, 0] instead of the documented [0, 1, 2] -- every caller reads the retain chain backwards",
  },
  30: {
    id: "D12",
    path: "src/graph/find_by_class_name.js",
    line: 10,
    axis: "file_local",
    class: "substring match instead of exact",
    quote:
      "className.includes(filter) is used for matching instead of an exact === comparison",
    why:
      'a search for "User" also matches "UserSession", "UserCache", and any other class containing it as a substring, confirmed against a real snapshot',
  },
  33: {
    id: "D13",
    path: "src/report/duplicate_strings.js",
    line: 14,
    axis: "file_local",
    class: "incomplete type coverage",
    quote:
      "only nodes with `type === 'string'` are counted, `concatenated string` and `sliced string` node types are never matched",
    why:
      "on a real snapshot, concatenated string nodes outnumbered plain string nodes (24568 vs 20035) -- the majority of duplicate-string mass is silently missed while the tool still looks correct for what it does count",
  },
  34: {
    id: "D14",
    path: "src/report/collection_waste.js",
    line: 41,
    axis: "diff_local",
    class: "wrong field / unit mismatch",
    quote:
      "usedBytes is read directly as the backing store's edgeCount (a slot/edge tally) instead of summing selfSize over its edges (bytes)",
    why:
      "compares a count against a byte figure -- for a Set of small integers (no edges at all) edgeCount is always 0, so wastedBytes always equals the full capacityBytes regardless of how full the Set actually is",
  },
  36: {
    id: "D15",
    path: "src/snapshot.js",
    line: 206,
    axis: "repo_wide",
    class: "raw offset used as array index",
    quote:
      "the raw to_node value (a nodeOffset, CONTRIBUTING.md #2) is used directly as the subscript into a nodeCount-long Int32Array, without dividing by nodeStride first",
    why:
      "Int32Array silently drops an out-of-bounds write (no error, no growth) -- almost every real write is lost, so contextRetainerCountOf always reports 0 no matter how many closures actually share a context",
  },
  37: {
    id: "D16",
    path: "src/diff/align_snapshots.js",
    line: 18,
    axis: "repo_wide",
    class: "wrong alignment key",
    quote:
      "nodes from `before` and `after` are matched by shared nodeIndex position instead of by idOf() (the stable id)",
    why:
      "nodeIndex is only an ordinal position within one snapshot's own nodes array and means nothing across two separate captures -- hand traced against a fixture where two nodes swap position with no real add/remove: it reports 3 correct-looking matches, one of which actually points at the wrong object",
  },
  40: {
    id: "D17",
    path: "src/diff/growth.js",
    line: 16,
    axis: "diff_local",
    class: "divide by zero",
    quote:
      "growthRatio is computed as sizeDelta / sizeBefore with no check for sizeBefore === 0",
    why:
      "a brand new class has sizeBefore: 0, so growthRatio is Infinity, which sorts it to the very top ahead of real growth and becomes JSON null through JSON.stringify for exactly the case (a new class) the feature exists to highlight",
  },
  43: {
    id: "D18",
    path: "src/report/with_display_size.js",
    line: 6,
    axis: "convention",
    class: "formatting in the library layer",
    quote:
      'withDisplaySize (in src/report/, the library) is called by both CLI commands before branching on --json, so it replaces the raw byte field with a formatted string like "64 bytes" unconditionally',
    why:
      "--json output silently becomes a string instead of a number, breaking any machine consumer that needs to sort or sum the value without re-parsing the unit suffix, violating CONTRIBUTING.md #3",
  },
  47: {
    id: "D19",
    path: "src/policy/evaluate_policy.js",
    line: 73,
    axis: "history",
    class: "swallowed error",
    quote:
      "the catch block around each rule's evaluation is empty, so a rule that throws (unknown type, missing params) is silently dropped instead of being pushed to ruleErrors as the function's own doc comment promises",
    why:
      "a policy-authoring typo (e.g. a rule missing a required param) makes that rule vanish with zero coverage, returning {violations: [], ruleErrors: []} -- indistinguishable from a genuinely clean, fully-checked snapshot; this is the exact D6/history pattern (this repo does not swallow errors) recurring in a new place",
  },
  48: {
    id: "D20",
    path: "src/policy/gate.js",
    line: 18,
    axis: "diff_local",
    class: "off-by-one threshold comparison",
    quote:
      "violations are filtered with `SEVERITY_RANK[v.severity] > threshold` instead of `>= threshold`",
    why:
      'since "error" is already the highest severity rank, `--fail-on=error` can never fail the gate no matter how many error violations exist -- a CI gate that silently never gates on its strictest setting',
  },
  49: {
    id: "D21",
    path: "src/mcp/tools.js",
    line: 62,
    axis: "repo_wide",
    class: "schema/return type mismatch",
    quote:
      "the top_instances tool's outputSchema declares retainedSize as `{ type: 'string' }`, but its handler (topInstancesByRetainedSize) returns a real number",
    why:
      "any MCP client that validates structuredContent against the tool's own declared outputSchema (per the 2025-06-18 spec) rejects or mis-renders every response from this tool; the sibling summary tool's schema gets the same kind of field right, which is what makes this one easy to miss",
  },
};

const rows = [];
for (let pr = 21; pr <= 50; pr++) {
  const c = commits[pr];
  const d = defects[pr];
  const isControl = !d;
  const headCommit = c.commits[0];
  const fixCommit = c.commits.length > 1 ? c.commits[1] : null;

  rows.push({
    repo: "GroophyLifefor/heap-analysis",
    pr,
    is_control: isControl,
    base_commit: c.base,
    head_commit: headCommit,
    fix_commit: fixCommit,
    merge_commit: c.merge,
    ref_before: "1970-01-01T00:00:00Z",
    defects: isControl ? [] : [
      {
        id: d.id,
        path: d.path,
        from_line: d.line,
        to_line: d.line,
        side: "RIGHT",
        axis: d.axis,
        class: d.class,
        quote: d.quote,
        why: d.why,
      },
    ],
  });
}

console.log(JSON.stringify({ rows }, null, 2));
