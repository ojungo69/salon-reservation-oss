# Input: {compare: main...HEAD, head: merge_base...HEAD, main: merge_base...main}.
def paths:
  [.files[] | .filename, .previous_filename? | select(. != null)];

try (
  . as $data
  | ($data.compare | paths) as $pr_paths
  | ($data.main | paths) as $main_paths
  | .compare.status == "diverged"
    and (.compare.total_commits | type == "number")
    and .compare.total_commits > 0 and .compare.total_commits <= 250
    and (.compare.files | type == "array" and length < 300)
    and (.main.files | type == "array" and length < 300)
    and (.head.total_commits == .compare.total_commits)
    and (.head.commits | type == "array")
    and (.head.commits | length) == .head.total_commits
    and all(.head.commits[];
      (.parents | type == "array" and length == 1)
      and .commit.verification.verified == true
      and .author.login == "dependabot[bot]" and .author.type == "Bot"
      and .commit.committer.name == "GitHub")
    and all($pr_paths[];
      . as $pr | all($main_paths[];
        . as $main | $pr != $main
        and (($pr | startswith($main + "/")) | not)
        and (($main | startswith($pr + "/")) | not)))
) catch false
